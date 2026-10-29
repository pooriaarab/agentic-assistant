import { createMemoryAuth } from "agentic-identity";
import { describe, expect, test, vi } from "vitest";
import { ToolRegistry } from "./index.js";
import { ScriptedProvider, type ScriptedTurn } from "./testing.js";
import { createWorker } from "./worker.js";

// Ways the hosted API can fail. Each one is a case below.
// 1. A request with no key, a bad key, a failing Auth, or a context of the wrong shape gets in.
// 2. The assistant, or the tool list, has more scopes than the caller.
// 3. A risky call runs before a person approves, or runs after a no.
// 4. An agent approves or rejects the call it proposed.
// 5. An agent with no approver scope decides, or a decider lacks the scope of the tool.
// 6. A principal of another owner sees, approves, or rejects a pending call.
// 7. An approval for other arguments (a wrong digest) is accepted, or one call is decided twice.
// 8. The chat is not a stream, or events arrive out of order.
// 9. A client that hangs up leaves the run and the pending call behind.
// 10. A key revoked during a run does not stop the run.
// 11. A bad body, a long message, or a wrong method is accepted.

const base = "https://assistant.test/api/v1";
const ANA = "human:ana";
const BOB = "human:bob";

function world(scripts: ScriptedTurn[] | (() => ScriptedProvider)) {
  const memory = createMemoryAuth();
  const read = vi.fn(async () => ({ note: "hello" }));
  const remove = vi.fn(async () => "deleted");
  const registry = new ToolRegistry()
    .register({ name: "notes_read", description: "Read a note", inputSchema: { type: "object" }, scope: "notes:read", risk: "safe", handler: read })
    .register({ name: "notes_delete", description: "Delete a note", inputSchema: { type: "object" }, scope: "notes:write", risk: "risky", handler: remove })
    .register({ name: "mail_send", description: "Send mail", inputSchema: { type: "object" }, scope: "mail:write", risk: "irreversible", handler: async () => "sent" });
  const providers: ScriptedProvider[] = [];
  const worker = createWorker({
    auth: memory.auth,
    registry,
    provider: () => {
      const provider = typeof scripts === "function" ? scripts() : new ScriptedProvider(scripts);
      providers.push(provider);
      return provider;
    },
  });
  const token = (principalId: string, kind: string, chain: string[], scopes: string[]) =>
    memory.issue({ principalId, kind, chain: chain.map((id, i) => ({ id, kind: i === 0 ? "human" : "agent_of_human" })), scopes } as never);
  const call = (path: string, token_?: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`${base}${path}`, { ...init, headers: { ...(token_ ? { authorization: `Bearer ${token_}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) } }));
  const post = (path: string, token_: string | undefined, body: unknown) => call(path, token_, { method: "POST", body: JSON.stringify(body) });
  return { memory, read, remove, registry, providers, worker, token, call, post };
}

const deleteTurns: ScriptedTurn[] = [{ toolCalls: [{ name: "notes_delete", input: { id: "n1" } }] }, { text: "The note is gone." }];

interface Event {
  event: string;
  data: any;
}
/** Reads server-sent events one at a time, so a test can act between two events. */
function events(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const read = async (): Promise<Event | undefined> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = /^event: (.*)$/m.exec(block)?.[1] ?? "";
        return { event: name, data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null") };
      }
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    read,
    until: async (name: string) => {
      for (;;) {
        const event = await read();
        if (event === undefined) throw new Error(`stream ended before "${name}"`);
        if (event.event === name) return event;
      }
    },
    all: async () => {
      const list: Event[] = [];
      for (let e = await read(); e !== undefined; e = await read()) list.push(e);
      return list;
    },
    cancel: () => reader.cancel(),
  };
}

describe("sign-in", () => {
  test("every route refuses a missing or bad key with 401", async () => {
    const w = world([{ text: "x" }]);
    const good = await w.token("agent:a", "agent_of_human", [ANA, "agent:a"], ["notes:read"]);
    for (const [method, path] of [["GET", "/tools"], ["POST", "/chat"], ["GET", "/approvals"], ["POST", "/approvals/x/approve"], ["POST", "/approvals/x/deny"]] as const) {
      for (const credential of [undefined, "nope", `${good}x`]) {
        const response = await w.call(path, credential, { method, ...(method === "POST" ? { body: "{}" } : {}) });
        expect(response.status, `${method} ${path} ${credential}`).toBe(401);
      }
    }
    expect(w.providers).toHaveLength(0);
  });

  test("an Auth that throws, or returns a context of the wrong shape, is a 401", async () => {
    const registry = new ToolRegistry();
    const make = (authenticate: () => Promise<unknown>) =>
      createWorker({ auth: { authenticate } as never, registry, provider: () => new ScriptedProvider([]) });
    const request = () => new Request(`${base}/tools`);
    expect((await make(async () => Promise.reject(new Error("db down"))).fetch(request())).status).toBe(401);
    for (const context of [
      { principalId: "a", kind: "wizard", chain: [{ id: "a", kind: "human" }], scopes: [] },
      { principalId: "a", kind: "human", chain: [], scopes: [] },
      { principalId: "a", kind: "human", chain: [{ id: "b", kind: "human" }], scopes: [] },
      { principalId: "a", kind: "human", chain: [{ id: "a", kind: "human" }], scopes: ["everything"] },
      { principalId: "a", kind: undefined, chain: [{ id: "a", kind: "human" }], scopes: [] },
    ]) {
      expect((await make(async () => context).fetch(request())).status, JSON.stringify(context)).toBe(401);
    }
  });
});

describe("tools", () => {
  test("lists only tools inside the caller's scopes, for a person and for an agent", async () => {
    const w = world([]);
    const person = await w.token(ANA, "human", [ANA], ["notes:write"]);
    const agent = await w.token("agent:a", "agent_of_human", [ANA, "agent:a"], ["notes:read"]);
    const names = async (t: string) => ((await (await w.call("/tools", t)).json()) as { tools: { name: string }[] }).tools.map((x) => x.name);
    expect(await names(person)).toEqual(["notes_read", "notes_delete"]);
    expect(await names(agent)).toEqual(["notes_read"]);
  });
});

describe("chat", () => {
  test("streams events in order and ends with done, labeled machine-made", async () => {
    const w = world([{ toolCalls: [{ name: "notes_read", input: { id: "n1" } }] }, { text: "The note says hello." }]);
    const token = await w.token(ANA, "human", [ANA], ["notes:read"]);
    const response = await w.post("/chat", token, { message: "read n1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const list = await events(response).all();
    const names = list.map((e) => e.event);
    expect(names[0]).toBe("run_start");
    expect(names.indexOf("tool_call")).toBeLessThan(names.indexOf("tool_result"));
    expect(names.indexOf("tool_result")).toBeLessThan(names.indexOf("text_delta"));
    expect(names.at(-1)).toBe("done");
    expect(list.at(-1)?.data).toMatchObject({ reason: "end_turn", actor: { machineMade: true, principalId: `assistant:${ANA}`, onBehalfOf: ANA } });
    expect(list.filter((e) => e.event === "text_delta").map((e) => e.data.text).join("")).toBe("The note says hello.");
    expect(w.read).toHaveBeenCalledOnce();
  });

  test("the assistant never holds more scopes than the caller: a tool outside them is refused", async () => {
    const w = world([{ toolCalls: [{ name: "mail_send", input: {} }] }, { text: "I could not." }]);
    const token = await w.token("agent:a", "agent_of_human", [ANA, "agent:a"], ["notes:read"]);
    const list = await events(await w.post("/chat", token, { message: "send mail" })).all();
    expect(list.find((e) => e.event === "tool_result")?.data).toMatchObject({ isError: true, denied: "scope" });
    expect(list.some((e) => e.event === "approval_request")).toBe(false);
    // The model was offered no tool outside the scopes.
    expect((w.providers[0]?.requests[0]?.tools ?? []).map((t) => t.name)).toEqual(["notes_read"]);
  });

  test("a bad body, a long message, and a wrong method are refused", async () => {
    const w = world([{ text: "x" }]);
    const token = await w.token(ANA, "human", [ANA], ["notes:read"]);
    expect((await w.call("/chat", token, { method: "POST", body: "not json" })).status).toBe(400);
    expect((await w.post("/chat", token, { message: "" })).status).toBe(400);
    expect((await w.post("/chat", token, { message: 5 })).status).toBe(400);
    expect((await w.post("/chat", token, { message: "x".repeat(10_001) })).status).toBe(400);
    expect((await w.call("/chat", token)).status).toBe(405);
    expect((await w.call("/tools", token, { method: "POST", body: "{}" })).status).toBe(405);
    expect((await w.call("/nowhere", token)).status).toBe(404);
    expect(w.providers).toHaveLength(0);
  });

  test("a principal may run only a few turns at once", async () => {
    const hang = () => ({ stream: () => new Promise<never>(() => undefined), name: "hang", model: "hang-1" }) as never;
    const w = world(hang);
    const token = await w.token(ANA, "human", [ANA], ["notes:read"]);
    const open = [];
    for (let i = 0; i < 4; i++) open.push(events(await w.post("/chat", token, { message: "go" })));
    // Each stream only starts to run when it is read.
    await Promise.race([Promise.all(open.map((e) => e.read())), new Promise((r) => setTimeout(r, 50))]);
    expect((await w.post("/chat", token, { message: "go" })).status).toBe(429);
    for (const e of open) await e.cancel();
    expect((await w.post("/chat", token, { message: "go" })).status).toBe(200);
  });
});

describe("approvals", () => {
  async function pendingRun(callerKind: "human" | "agent" = "agent") {
    const w = world(deleteTurns);
    const ana = await w.token(ANA, "human", [ANA], ["notes:write", "assistant:admin"]);
    // The proposing agent holds the approver scope, so only the rule against self-decision stops it.
    const agent = await w.token("agent:a", "agent_of_human", [ANA, "agent:a"], ["notes:write", "assistant:admin"]);
    const caller = callerKind === "agent" ? agent : ana;
    const stream = events(await w.post("/chat", caller, { message: "delete n1" }));
    const request = (await stream.until("approval_request")).data.request as { id: string; digest: string };
    return { w, ana, agent, stream, request, caller };
  }
  const decide = (w: ReturnType<typeof world>, id: string, verb: "approve" | "deny", token: string, body: unknown = {}) => w.post(`/approvals/${id}/${verb}`, token, body);

  test("the tool does not run while the call waits, and runs after the person approves", async () => {
    const { w, ana, stream, request } = await pendingRun();
    await new Promise((r) => setTimeout(r, 20));
    expect(w.remove).not.toHaveBeenCalled();
    const response = await decide(w, request.id, "approve", ana, { digest: request.digest });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ approved: true, decidedBy: ANA, machineMade: false });
    const rest = await stream.all();
    expect(rest.find((e) => e.event === "approval_decision")?.data).toMatchObject({ approved: true, decidedBy: ANA });
    expect(rest.at(-1)?.data.reason).toBe("end_turn");
    expect(w.remove).toHaveBeenCalledOnce();
  });

  test("an agent cannot approve or reject the call it proposed, and the call stays pending", async () => {
    const { w, agent, ana, stream, request } = await pendingRun();
    for (const verb of ["approve", "deny"] as const) {
      const response = await decide(w, request.id, verb, agent, { digest: request.digest });
      expect(response.status, verb).toBe(403);
    }
    expect(w.remove).not.toHaveBeenCalled();
    const listed = (await (await w.call("/approvals", agent)).json()) as { approvals: { id: string; canDecide: boolean }[] };
    expect(listed.approvals).toMatchObject([{ id: request.id, canDecide: false }]);
    // A different principal, the person, can still decide.
    expect((await decide(w, request.id, "approve", ana, { digest: request.digest })).status).toBe(200);
    expect((await stream.all()).at(-1)?.data.reason).toBe("end_turn");
    expect(w.remove).toHaveBeenCalledOnce();
  });

  test("another agent that holds the approver scope may decide, one without it may not", async () => {
    const { w, request, stream } = await pendingRun();
    const plain = await w.token("agent:b", "agent_of_human", [ANA, "agent:b"], ["notes:write"]);
    const admin = await w.token("agent:c", "agent_of_human", [ANA, "agent:c"], ["notes:write", "assistant:admin"]);
    const noToolScope = await w.token("agent:d", "agent_of_human", [ANA, "agent:d"], ["notes:read", "assistant:admin"]);
    expect((await decide(w, request.id, "approve", plain, { digest: request.digest })).status).toBe(403);
    expect((await decide(w, request.id, "approve", noToolScope, { digest: request.digest })).status).toBe(403);
    expect(w.remove).not.toHaveBeenCalled();
    const response = await decide(w, request.id, "approve", admin, { digest: request.digest });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ decidedBy: "agent:c", machineMade: true });
    await stream.all();
    expect(w.remove).toHaveBeenCalledOnce();
  });

  test("a principal of another owner cannot see or decide the call", async () => {
    const { w, request, stream, ana } = await pendingRun();
    const bob = await w.token(BOB, "human", [BOB], ["notes:write", "assistant:admin"]);
    expect((await decide(w, request.id, "approve", bob, { digest: request.digest })).status).toBe(404);
    expect((await decide(w, request.id, "deny", bob)).status).toBe(404);
    expect(((await (await w.call("/approvals", bob)).json()) as { approvals: unknown[] }).approvals).toEqual([]);
    expect(w.remove).not.toHaveBeenCalled();
    await decide(w, request.id, "deny", ana);
    await stream.all();
  });

  test("a wrong digest is refused, and a call is decided once", async () => {
    const { w, ana, request, stream } = await pendingRun();
    expect((await decide(w, request.id, "approve", ana, { digest: "0".repeat(64) })).status).toBe(409);
    expect((await decide(w, request.id, "approve", ana, {})).status).toBe(409);
    expect(w.remove).not.toHaveBeenCalled();
    expect((await decide(w, request.id, "approve", ana, { digest: request.digest })).status).toBe(200);
    expect((await decide(w, request.id, "approve", ana, { digest: request.digest })).status).toBe(404);
    await stream.all();
    expect(w.remove).toHaveBeenCalledOnce();
  });

  test("a no is final: the tool never runs and the model is told it was denied", async () => {
    const { w, ana, request, stream } = await pendingRun();
    const response = await decide(w, request.id, "deny", ana, { reason: "not this note" });
    expect(await response.json()).toMatchObject({ approved: false, decidedBy: ANA });
    const rest = await stream.all();
    expect(rest.find((e) => e.event === "approval_decision")?.data).toMatchObject({ approved: false, declined: true });
    expect(rest.find((e) => e.event === "tool_result")?.data).toMatchObject({ denied: "approval", isError: true });
    expect(w.remove).not.toHaveBeenCalled();
  });

  test("a person who asked for the turn may approve it, because the assistant is the one that proposed it", async () => {
    const { w, ana, request, stream } = await pendingRun("human");
    const response = await decide(w, request.id, "approve", ana, { digest: request.digest });
    expect(response.status).toBe(200);
    await stream.all();
    expect(w.remove).toHaveBeenCalledOnce();
  });

  test("an agent without the approver scope cannot decide a call from a person's turn", async () => {
    const { w, request, stream, ana } = await pendingRun("human");
    const agent = await w.token("agent:z", "agent_of_human", [ANA, "agent:z"], ["notes:write"]);
    expect((await decide(w, request.id, "approve", agent, { digest: request.digest })).status).toBe(403);
    await decide(w, request.id, "deny", ana);
    await stream.all();
  });

  test("a client that hangs up stops the run and leaves no pending call", async () => {
    const { w, ana, request, stream } = await pendingRun();
    await stream.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(((await (await w.call("/approvals", ana)).json()) as { approvals: unknown[] }).approvals).toEqual([]);
    expect((await decide(w, request.id, "approve", ana, { digest: request.digest })).status).toBe(404);
    expect(w.remove).not.toHaveBeenCalled();
  });

  test("a key revoked while the call waits stops the run before the tool runs", async () => {
    const { w, ana, agent, request, stream } = await pendingRun();
    await w.memory.revoke(agent);
    await decide(w, request.id, "approve", ana, { digest: request.digest });
    const rest = await stream.all();
    expect(rest.at(-1)?.data.reason).toBe("principal_inactive");
    expect(w.remove).not.toHaveBeenCalled();
  });
});
