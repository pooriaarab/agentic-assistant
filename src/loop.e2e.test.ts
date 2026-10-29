import { describe, expect, test, vi } from "vitest";
import {
  ToolRegistry,
  createPrincipal,
  PrincipalError,
  runAssistant,
  type AssistantEvent,
  type RunLimits,
  type Scope,
} from "./index.js";
import { ScriptedProvider, type ScriptedTurn } from "./testing.js";

// Ways the loop can fail. Each one is a case below.
// 1. A tool outside the granted scopes runs, or is offered to the model.
// 2. The model names a tool that does not exist and the run crashes or runs something else.
// 3. A tool gets input that is not a JSON object.
// 4. A tool throws and the whole run dies, or the error reaches the model as success.
// 5. A turn, token, or cost cap does not stop the run, or tools run after the cap tripped.
// 6. A cap stops the run and leaves a tool_use with no tool_result in the transcript.
// 7. Truncated or refused output (max_tokens, refusal) still runs its tool calls.
// 8. Bad usage numbers (NaN, negative) slip past the caps.
// 9. An expired, revoked, or unreadable principal still acts.
// 10. A principal gets built with a missing kind, a wrong kind, or a bad scope.
// 11. An action is not labeled machine-made.
// 12. An aborted run keeps calling the model.

const ALICE = "human:alice";

function principal(scopes: Scope[], extra: Partial<Parameters<typeof createPrincipal>[0]> = {}) {
  return createPrincipal({ id: "agent:a1", kind: "agent_of_human", parentId: ALICE, scopes, ...extra });
}

function setup(scripts: ScriptedTurn[], scopes: Scope[], limits?: RunLimits, pricing?: ConstructorParameters<typeof ScriptedProvider>[1]) {
  const read = vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ note: `text of ${String(input.id)}` }));
  const remove = vi.fn(async () => "deleted");
  const registry = new ToolRegistry()
    .register({ name: "notes_read", description: "Read a note", inputSchema: { type: "object" }, scope: "notes:read", handler: read })
    .register({ name: "notes_delete", description: "Delete a note", inputSchema: { type: "object" }, scope: "notes:write", handler: remove });
  const provider = new ScriptedProvider(scripts, pricing);
  const run = (extra: Partial<Parameters<typeof runAssistant>[0]> = {}) =>
    collect(
      runAssistant({
        provider,
        registry,
        principal: principal(scopes),
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        limits,
        ...extra,
      }),
    );
  return { read, remove, provider, registry, run };
}

async function collect(gen: AsyncGenerator<AssistantEvent>): Promise<AssistantEvent[]> {
  const events: AssistantEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const done = (events: AssistantEvent[]) => events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
const results = (events: AssistantEvent[]) => events.filter((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result");

describe("run loop", () => {
  test("runs a tool, feeds the result back, and streams the answer", async () => {
    const { read, provider, run } = setup(
      [{ text: "Let me look. ", toolCalls: [{ name: "notes_read", input: { id: "n1" } }] }, { text: "The note says hi." }],
      ["notes:read"],
    );
    const events = await run();
    expect(events.map((e) => e.type)).toEqual([
      "run_start", "turn_start", "text_delta", "text_delta", "text_delta", "turn_end", "tool_call", "tool_result",
      "turn_start", "text_delta", "text_delta", "text_delta", "text_delta", "turn_end", "done",
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(done(events).reason).toBe("end_turn");
    expect(done(events).totals).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    const second = provider.requests[1]?.messages.at(-1);
    expect(second).toEqual({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "call_1_0", content: JSON.stringify({ note: "text of n1" }), isError: false }],
    });
  });

  test("labels every action as machine-made", async () => {
    const { run } = setup([{ toolCalls: [{ name: "notes_read", input: { id: "n1" } }] }, { text: "ok" }], ["notes:read"]);
    const events = await run();
    const labeled = events.filter((e) => e.type === "run_start" || e.type === "tool_call" || e.type === "tool_result" || e.type === "done");
    expect(labeled).toHaveLength(4);
    for (const event of labeled) {
      expect(event).toMatchObject({ actor: { kind: "agent_of_human", onBehalfOf: ALICE, machineMade: true } });
    }
  });

  test("offers only tools inside the scopes and refuses one called anyway", async () => {
    const { read, remove, provider, run } = setup(
      [{ toolCalls: [{ name: "notes_delete", input: { id: "n1" } }] }, { text: "I could not delete it." }],
      ["notes:read"],
    );
    const events = await run();
    expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(["notes_read"]);
    expect(remove).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(results(events)[0]).toMatchObject({ isError: true, denied: "scope" });
    expect(results(events)[0]?.content).toContain("notes:write");
    expect(done(events).reason).toBe("end_turn");
  });

  test("a stronger scope covers the weaker tool", async () => {
    const { provider, run } = setup([{ text: "hi" }], ["notes:write"]);
    await run();
    expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(["notes_read", "notes_delete"]);
  });

  test("no scopes means no tools", async () => {
    const { provider, run } = setup([{ text: "hi" }], []);
    await run();
    expect(provider.requests[0]?.tools).toEqual([]);
  });

  test("an unknown tool is an error result, not a crash", async () => {
    const { run } = setup([{ toolCalls: [{ name: "format_disk", input: {} }] }, { text: "sorry" }], ["*:admin"]);
    const events = await run();
    expect(results(events)[0]).toMatchObject({ isError: true, denied: "unknown_tool" });
    expect(done(events).reason).toBe("end_turn");
  });

  test.each([[null], [[1, 2]], ["text"], [7]])("non-object input %j is refused", async (input) => {
    const { read, run } = setup([{ toolCalls: [{ name: "notes_read", input }] }, { text: "ok" }], ["notes:read"]);
    const events = await run();
    expect(read).not.toHaveBeenCalled();
    expect(results(events)[0]).toMatchObject({ isError: true, denied: "invalid_input" });
  });

  test("a throwing tool becomes an error result and the run goes on", async () => {
    const { read, run } = setup([{ toolCalls: [{ name: "notes_read", input: {} }] }, { text: "it failed" }], ["notes:read"]);
    read.mockRejectedValueOnce(new Error("disk full"));
    const events = await run();
    expect(results(events)[0]).toMatchObject({ isError: true, content: "tool failed", detail: "disk full" });
    expect(done(events).reason).toBe("end_turn");
  });

  test("several calls in one turn return in one user message, in order", async () => {
    const { provider, run } = setup(
      [{ toolCalls: [{ name: "notes_read", input: { id: "a" } }, { name: "notes_read", input: { id: "b" } }] }, { text: "done" }],
      ["notes:read"],
    );
    await run();
    const last = provider.requests[1]?.messages.at(-1);
    expect(last?.content.map((b) => b.type === "tool_result" && b.content)).toEqual([
      JSON.stringify({ note: "text of a" }),
      JSON.stringify({ note: "text of b" }),
    ]);
  });

  test("the turn cap stops the run and skips the last turn's tools", async () => {
    const turns = Array.from({ length: 5 }, () => ({ toolCalls: [{ name: "notes_read", input: { id: "x" } }] }));
    const { read, run } = setup(turns, ["notes:read"], { maxTurns: 3 });
    const events = await run();
    expect(done(events).reason).toBe("max_turns");
    expect(read).toHaveBeenCalledTimes(2);
    expectEveryToolUseAnswered(done(events).messages);
  });

  test("the token cap stops the run and trims the next request", async () => {
    const turns = Array.from({ length: 5 }, () => ({ toolCalls: [{ name: "notes_read", input: {} }], usage: { inputTokens: 200, outputTokens: 100 } }));
    const { read, provider, run } = setup(turns, ["notes:read"], { maxTotalTokens: 600 });
    const events = await run();
    expect(done(events).reason).toBe("token_cap");
    expect(read).toHaveBeenCalledTimes(1);
    expect(provider.requests[1]?.maxOutputTokens).toBeGreaterThan(0);
    expect(provider.requests[1]?.maxOutputTokens).toBeLessThanOrEqual(300);
    expectEveryToolUseAnswered(done(events).messages);
  });

  test("the cost cap stops the run", async () => {
    const turns = Array.from({ length: 5 }, () => ({ toolCalls: [{ name: "notes_read", input: {} }], usage: { inputTokens: 10, outputTokens: 5 } }));
    const { read, run } = setup(turns, ["notes:read"], { maxCostUsd: 20 }, { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 });
    const events = await run();
    expect(done(events).reason).toBe("cost_cap");
    expect(done(events).totals.costUsd).toBe(30);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("a cost cap with no pricing is refused", async () => {
    const { run } = setup([{ text: "hi" }], [], { maxCostUsd: 1 });
    await expect(run()).rejects.toThrow(/needs pricing/);
  });

  test.each([[{ maxTurns: 0 }], [{ maxTurns: 1.5 }], [{ maxTotalTokens: Number.NaN }], [{ maxCostUsd: -1 }], [{ maxOutputTokensPerTurn: 0 }]])(
    "bad limits %j are refused",
    async (limits) => {
      const { run } = setup([{ text: "hi" }], [], limits as RunLimits, { inputPerMTok: 1, outputPerMTok: 1 });
      await expect(run()).rejects.toThrow(RangeError);
    },
  );

  test.each([
    [{ inputTokens: Number.NaN, outputTokens: 1 }],
    [{ inputTokens: -5, outputTokens: 1 }],
    [{ inputTokens: 1.5, outputTokens: 1 }],
  ])("bad usage %j ends the run with provider_error", async (usage) => {
    const { read, run } = setup([{ toolCalls: [{ name: "notes_read", input: {} }], usage }], ["notes:read"], { maxTotalTokens: 10_000 });
    const events = await run();
    expect(done(events)).toMatchObject({ reason: "provider_error", error: expect.stringContaining("token usage") });
    expect(read).not.toHaveBeenCalled();
  });

  test("a provider failure keeps the transcript and the totals", async () => {
    const { read, run } = setup([{ toolCalls: [{ name: "notes_read", input: {} }] }], ["notes:read"]);
    const events = await run();
    expect(read).toHaveBeenCalledTimes(1);
    expect(done(events)).toMatchObject({ reason: "provider_error", totals: { inputTokens: 10, outputTokens: 5 } });
    expect(done(events).messages).toHaveLength(3);
  });

  test.each([
    ["NaN", { inputPerMTok: Number.NaN, outputPerMTok: 1 }],
    ["negative", { inputPerMTok: -1, outputPerMTok: 1 }],
    ["a string", { inputPerMTok: "2", outputPerMTok: 1 }],
    ["Infinity", { inputPerMTok: 1, outputPerMTok: Number.POSITIVE_INFINITY }],
  ])("%s pricing is refused", async (_name, pricing) => {
    const { run } = setup([{ text: "hi" }], [], { maxCostUsd: 1 }, pricing as never);
    await expect(run()).rejects.toThrow(/pricing/);
  });

  test.each([[undefined], [null], ["no"], [0]])("a revocation check that returns %j denies", async (value) => {
    const { provider, registry } = setup([{ text: "hi" }], []);
    const events = await collect(
      runAssistant({ provider, registry, principal: principal(["notes:read"], { isRevoked: () => value as never }), messages: [] }),
    );
    expect(done(events).reason).toBe("principal_inactive");
    expect(provider.requests).toHaveLength(0);
  });

  test.each([
    ["the human kind", { id: "a", kind: "human", parentId: "h", scopes: ["*:admin"] }],
    ["no kind", { id: "a", parentId: "h", scopes: ["*:admin"] }],
    ["a bad scope", { id: "a", kind: "agent_of_human", parentId: "h", scopes: ["*:root"] }],
    ["a NaN expiry", { id: "a", kind: "agent_of_human", parentId: "h", scopes: [], expiresAt: Number.NaN }],
  ])("a principal that skipped createPrincipal with %s is refused", async (_name, bad) => {
    const { provider, registry } = setup([{ text: "hi" }], []);
    await expect(collect(runAssistant({ provider, registry, principal: bad as never, messages: [] }))).rejects.toThrow(PrincipalError);
    expect(provider.requests).toHaveLength(0);
  });

  test("a huge tool result is cut before it reaches the model", async () => {
    const { read, provider, run } = setup([{ toolCalls: [{ name: "notes_read", input: {} }] }, { text: "ok" }], ["notes:read"], { maxToolResultChars: 1000 });
    read.mockResolvedValueOnce("x".repeat(100_000));
    const events = await run();
    const content = results(events)[0]?.content ?? "";
    expect(content.length).toBeLessThan(1100);
    expect(content).toContain("[truncated: 99000 characters omitted]");
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain("x".repeat(1001));
  });

  test("a request that would pass the token cap is not sent", async () => {
    const { read, provider, run } = setup([{ toolCalls: [{ name: "notes_read", input: {} }] }, { text: "never" }], ["notes:read"], {
      maxTotalTokens: 2000,
      maxToolResultChars: 50_000,
    });
    read.mockResolvedValueOnce("y".repeat(40_000));
    const events = await run();
    expect(done(events).reason).toBe("token_cap");
    expect(provider.requests).toHaveLength(1);
  });

  test("tool error detail stays out of the transcript", async () => {
    const { read, provider, run } = setup([{ toolCalls: [{ name: "notes_read", input: {} }] }, { text: "failed" }], ["notes:read"]);
    read.mockRejectedValueOnce(new Error("connect failed postgres://app:s3cr3t@db/notes"));
    const events = await run();
    expect(results(events)[0]).toMatchObject({ isError: true, content: "tool failed", detail: expect.stringContaining("s3cr3t") });
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain("s3cr3t");
  });

  test("an abort between tool calls skips the rest", async () => {
    const controller = new AbortController();
    const { read, provider, registry } = setup(
      [{ toolCalls: [{ name: "notes_read", input: { id: "a" } }, { name: "notes_read", input: { id: "b" } }] }],
      [],
    );
    read.mockImplementation(async () => {
      controller.abort();
      return "first";
    });
    const events = await collect(
      runAssistant({ provider, registry, principal: principal(["notes:read"]), messages: [], signal: controller.signal }),
    );
    expect(done(events).reason).toBe("aborted");
    expect(read).toHaveBeenCalledTimes(1);
    expectEveryToolUseAnswered(done(events).messages);
  });

  test("an abort while the model streams ends the run", async () => {
    const controller = new AbortController();
    const slow = {
      name: "slow",
      model: "slow-1",
      async *stream(request: { signal?: AbortSignal }) {
        controller.abort();
        if (request.signal?.aborted) throw new Error("aborted by caller");
        yield { type: "text_delta" as const, text: "never" };
      },
    };
    const events = await collect(
      runAssistant({ provider: slow, registry: new ToolRegistry(), principal: principal([]), messages: [], signal: controller.signal }),
    );
    expect(done(events).reason).toBe("aborted");
  });

  test.each([["max_tokens", "max_tokens"], ["refusal", "refusal"]] as const)("stop reason %s never runs its tool calls", async (stopReason, reason) => {
    const { read, run } = setup([{ toolCalls: [{ name: "notes_read", input: { id: "cut" } }], stopReason }], ["notes:read"]);
    const events = await run();
    expect(done(events).reason).toBe(reason);
    expect(read).not.toHaveBeenCalled();
  });

  test("an expired principal never reaches the model", async () => {
    const { provider, registry } = setup([{ text: "hi" }], []);
    const events = await collect(
      runAssistant({
        provider,
        registry,
        principal: principal(["notes:read"], { expiresAt: 1_000 }),
        messages: [],
        now: () => 1_000,
      }),
    );
    expect(done(events).reason).toBe("principal_inactive");
    expect(provider.requests).toHaveLength(0);
  });

  test("a principal revoked mid-run stops before the next tool call", async () => {
    const { read, provider, registry } = setup(
      [{ toolCalls: [{ name: "notes_read", input: { id: "a" } }, { name: "notes_read", input: { id: "b" } }] }],
      [],
    );
    let revoked = false;
    read.mockImplementation(async () => {
      revoked = true;
      return "first";
    });
    const events = await collect(
      runAssistant({ provider, registry, principal: principal(["notes:read"], { isRevoked: () => revoked }), messages: [] }),
    );
    expect(done(events).reason).toBe("principal_inactive");
    expect(read).toHaveBeenCalledTimes(1);
    expectEveryToolUseAnswered(done(events).messages);
  });

  test("a revocation check that throws denies", async () => {
    const { provider, registry } = setup([{ text: "hi" }], []);
    const events = await collect(
      runAssistant({
        provider,
        registry,
        principal: principal(["notes:read"], { isRevoked: () => { throw new Error("db down"); } }),
        messages: [],
      }),
    );
    expect(done(events).reason).toBe("principal_inactive");
    expect(provider.requests).toHaveLength(0);
  });

  test("an aborted run does not call the model", async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, run } = setup([{ text: "hi" }], []);
    const events = await run({ signal: controller.signal });
    expect(done(events).reason).toBe("aborted");
    expect(provider.requests).toHaveLength(0);
  });
});

describe("principal", () => {
  test.each([
    ["a missing kind", { id: "a", parentId: "h", scopes: [] }],
    ["the human kind", { id: "a", kind: "human", parentId: "h", scopes: [] }],
    ["the agent kind", { id: "a", kind: "agent", parentId: "h", scopes: [] }],
    ["an empty parent", { id: "a", kind: "agent_of_human", parentId: "", scopes: [] }],
    ["a bad scope", { id: "a", kind: "agent_of_human", parentId: "h", scopes: ["docs:delete"] }],
    ["scopes that are not an array", { id: "a", kind: "agent_of_human", parentId: "h", scopes: "docs:read" }],
    ["a NaN expiry", { id: "a", kind: "agent_of_human", parentId: "h", scopes: [], expiresAt: Number.NaN }],
  ])("rejects %s", (_name, input) => {
    expect(() => createPrincipal(input as never)).toThrow(PrincipalError);
  });

  test("freezes its scopes", () => {
    const made = principal(["notes:read"]);
    expect(() => (made.scopes as string[]).push("*:admin")).toThrow();
  });
});

describe("tool registry", () => {
  test("rejects a duplicate name, a bad name, and a bad scope", () => {
    const base = { description: "d", inputSchema: {}, handler: () => "x" };
    const registry = new ToolRegistry().register({ ...base, name: "a", scope: "notes:read" });
    expect(() => registry.register({ ...base, name: "a", scope: "notes:read" })).toThrow(/already registered/);
    expect(() => registry.register({ ...base, name: "bad name", scope: "notes:read" })).toThrow(/invalid tool name/);
    expect(() => registry.register({ ...base, name: "b", scope: "notes:delete" })).toThrow(/invalid scope/);
  });
});

function expectEveryToolUseAnswered(messages: { role: string; content: { type: string; id?: string; toolUseId?: string }[] }[]) {
  const used = messages.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.id));
  const answered = messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result").map((b) => b.toolUseId));
  expect(answered.sort()).toEqual(used.sort());
}
