import { actorOf, type Actor, type AssistantPrincipal } from "./principal.js";
import { hasScope } from "./scopes.js";
import { toToolSpec, type ToolRegistry } from "./tools.js";
import {
  ProviderError,
  type ContentBlock,
  type Message,
  type ModelProvider,
  type StopReason,
  type Usage,
} from "./types.js";

export interface RunLimits {
  /** Most model turns in one run. Default 8. */
  maxTurns?: number;
  /** Most input plus output tokens, summed over all turns. */
  maxTotalTokens?: number;
  /** Most estimated cost in US dollars. Needs `pricing` on the provider. */
  maxCostUsd?: number;
  /** Output token ceiling for one turn. Default 4096. */
  maxOutputTokensPerTurn?: number;
}

export interface RunOptions {
  provider: ModelProvider;
  registry: ToolRegistry;
  principal: AssistantPrincipal;
  /** The conversation so far, ending with the new user message. */
  messages: readonly Message[];
  system?: string;
  limits?: RunLimits;
  signal?: AbortSignal;
  now?: () => number;
}

export type DoneReason =
  | "end_turn"
  | "max_tokens"
  | "refusal"
  | "provider_stop"
  | "max_turns"
  | "token_cap"
  | "cost_cap"
  | "principal_inactive"
  | "aborted";

export type DeniedReason = "unknown_tool" | "scope" | "invalid_input";

export interface RunTotals extends Usage {
  costUsd: number;
}

export type AssistantEvent =
  | { type: "run_start"; actor: Actor; provider: string; model: string }
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; actor: Actor }
  | {
      type: "tool_result";
      id: string;
      name: string;
      content: string;
      isError: boolean;
      denied?: DeniedReason;
      actor: Actor;
    }
  | { type: "turn_end"; turn: number; usage: Usage; totals: RunTotals }
  | { type: "done"; reason: DoneReason; totals: RunTotals; actor: Actor; messages: Message[] };

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function positiveInteger(name: string, value: number | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function validateLimits(limits: RunLimits, provider: ModelProvider) {
  const maxTurns = positiveInteger("maxTurns", limits.maxTurns, DEFAULT_MAX_TURNS) as number;
  const maxTotalTokens = positiveInteger("maxTotalTokens", limits.maxTotalTokens);
  const maxOutput = positiveInteger("maxOutputTokensPerTurn", limits.maxOutputTokensPerTurn, DEFAULT_MAX_OUTPUT_TOKENS) as number;
  let maxCostUsd: number | undefined;
  if (limits.maxCostUsd !== undefined) {
    if (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0) {
      throw new RangeError("maxCostUsd must be a positive number");
    }
    if (provider.pricing === undefined) {
      throw new RangeError(`maxCostUsd needs pricing, and provider "${provider.name}" has none`);
    }
    maxCostUsd = limits.maxCostUsd;
  }
  return { maxTurns, maxTotalTokens, maxOutput, maxCostUsd };
}

async function principalActive(principal: AssistantPrincipal, now: number): Promise<boolean> {
  if (principal.expiresAt !== undefined && !(now < principal.expiresAt)) return false;
  if (principal.isRevoked === undefined) return true;
  try {
    return !(await principal.isRevoked());
  } catch {
    return false;
  }
}

function checkUsage(usage: Usage): void {
  for (const value of [usage.inputTokens, usage.outputTokens]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ProviderError("provider reported invalid token usage; caps cannot be enforced");
    }
  }
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "null";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DONE_FOR_STOP: Record<Exclude<StopReason, "tool_use">, DoneReason> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  refusal: "refusal",
  other: "provider_stop",
};

/**
 * Runs the assistant until the model stops, a cap trips, or the principal stops
 * being valid. Tools run only when the model stops to use them, only inside the
 * principal's scopes, and never after a cap has tripped.
 */
export async function* runAssistant(options: RunOptions): AsyncGenerator<AssistantEvent> {
  const { provider, registry, principal, signal } = options;
  const limits = validateLimits(options.limits ?? {}, provider);
  const now = options.now ?? Date.now;
  const actor = actorOf(principal);
  const messages: Message[] = [...options.messages];
  const totals: RunTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const finish = (reason: DoneReason): AssistantEvent => ({
    type: "done",
    reason,
    totals: { ...totals },
    actor,
    messages: [...messages],
  });
  const capReason = (): DoneReason | undefined => {
    if (limits.maxTotalTokens !== undefined && totals.inputTokens + totals.outputTokens >= limits.maxTotalTokens) {
      return "token_cap";
    }
    if (limits.maxCostUsd !== undefined && totals.costUsd >= limits.maxCostUsd) return "cost_cap";
    return undefined;
  };

  yield { type: "run_start", actor, provider: provider.name, model: provider.model };

  for (let turn = 1; turn <= limits.maxTurns; turn++) {
    if (signal?.aborted) {
      yield finish("aborted");
      return;
    }
    if (!(await principalActive(principal, now()))) {
      yield finish("principal_inactive");
      return;
    }
    const preCap = capReason();
    if (preCap !== undefined) {
      yield finish(preCap);
      return;
    }

    yield { type: "turn_start", turn };
    const tools = registry
      .list()
      .filter((tool) => hasScope(principal.scopes, tool.scope))
      .map(toToolSpec);
    const tokenRoom =
      limits.maxTotalTokens === undefined
        ? Number.POSITIVE_INFINITY
        : limits.maxTotalTokens - totals.inputTokens - totals.outputTokens;
    let final: { content: ContentBlock[]; stopReason: StopReason; usage: Usage } | undefined;
    try {
      for await (const event of provider.stream({
        system: options.system,
        messages,
        tools,
        maxOutputTokens: Math.min(limits.maxOutput, tokenRoom),
        signal,
      })) {
        if (event.type === "text_delta") yield event;
        else final = event;
      }
    } catch (error) {
      if (signal?.aborted) {
        yield finish("aborted");
        return;
      }
      throw error;
    }
    if (final === undefined) throw new ProviderError(`provider "${provider.name}" ended without a final message`);
    checkUsage(final.usage);
    totals.inputTokens += final.usage.inputTokens;
    totals.outputTokens += final.usage.outputTokens;
    if (provider.pricing !== undefined) {
      totals.costUsd +=
        (final.usage.inputTokens * provider.pricing.inputPerMTok + final.usage.outputTokens * provider.pricing.outputPerMTok) /
        1_000_000;
    }
    messages.push({ role: "assistant", content: final.content });
    yield { type: "turn_end", turn, usage: final.usage, totals: { ...totals } };

    if (final.stopReason !== "tool_use") {
      yield finish(DONE_FOR_STOP[final.stopReason]);
      return;
    }
    const calls = final.content.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use");
    if (calls.length === 0) throw new ProviderError("provider stopped for tool use but sent no tool call");

    const stopBefore = capReason() ?? (turn === limits.maxTurns ? "max_turns" : undefined);
    const results: ContentBlock[] = [];
    const skipRest = (reason: DoneReason, from: number): AssistantEvent => {
      for (const call of calls.slice(from)) {
        results.push({ type: "tool_result", toolUseId: call.id, content: `not run: ${reason}`, isError: true });
      }
      messages.push({ role: "user", content: results });
      return finish(reason);
    };
    if (stopBefore !== undefined) {
      yield skipRest(stopBefore, 0);
      return;
    }

    for (const [index, call] of calls.entries()) {
      if (signal?.aborted) {
        yield skipRest("aborted", index);
        return;
      }
      if (!(await principalActive(principal, now()))) {
        yield skipRest("principal_inactive", index);
        return;
      }
      yield { type: "tool_call", id: call.id, name: call.name, input: call.input, actor };
      const outcome = await dispatch(registry, principal, call, signal);
      results.push({ type: "tool_result", toolUseId: call.id, content: outcome.content, isError: outcome.isError });
      yield {
        type: "tool_result",
        id: call.id,
        name: call.name,
        content: outcome.content,
        isError: outcome.isError,
        denied: outcome.denied,
        actor,
      };
    }
    messages.push({ role: "user", content: results });
  }
}

async function dispatch(
  registry: ToolRegistry,
  principal: AssistantPrincipal,
  call: { id: string; name: string; input: unknown },
  signal: AbortSignal | undefined,
): Promise<{ content: string; isError: boolean; denied?: DeniedReason }> {
  const tool = registry.get(call.name);
  if (tool === undefined) {
    return { content: `unknown tool "${call.name}"`, isError: true, denied: "unknown_tool" };
  }
  if (!hasScope(principal.scopes, tool.scope)) {
    return {
      content: `denied: tool "${tool.name}" needs scope "${tool.scope}", which this assistant does not hold`,
      isError: true,
      denied: "scope",
    };
  }
  if (!isPlainObject(call.input)) {
    return { content: "tool input must be a JSON object", isError: true, denied: "invalid_input" };
  }
  try {
    const value = await tool.handler(call.input, { principal, toolUseId: call.id, signal });
    return { content: serialize(value), isError: false };
  } catch (error) {
    return { content: `tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}
