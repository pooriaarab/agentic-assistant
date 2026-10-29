import { createMemoryAuth } from "agentic-identity";
import { describe, expect, test } from "vitest";
import { AssistantApiError, createClient, type ChatEvent } from "./client.js";
import { ToolRegistry } from "./index.js";
import { createStaticTokenAuth } from "./static-auth.js";
import { ScriptedProvider, type ScriptedTurn } from "./testing.js";
import { createWorker } from "./worker.js";

// Ways the client can fail. Each one is a case below. The server is the real Worker, called with no network.
// 1. A route has the wrong path, method, or body, so the real handler answers 404, 405, or 400.
// 2. The token is not sent, or it goes to another host through a redirect.
// 3. An error reply becomes a success, or loses its status, code, message, or retry-after.
// 4. A 200 reply of the wrong shape (a proxy, a wrong baseUrl) is returned as data.
// 5. The chat stream drops, splits, or reorders events, or breaks when a chunk cuts an event.
// 6. A stream that ends with an error event, or a bad event, is read as success.
// 7. An id with "..", "/" or "%" reaches another route.
// 8. A bad baseUrl or token is accepted. The fetch option is ignored, or called with the wrong `this`.
// 9. Stopping the read or aborting the signal leaves the run on the server.

const TOKEN = "k".repeat(40);
const OTHER = "o".repeat(40);

async function world(turns: ScriptedTurn[]) {
  const auth = await createStaticTokenAuth({
    [TOKEN]: { id: "ana", scopes: ["notes:read", "notes:write"] },
    [OTHER]: { id: "bob", scopes: ["notes:read", "notes:write"] },
  });
  const registry = new ToolRegistry()
    .register({ name: "notes_read", description: "Read a note", inputSchema: { type: "object" }, scope: "notes:read", risk: "safe", handler: async () => ({ note: "hello" }) })
    .register({ name: "notes_delete", description: "Delete a note", inputSchema: { type: "object" }, scope: "notes:write", risk: "risky", handler: async () => "deleted" });
  const worker = createWorker({ auth, registry, provider: () => new ScriptedProvider(turns) });
  const seen: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as string, init);
    seen.push(request);
    return worker.fetch(request);
  };
  const make = (token = TOKEN) => createClient({ baseUrl: "https://assistant.test", token, fetch: fetchImpl });
  return { worker, seen, make, client: make() };
}

const collect = async (stream: AsyncGenerator<ChatEvent>) => {
  const list: ChatEvent[] = [];
  for await (const event of stream) list.push(event);
  return list;
};
const fails = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AssistantApiError);
    return error as AssistantApiError;
  }
  throw new Error("the call did not fail");
};
const replying = (response: () => Response) => createClient({ baseUrl: "https://assistant.test", token: TOKEN, fetch: async () => response() });

describe("routes", () => {
  test("health, tools, and approvals reach the real handler with the token", async () => {
    const { client, seen } = await world([]);
    expect(await client.health()).toMatchObject({ ok: true });
    expect((await client.tools()).map((t) => [t.name, t.risk])).toEqual([["notes_read", "safe"], ["notes_delete", "risky"]]);
    expect(await client.approvals()).toEqual([]);
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["GET /health", "GET /api/v1/tools", "GET /api/v1/approvals"]);
    expect(seen[1]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("chat yields every event in order and ends with done", async () => {
    const { client } = await world([{ toolCalls: [{ name: "notes_read", input: {} }] }, { text: "It says hello." }]);
    const events = await collect(client.chat("read my note"));
    expect(events[0]?.type).toBe("run_start");
    expect(events.map((e) => e.type)).toContain("tool_result");
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("It says hello.");
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "end_turn" });
  });

  test("approve and deny reach a pending call, and a wrong digest is a conflict", async () => {
    const { client, make } = await world([{ toolCalls: [{ name: "notes_delete", input: { id: "n1" } }] }, { text: "Gone." }, { toolCalls: [{ name: "notes_delete", input: { id: "n2" } }] }, { text: "Kept." }]);
    const stream = client.chat("delete n1");
    const seen: ChatEvent[] = [];
    const reading = (async () => {
      for await (const event of stream) seen.push(event);
    })();
    const waitPending = async () => {
      for (let i = 0; i < 200; i++) {
        const list = await client.approvals();
        if (list[0] !== undefined) return list[0];
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("no pending call");
    };
    const first = await waitPending();
    expect(first).toMatchObject({ tool: "notes_delete", canDecide: true, requestedBy: "ana" });
    // Another owner sees nothing, and cannot decide.
    expect(await make(OTHER).approvals()).toEqual([]);
    expect((await fails(make(OTHER).approve(first.id, first.digest))).code).toBe("NOT_FOUND");
    const wrong = await fails(client.approve(first.id, "bad"));
    expect([wrong.code, wrong.status]).toEqual(["CONFLICT", 409]);
    expect(await client.approve(first.id, first.digest)).toMatchObject({ requestId: first.id, approved: true, decidedBy: "ana", machineMade: false });
    await reading;
    expect(seen.at(-1)).toMatchObject({ type: "done", reason: "end_turn" });
    expect(seen.find((e) => e.type === "tool_result")).toMatchObject({ content: expect.stringContaining("deleted") });
    expect((await fails(client.approve(first.id, first.digest))).code).toBe("NOT_FOUND");
  });

  test("deny stops the call", async () => {
    const { client } = await world([{ toolCalls: [{ name: "notes_delete", input: {} }] }, { text: "Kept." }]);
    const reading = collect(client.chat("delete"));
    let pending;
    for (let i = 0; i < 200 && pending === undefined; i++) {
      pending = (await client.approvals())[0];
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await client.deny(pending!.id, "no")).toMatchObject({ approved: false });
    const events = await reading;
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ denied: "approval" });
  });
});

describe("errors", () => {
  test("a bad or missing token is UNAUTHENTICATED with the status", async () => {
    const { make } = await world([]);
    const error = await fails(make("x".repeat(40)).tools());
    expect([error.code, error.status, error.message]).toEqual(["UNAUTHENTICATED", 401, "sign in with a valid key"]);
    expect((await fails(collect(make("x".repeat(40)).chat("hi")))).code).toBe("UNAUTHENTICATED");
  });

  test("a bad message is INVALID_INPUT", async () => {
    const { client } = await world([]);
    expect((await fails(collect(client.chat("  ")))).code).toBe("INVALID_INPUT");
    expect((await fails(collect(client.chat("x".repeat(10_001))))).status).toBe(400);
  });

  test("429 keeps retry-after", async () => {
    const error = await fails(replying(() => Response.json({ error: "too many chat turns at once" }, { status: 429, headers: { "retry-after": "5" } })).tools());
    expect([error.code, error.retryAfter]).toEqual(["RATE_LIMITED", 5]);
  });

  test("503 not_configured from the demo Worker", async () => {
    const error = await fails(collect(replying(() => Response.json({ error: "not_configured", message: "no model key" }, { status: 503 })).chat("hi")));
    expect([error.code, error.status, error.message]).toEqual(["NOT_CONFIGURED", 503, "no model key"]);
  });

  test("a reply that is not from this API is UNKNOWN or INTERNAL, never a success", async () => {
    expect((await fails(replying(() => new Response("<html>", { status: 502 })).tools())).code).toBe("INTERNAL");
    expect((await fails(replying(() => new Response("nope", { status: 418 })).tools())).code).toBe("UNKNOWN");
    expect((await fails(replying(() => new Response("", { status: 302, headers: { location: "https://evil.test" } })).tools())).code).toBe("UNKNOWN");
  });

  test("a 200 reply of the wrong shape fails", async () => {
    for (const body of [{}, [], { tools: "x" }, { tools: [{ name: 1 }] }, null]) {
      expect((await fails(replying(() => Response.json(body)).tools())).code).toBe("UNKNOWN");
    }
    expect((await fails(replying(() => new Response("not json")).approvals())).code).toBe("UNKNOWN");
    expect((await fails(replying(() => Response.json({ ok: true })).approve("a", "d"))).code).toBe("UNKNOWN");
    expect((await fails(replying(() => Response.json({ ok: true })).health())).code).toBe("UNKNOWN");
  });
});

describe("chat stream", () => {
  const sse = (chunks: string[], type = "text/event-stream") =>
    replying(() => new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); } }), { headers: { "content-type": type } }));
  const done = `event: done\ndata: {"type":"done","reason":"end_turn"}\n\n`;

  test("an event cut across chunks, and CRLF line ends, still parse", async () => {
    const events = await collect(sse([`event: text_delta\ndata: {"type":"text_`, `delta","text":"hi"}\n`, `\n`, done.replace(/\n/g, "\r\n")]).chat("x"));
    expect(events).toEqual([{ type: "text_delta", text: "hi" }, { type: "done", reason: "end_turn" }]);
  });

  test("an error event is passed on as an event", async () => {
    const events = await collect(sse([`event: error\ndata: {"type":"error","error":"the run failed"}\n\n`]).chat("x"));
    expect(events).toEqual([{ type: "error", error: "the run failed" }]);
  });

  test("a bad event, a wrong content type, and a huge event fail", async () => {
    expect((await fails(collect(sse([`data: not json\n\n`]).chat("x")))).code).toBe("UNKNOWN");
    expect((await fails(collect(sse([`data: [1]\n\n`]).chat("x")))).code).toBe("UNKNOWN");
    expect((await fails(collect(sse([done], "application/json").chat("x")))).code).toBe("UNKNOWN");
    expect((await fails(collect(sse(["data: " + "a".repeat(5_000_000)]).chat("x")))).message).toMatch(/too long/);
  });

  test("stopping the read cancels the stream", async () => {
    let cancelled = false;
    const client = replying(
      () => new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode(`data: {"type":"turn_start","turn":1}\n\n`)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }),
    );
    for await (const event of client.chat("x")) {
      expect(event.type).toBe("turn_start");
      break;
    }
    expect(cancelled).toBe(true);
  });

  test("an aborted signal ends the call and clears the pending call", async () => {
    const { client } = await world([{ toolCalls: [{ name: "notes_delete", input: {} }] }, { text: "x" }]);
    const abort = new AbortController();
    const reading = collect(client.chat("delete", { signal: abort.signal }));
    for (let i = 0; i < 200 && (await client.approvals()).length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    abort.abort(new Error("stop"));
    // The real handler sees the abort too, so the stream may end with a "done" of reason "aborted" before the client throws.
    const outcome = await reading.then((events) => events.at(-1), (error: Error) => error.message);
    expect(outcome === "stop" || (outcome as ChatEvent).type === "done").toBe(true);
    for (let i = 0; i < 200 && (await client.approvals()).length > 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await client.approvals()).toEqual([]);
  });
});

describe("options and inputs", () => {
  test("redirects are not followed", async () => {
    let init: RequestInit | undefined;
    const client = createClient({ baseUrl: "https://assistant.test", token: TOKEN, fetch: async (_i, i) => ((init = i), Response.json({ tools: [] })) });
    await client.tools();
    expect(init?.redirect).toBe("manual");
  });

  test("an id cannot reach another route", async () => {
    const { client, seen } = await world([]);
    for (const id of ["", ".", "..", "%2e%2E"]) await expect(client.approve(id, "d")).rejects.toThrow(TypeError);
    await expect(client.deny("a/b")).rejects.toThrow(/Not found|no pending|not found|NOT_FOUND/i);
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual(["/api/v1/approvals/a%2Fb/deny"]);
  });

  test("a bad baseUrl or token is refused, and a path prefix is kept", async () => {
    for (const baseUrl of ["", "nope", "ftp://a.test", "https://a.test?x=1", "https://a.test#x", "https://u:p@a.test"]) {
      expect(() => createClient({ baseUrl, token: TOKEN })).toThrow(TypeError);
    }
    expect(() => createClient({ baseUrl: "https://a.test", token: "" })).toThrow(TypeError);
    const urls: string[] = [];
    const client = createClient({ baseUrl: "https://a.test/pack/", token: TOKEN, fetch: async (input) => (urls.push(input as string), Response.json({ tools: [] })) });
    await client.tools();
    expect(urls).toEqual(["https://a.test/pack/api/v1/tools"]);
  });

  test("a client from createMemoryAuth keys works too", async () => {
    const memory = createMemoryAuth();
    const key = memory.issue({ principalId: "human:ana", kind: "human", chain: [{ id: "human:ana", kind: "human" }], scopes: ["notes:read"] } as never);
    const worker = createWorker({ auth: memory.auth, registry: new ToolRegistry(), provider: () => new ScriptedProvider([]) });
    const client = createClient({ baseUrl: "https://assistant.test", token: await key, fetch: (i, init) => worker.fetch(new Request(i as string, init)) });
    expect(await client.tools()).toEqual([]);
  });
});
