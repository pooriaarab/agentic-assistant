import { checkBaseUrl, isLoopback } from "./url.js";
import { randomUUID } from "node:crypto";
import {
  ProviderError,
  type ContentBlock,
  type Message,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type Pricing,
  type StopReason,
} from "../types.js";

export interface OpenAICompatibleOptions {
  /** Base URL that serves `/chat/completions`, for example an EU-hosted endpoint. Required. */
  baseUrl: string;
  model: string;
  /** Required for any host except localhost. An empty key is refused. */
  apiKey?: string;
  pricing?: Pricing;
  /** Most bytes to read from one response, comments and keep-alive lines included. Default 4,000,000. */
  maxResponseChars?: number;
  /** Provider name in events and errors. Default "openai-compatible". */
  name?: string;
}

const FINISH_REASONS: Record<string, StopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toChatMessages(system: string | undefined, messages: readonly Message[]): ChatMessage[] {
  const out: ChatMessage[] = system !== undefined ? [{ role: "system", content: system }] : [];
  for (const message of messages) {
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (message.role === "user") {
      for (const block of message.content) {
        if (block.type === "tool_result") out.push({ role: "tool", tool_call_id: block.toolUseId, content: block.content });
      }
      if (text.length > 0) out.push({ role: "user", content: text });
      continue;
    }
    const toolCalls = message.content
      .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
      .map((block) => ({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }));
    out.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return out;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/** Speaks the OpenAI chat-completions streaming wire format, so any compatible server works. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly pricing?: Pricing;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly maxResponseChars: number;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name ?? "openai-compatible";
    this.model = options.model;
    this.pricing = options.pricing;
    this.apiKey = options.apiKey;
    const limit = options.maxResponseChars ?? 4_000_000;
    if (!Number.isInteger(limit) || limit <= 0) throw new ProviderError("maxResponseChars must be a positive integer");
    this.maxResponseChars = limit;
    const { url, text } = checkBaseUrl(options.baseUrl);
    this.baseUrl = text;
    if (options.apiKey === "" || (options.apiKey === undefined && !isLoopback(url))) {
      throw new ProviderError("apiKey must be a non-empty string for a remote host");
    }
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey !== undefined ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.maxOutputTokens,
        messages: toChatMessages(request.system, request.messages),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
              })),
            }
          : {}),
      }),
    });
    if (!response.ok || response.body === null) {
      throw new ProviderError(`${this.name} request failed with status ${response.status}`);
    }

    let text = "";
    let received = 0;
    const limit = this.maxResponseChars;
    const calls = new Map<number, ToolCallAccumulator>();
    let finish: string | undefined;
    let usage: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = function* (line: string): Generator<ModelEvent> {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") return;
      let chunk: {
        choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
        usage?: typeof usage;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        throw new ProviderError("provider sent a stream chunk that is not JSON");
      }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      for (const part of delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: "", name: "", args: "" };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.args += part.function.arguments;
        calls.set(part.index, call);
      }
    };

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > limit) throw new ProviderError(`${this.name} response passed the size limit of ${limit} bytes`);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) yield* handle(line.trimEnd());
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (buffer.length > 0) yield* handle(buffer.trimEnd());

    if (!Number.isInteger(usage?.prompt_tokens) || !Number.isInteger(usage?.completion_tokens)) {
      throw new ProviderError(`${this.name} reported no token usage, so token and cost caps cannot be enforced`);
    }
    const content: ContentBlock[] = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const [, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown = null;
      try {
        input = call.args.length > 0 ? JSON.parse(call.args) : {};
      } catch {
        input = null;
      }
      content.push({ type: "tool_use", id: call.id.length > 0 ? call.id : `call_${randomUUID()}`, name: call.name, input });
    }
    yield {
      type: "message",
      content,
      stopReason: FINISH_REASONS[finish ?? ""] ?? "other",
      usage: { inputTokens: usage?.prompt_tokens as number, outputTokens: usage?.completion_tokens as number },
    };
  }
}
