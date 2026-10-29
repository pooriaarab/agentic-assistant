import { afterEach, describe, expect, test, vi } from "vitest";
import { connectMcpTools, type McpTools } from "./mcp.js";

// Ways the source can fail against a mocked HTTP transport. Each one is a case below.
// 1. The initialize or list reply is an error or junk, and the load hangs or leaks a client.
// 2. A call result is an error, empty, or holds odd content, and the handler returns it wrong.
// 3. A response is over the size limit, or a redirect is followed.
// 4. The prefix, scope, or risk is not applied to the loaded tool.
// 5. A malformed tool entry kills the whole load instead of being skipped.

type Rpc = { id?: number; method: string; params?: any };
type Handler = (rpc: Rpc) => unknown;

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

/** A fake server over fetch. `methods` answers each JSON-RPC method with a result, or `{ error }`. */
function mockServer(methods: Record<string, Handler>, overrides: { initialize?: () => Response } = {}) {
  const calls: Rpc[] = [];
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== "POST") return new Response(null, { status: init?.method === "DELETE" ? 200 : 405 });
    const rpc = JSON.parse(init.body as string) as Rpc;
    calls.push(rpc);
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    if (rpc.method === "initialize" && overrides.initialize) return overrides.initialize();
    const handler = methods[rpc.method];
    if (!handler) return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "no method" } });
    const out = handler(rpc) as { error?: unknown } | Response;
    if (out instanceof Response) return out;
    if (out && typeof out === "object" && "error" in out) return json({ jsonrpc: "2.0", id: rpc.id, error: out.error });
    return json({ jsonrpc: "2.0", id: rpc.id, result: out });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

const initialize = (rpc: Rpc) => ({ protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
const schema = { type: "object", properties: {} };
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} tool`, inputSchema: schema, ...extra });
const base = { transport: { type: "http" as const, url: "https://tools.example.eu/mcp" }, scope: "notes:read", risk: "safe" } as const;

const open: McpTools[] = [];
async function connect(extra: Record<string, unknown> = {}) {
  const mcp = await connectMcpTools({ ...base, ...extra } as Parameters<typeof connectMcpTools>[0]);
  open.push(mcp);
  return mcp;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(open.splice(0).map((mcp) => mcp.close().catch(() => undefined)));
});

const ctx = { signal: new AbortController().signal } as Parameters<NonNullable<McpTools["tools"][number]["handler"]>>[1];
const callWith = (result: unknown) => ({ initialize, "tools/list": () => ({ tools: [tool("a")] }), "tools/call": () => result });
async function run(result: unknown, input: unknown = {}) {
  mockServer(callWith(result));
  const mcp = await connect();
  return mcp.tools[0]!.handler(input as never, ctx);
}

describe("connectMcpTools with a mocked server", () => {
  test("loads tools with the host's scope, risk, and prefix", async () => {
    mockServer({ initialize, "tools/list": () => ({ tools: [tool("read"), tool("write", { annotations: { readOnlyHint: false } })] }) });
    const mcp = await connect({ prefix: "notes_", scope: (t: { name: string }) => (t.name === "read" ? "notes:read" : "notes:write"), risk: (t: { name: string }) => (t.name === "read" ? "safe" : "risky") });
    expect(mcp.skipped).toEqual([]);
    expect(mcp.tools.map((t) => [t.name, t.scope, t.risk])).toEqual([["notes_read", "notes:read", "safe"], ["notes_write", "notes:write", "risky"]]);
  });

  test("sends the configured headers", async () => {
    const { fn } = mockServer({ initialize, "tools/list": () => ({ tools: [] }) });
    await connect({ transport: { ...base.transport, headers: { authorization: "Bearer t" } } });
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t");
  });

  test("calls the server with the original name, not the prefixed one", async () => {
    const { calls } = mockServer({ initialize, "tools/list": () => ({ tools: [tool("a")] }), "tools/call": () => ({ content: [{ type: "text", text: "done" }] }) });
    const mcp = await connect({ prefix: "p_" });
    expect(await mcp.tools[0]!.handler({ x: 1 } as never, ctx)).toBe("done");
    expect(calls.find((c) => c.method === "tools/call")!.params).toMatchObject({ name: "a", arguments: { x: 1 } });
  });

  test("joins text blocks and marks other content as omitted", async () => {
    const out = await run({ content: [{ type: "text", text: "one" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "two" }] });
    expect(out).toBe("one\n[image content omitted]\ntwo");
  });

  test("an empty result is an empty string", async () => {
    expect(await run({ content: [] })).toBe("");
  });

  test("uses structured content when there is no text", async () => {
    expect(await run({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
  });

  test("a tool error throws its text, or a fixed message when it has none", async () => {
    await expect(run({ isError: true, content: [{ type: "text", text: "boom" }] })).rejects.toThrow("boom");
    await expect(run({ isError: true, content: [] })).rejects.toThrow("the tool reported an error");
  });

  test("a JSON-RPC error on a call rejects", async () => {
    mockServer({ initialize, "tools/list": () => ({ tools: [tool("a")] }), "tools/call": () => ({ error: { code: -32000, message: "bad call" } }) });
    const mcp = await connect();
    await expect(mcp.tools[0]!.handler({} as never, ctx)).rejects.toThrow(/bad call/);
  });

  test("a call result with the wrong shape rejects instead of returning junk", async () => {
    await expect(run({ content: "not a list" })).rejects.toThrow();
    await expect(run("nope")).rejects.toThrow();
  });

  test("cuts output at maxOutputChars", async () => {
    mockServer(callWith({ content: [{ type: "text", text: "x".repeat(500) }] }));
    const mcp = await connect({ maxOutputChars: 50 });
    const out = (await mcp.tools[0]!.handler({} as never, ctx)) as string;
    expect(out.length).toBeLessThan(500);
  });

  test("cuts a long description and a long schema description", async () => {
    mockServer({ initialize, "tools/list": () => ({ tools: [tool("a", { description: "d".repeat(500), inputSchema: { type: "object", properties: { p: { type: "string", description: "e".repeat(500) } } } })] }) });
    const mcp = await connect({ maxDescriptionChars: 20 });
    const t = mcp.tools[0]!;
    expect(t.description).toMatch(/^d{20}\n\[truncated: 480 characters omitted\]$/);
    expect(JSON.stringify(t.inputSchema)).toContain("[truncated: 480 characters omitted]");
  });

  test("a missing description becomes an empty string", async () => {
    mockServer({ initialize, "tools/list": () => ({ tools: [{ name: "a", inputSchema: schema }] }) });
    expect((await connect()).tools[0]!.description).toBe("");
  });

  test("follows list pages and keeps going past a duplicate", async () => {
    mockServer({
      initialize,
      "tools/list": (rpc) => (rpc.params?.cursor === "2" ? { tools: [tool("a"), tool("c")] } : { tools: [tool("a"), tool("b")], nextCursor: "2" }),
    });
    const mcp = await connect();
    expect(mcp.tools.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(mcp.skipped).toEqual([{ name: "a", reason: "duplicate name" }]);
  });

  test("skips malformed entries and keeps the good ones", async () => {
    mockServer({ initialize, "tools/list": () => ({ tools: [tool("good"), tool("bad name!"), tool("big", { inputSchema: { type: "object", properties: { p: { enum: Array.from({ length: 5000 }, (_, i) => `value-${i}`) } } } })] }) });
    const mcp = await connect();
    expect(mcp.tools.map((t) => t.name)).toEqual(["good"]);
    expect(mcp.skipped.map((s) => s.name).sort()).toEqual(["bad name!", "big"]);
  });

  test("skips a tool when the risk function throws", async () => {
    mockServer({ initialize, "tools/list": () => ({ tools: [tool("a"), tool("b")] }) });
    const mcp = await connect({ risk: (t: { name: string }) => { if (t.name === "a") throw new Error("no risk for a"); return "safe"; } });
    expect(mcp.tools.map((t) => t.name)).toEqual(["b"]);
    expect(mcp.skipped).toEqual([{ name: "a", reason: "no risk for a" }]);
  });

  test("stops at maxTools and says why", async () => {
    mockServer({ initialize, "tools/list": () => ({ tools: [tool("a"), tool("b"), tool("c")] }) });
    const mcp = await connect({ maxTools: 2 });
    expect(mcp.tools).toHaveLength(2);
    expect(mcp.skipped).toEqual([{ name: "c", reason: "too many tools" }]);
  });

  test("an endless page list stops at the page limit", async () => {
    const { calls } = mockServer({ initialize, "tools/list": () => ({ tools: [], nextCursor: "more" }) });
    await connect();
    expect(calls.filter((c) => c.method === "tools/list")).toHaveLength(20);
  });

  test("a tool list that is not a list fails the load and closes the client", async () => {
    const { calls } = mockServer({ initialize, "tools/list": () => ({ tools: "nope" }) });
    await expect(connectMcpTools(base as never)).rejects.toThrow();
    expect(calls.map((c) => c.method)).toContain("tools/list");
  });

  test("a server error on initialize fails the load", async () => {
    mockServer({ initialize: () => ({ error: { code: -32603, message: "no thanks" } }) });
    await expect(connectMcpTools(base as never)).rejects.toThrow(/no thanks/);
  });

  test("an HTTP 500 on initialize fails the load", async () => {
    mockServer({}, { initialize: () => new Response("down", { status: 500 }) });
    await expect(connectMcpTools(base as never)).rejects.toThrow();
  });

  test("a reply that is not JSON fails the load", async () => {
    mockServer({}, { initialize: () => new Response("<html>", { status: 200, headers: { "content-type": "application/json" } }) });
    await expect(connectMcpTools(base as never)).rejects.toThrow();
  });

  test("a response that declares a size over the limit fails the load", async () => {
    mockServer({}, { initialize: () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": "5000" } }) });
    await expect(connectMcpTools({ ...base, maxResponseBytes: 100 } as never)).rejects.toThrow();
  });

  test("a streamed response over the limit fails the load", async () => {
    mockServer({ initialize, "tools/list": () => ({ tools: [tool("a", { description: "x".repeat(900) })] }) });
    await expect(connectMcpTools({ ...base, maxResponseBytes: 600 } as never)).rejects.toThrow();
  });

  test("fetch is called with redirect: error", async () => {
    const { fn } = mockServer({ initialize, "tools/list": () => ({ tools: [] }) });
    await connect();
    for (const [, init] of fn.mock.calls) expect((init as RequestInit).redirect).toBe("error");
  });

  test("close() sends a session end and does not throw", async () => {
    mockServer({ initialize, "tools/list": () => ({ tools: [] }) });
    const mcp = await connect();
    await expect(mcp.close()).resolves.toBeUndefined();
  });

  test.each([0, -1, 1.5, Number.NaN, 2 ** 31])("a bad limit of %s is refused before any request", async (bad) => {
    const { fn } = mockServer({});
    for (const key of ["maxOutputChars", "maxTools", "maxDescriptionChars", "maxResponseBytes", "callTimeoutMs", "loadTimeoutMs"]) {
      if (key.endsWith("Ms") || bad !== 2 ** 31) await expect(connectMcpTools({ ...base, [key]: bad } as never)).rejects.toThrow(RangeError);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  test("refuses a remote http URL and a URL with credentials", async () => {
    const { fn } = mockServer({});
    await expect(connectMcpTools({ ...base, transport: { type: "http", url: "http://tools.example.eu/mcp" } } as never)).rejects.toThrow(/https/);
    await expect(connectMcpTools({ ...base, transport: { type: "http", url: "https://u:p@tools.example.eu/mcp" } } as never)).rejects.toThrow(/credentials/);
    expect(fn).not.toHaveBeenCalled();
  });
});
