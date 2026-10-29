import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryAuth } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { QueueApprovalGate, type ApproverKind } from "./approvals.js";
import type { Setup } from "./chat.js";
import { ToolRegistry, createPrincipal, runAssistant, type AssistantEvent } from "./index.js";
import { createAssistantMcpServer } from "./mcp-server.js";
import { TRAINED_ALGORITHMIC_MEDIA, createProvenance, provenanceLabel, provenanceMarker } from "./provenance.js";
import { ScriptedProvider, type ScriptedTurn } from "./testing.js";
import type { ModelEvent, ModelProvider } from "./types.js";
import { createWorker } from "./worker.js";

// Ways the AI marking can fail. Each one is a case below.
// 1. A denied, unknown, or refused call carries a record, as if a machine had edited something.
// 2. A safe call names an approver, or an approved call names none.
// 3. After a fallback, the record names the first model, not the one that answered.
// 4. A run that no model answered carries a record with an invented model.
// 5. A model name with control or bidi characters changes what the label shows a person.
// 6. A bad time makes a record with a wrong date.
// 7. A surface (HTTP, MCP) drops the record or the label.

const NOW = Date.parse("2026-10-29T10:00:00Z");
const tools = () =>
  new ToolRegistry()
    .register({ name: "read", description: "r", inputSchema: { type: "object" }, scope: "notes:read", risk: "safe", handler: async () => "text" })
    .register({ name: "wipe", description: "w", inputSchema: { type: "object" }, scope: "notes:write", risk: "risky", handler: async () => "wiped" })
    .register({ name: "boom", description: "b", inputSchema: { type: "object" }, scope: "notes:read", risk: "safe", handler: async () => { throw new Error("x"); } });

async function run(turns: ScriptedTurn[], gate?: (id: string) => "approve" | "deny", provider: ModelProvider = new ScriptedProvider(turns), kind?: ApproverKind) {
  const approvals = new QueueApprovalGate();
  const out: AssistantEvent[] = [];
  const principal = createPrincipal({ id: "assistant:ana", kind: "agent_of_human", parentId: "ana", scopes: ["notes:read", "notes:write"] });
  for await (const event of runAssistant({ provider, registry: tools(), principal, approvals: gate ? approvals : undefined, now: () => NOW, messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] })) {
    out.push(event);
    if (event.type === "approval_request") {
      if (gate?.(event.request.id) === "approve") approvals.approve(event.request.id, "ana", kind);
      else approvals.reject(event.request.id, "ana", "no");
    }
  }
  return out;
}
const results = (events: AssistantEvent[]) => events.filter((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result");
const done = (events: AssistantEvent[]) => events.at(-1) as Extract<AssistantEvent, { type: "done" }>;

describe("provenance in the run", () => {
  test("the answer and a safe tool result carry a record with no approver", async () => {
    const events = await run([{ toolCalls: [{ name: "read", input: {} }] }, { text: "ok" }]);
    const expected = { generator: "ai", model: "scripted-1", provider: "scripted", createdAt: "2026-10-29T10:00:00.000Z", actor: "assistant:ana", onBehalfOf: "ana" };
    expect(results(events)[0]!.provenance).toEqual({ ...expected, tool: "read", risk: "safe" });
    expect(done(events).provenance).toEqual(expected);
  });

  test("an approved edit names the approver, and a refused one has no record", async () => {
    const turns = [{ toolCalls: [{ name: "wipe", input: {} }] }, { text: "ok" }];
    const approved = await run(turns, () => "approve", undefined, "human");
    expect(results(approved)[0]!.provenance).toMatchObject({ tool: "wipe", risk: "risky", approvedBy: [{ id: "ana", kind: "human" }] });
    expect(results((await run(turns, () => "approve", undefined, "agent")))[0]!.provenance?.approvedBy).toEqual([{ id: "ana", kind: "agent" }]);
    // A gate that does not say who approved, or says something else, is not taken for a person.
    expect(results((await run(turns, () => "approve")))[0]!.provenance?.approvedBy).toEqual([{ id: "ana", kind: "unknown" }]);
    expect(results((await run(turns, () => "approve", undefined, "root" as never)))[0]!.provenance?.approvedBy).toEqual([{ id: "ana", kind: "unknown" }]);
    const refused = await run(turns, () => "deny");
    expect(results(refused)[0]).toMatchObject({ denied: "approval" });
    expect(results(refused)[0]!.provenance).toBeUndefined();
    const unknown = await run([{ toolCalls: [{ name: "nope", input: {} }] }, { text: "ok" }]);
    expect(results(unknown)[0]!.provenance).toBeUndefined();
  });

  test("a tool that throws is still marked, because it may have changed something", async () => {
    const events = await run([{ toolCalls: [{ name: "boom", input: {} }] }, { text: "ok" }]);
    expect(results(events)[0]).toMatchObject({ isError: true, provenance: { generator: "ai" } });
  });

  test("after a fallback, the record names the model that answered", async () => {
    const provider: ModelProvider = {
      name: "primary",
      model: "first",
      async *stream(): AsyncGenerator<ModelEvent> {
        yield { type: "message", content: [{ type: "text", text: "hi" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 }, answeredBy: { provider: "primary", model: "second", fallback: true, fallbackFor: "refusal" } };
      },
    };
    const events = await run([], undefined, provider);
    expect(done(events).provenance).toMatchObject({ model: "second", provider: "primary" });
  });

  test("a provider with an empty model name stops the run before any tool runs", async () => {
    let ran = 0;
    const provider: ModelProvider = {
      name: "p",
      model: "",
      async *stream(): AsyncGenerator<ModelEvent> {
        yield { type: "message", content: [{ type: "tool_use", id: "c", name: "wipe", input: {} }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const registry = new ToolRegistry().register({ name: "wipe", description: "w", inputSchema: { type: "object" }, scope: "notes:write", risk: "safe", handler: async () => (ran++, "x") });
    const principal = createPrincipal({ id: "a", kind: "agent_of_human", parentId: "ana", scopes: ["notes:write"] });
    const out: AssistantEvent[] = [];
    for await (const event of runAssistant({ provider, registry, principal, messages: [] })) out.push(event);
    expect(done(out)).toMatchObject({ reason: "provider_error" });
    expect(ran).toBe(0);
  });

  test("a run that no model answered has no record", async () => {
    const provider: ModelProvider = { name: "p", model: "m", async *stream() { throw new Error("down"); } };
    const events = await run([], undefined, provider);
    expect(done(events)).toMatchObject({ reason: "provider_error" });
    expect(done(events).provenance).toBeUndefined();
  });
});

describe("provenance helper", () => {
  const record = createProvenance({ model: "m-1", provider: "acme", createdAt: NOW, actor: "assistant:ana", onBehalfOf: "ana", approvedBy: [{ id: "bob", kind: "human" }, { id: "bob", kind: "human" }, { id: "ops", kind: "agent" }, { id: "cli:pre-approved", kind: "host" }, { id: "x", kind: "unknown" }] });

  test("the marker uses the IPTC trainedAlgorithmicMedia source type", () => {
    const marker = provenanceMarker(record) as Record<string, any>;
    expect(marker["@context"]).toBe("https://schema.org");
    expect(marker.digitalSourceType).toBe(TRAINED_ALGORITHMIC_MEDIA);
    expect(marker.digitalSourceType).toMatch(/trainedAlgorithmicMedia$/);
    expect(marker.dateCreated).toBe("2026-10-29T10:00:00.000Z");
    expect(marker.additionalProperty.filter((p: any) => p.name.startsWith("approvedBy")).map((p: any) => `${p.name}=${p.value}`)).toEqual(
      ["approvedBy:human=bob", "approvedBy:host=cli:pre-approved", "approvedBy:agent=ops", "approvedBy:unknown=x"],
    );
  });

  test("the label is short and says AI-generated", () => {
    expect(provenanceLabel(record)).toBe("AI-generated by m-1 (acme), approved by bob, cli:pre-approved (host rule), ops (agent), x (unverified)");
  });

  test("the label drops control and bidi characters and cuts long names", () => {
    const label = provenanceLabel({ ...record, model: "evil\u202e\n\u001b[2Jmodel" + "x".repeat(500), approvedBy: undefined });
    expect(label).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(label.length).toBeLessThan(140);
    expect(label.startsWith("AI-generated by ")).toBe(true);
  });

  test("a label hides the Arabic letter mark and word joiners", () => {
    expect(provenanceLabel({ ...record, model: "a\u061cb\u2060c\u00add", approvedBy: undefined })).toBe("AI-generated by a b c d (acme)");
  });

  test("an empty or non-string model, provider, or actor is an error", () => {
    for (const bad of ["", undefined, 7]) {
      expect(() => createProvenance({ model: bad as never, provider: "p", createdAt: NOW, actor: "a", onBehalfOf: "b" })).toThrow(TypeError);
      expect(() => createProvenance({ model: "m", provider: bad as never, createdAt: NOW, actor: "a", onBehalfOf: "b" })).toThrow(TypeError);
    }
  });

  test.each([Number.NaN, 1e20])("a clock of %s gives a record the real time", async (clockValue) => {
    const principal = createPrincipal({ id: "a", kind: "agent_of_human", parentId: "ana", scopes: ["notes:read"] });
    const out: AssistantEvent[] = [];
    for await (const event of runAssistant({ provider: new ScriptedProvider([{ text: "hi" }]), registry: tools(), principal, now: () => clockValue, messages: [] })) out.push(event);
    const last = done(out);
    // The record falls back to the real time, so the date is never wrong or missing.
    expect(last.reason).toBe("end_turn");
    expect(Math.abs(Date.parse(last.provenance!.createdAt) - Date.now())).toBeLessThan(60_000);
  });

  test("a bad approver, tool, or risk is an error", () => {
    const base = { model: "m", provider: "p", createdAt: NOW, actor: "a", onBehalfOf: "b" };
    expect(() => createProvenance({ ...base, approvedBy: [{ id: "x", kind: "root" as never }] })).toThrow(TypeError);
    expect(() => createProvenance({ ...base, approvedBy: [{ id: "", kind: "human" }] })).toThrow(TypeError);
    expect(() => createProvenance({ ...base, risk: "low" as never })).toThrow(TypeError);
    expect(() => createProvenance({ ...base, tool: "" })).toThrow(TypeError);
  });

  test("the label drops Hangul fillers and tag characters, and does not cut a surrogate pair", () => {
    expect(provenanceLabel({ ...record, model: "a\u3164b\u{e0041}c", approvedBy: undefined })).toBe("AI-generated by a b c (acme)");
    const label = provenanceLabel({ ...record, model: "\u{1f600}".repeat(200), approvedBy: undefined });
    expect(label).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  test("a time that is not a number is an error", () => {
    expect(() => createProvenance({ model: "m", provider: "p", createdAt: Number.NaN, actor: "a", onBehalfOf: "b" })).toThrow(RangeError);
  });
});

describe("provenance on the HTTP API", () => {
  test("the chat stream carries the record on the tool result and on done", async () => {
    const memory = createMemoryAuth();
    const worker = createWorker({ auth: memory.auth, registry: tools(), provider: () => new ScriptedProvider([{ toolCalls: [{ name: "read", input: {} }] }, { text: "ok" }]) });
    const token = await memory.issue({ principalId: "ana", kind: "human", chain: [{ id: "ana", kind: "human" }], scopes: ["notes:read"] } as never);
    const response = await worker.fetch(new Request("https://x.test/api/v1/chat", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ message: "go" }) }));
    const text = await response.text();
    const data = (name: string) => [...text.matchAll(new RegExp(`event: ${name}\\ndata: (.*)`, "g"))].map((m) => JSON.parse(m[1]!));
    expect(data("tool_result")[0].provenance).toMatchObject({ generator: "ai", actor: "assistant:ana", onBehalfOf: "ana" });
    expect(data("done")[0].provenance).toMatchObject({ generator: "ai", model: "scripted-1" });
  });
});

describe("provenance in MCP results", () => {
  test("assistant_chat returns the record, the label, and the marker", async () => {
    const setup: Setup = {
      provider: new ScriptedProvider([{ toolCalls: [{ name: "read", input: {} }] }, { text: "ok" }]),
      registry: tools(),
      gate: new QueueApprovalGate(),
      principalOptions: { id: "mcp-agent", parentId: "ana", scopes: ["notes:read"] },
      limits: {},
      skipped: [],
      close: async () => {},
    };
    const server = createAssistantMcpServer(setup);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);
    try {
      const result = await client.callTool({ name: "assistant_chat", arguments: { message: "go" } });
      const body = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(body.provenance).toMatchObject({ generator: "ai", actor: "mcp-agent", model: "scripted-1" });
      expect(body.label).toBe("AI-generated by scripted-1 (scripted)");
      expect(body.marker.digitalSourceType).toBe(TRAINED_ALGORITHMIC_MEDIA);
      expect(body.toolCalls[0].provenance).toMatchObject({ generator: "ai" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
