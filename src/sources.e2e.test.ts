import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { createNotesServer } from "../test-fixtures/notes-server.mjs";
import {
  QueueApprovalGate,
  ToolRegistry,
  connectMcpTools,
  createPrincipal,
  runAssistant,
  type AssistantEvent,
  type McpTools,
  type Scope,
} from "./index.js";
import { ScriptedProvider, type ScriptedTurn } from "./testing.js";

// Ways a tool source can fail. Each one is a case below.
// 1. A tool with a bad name or schema is loaded, or its failure kills the whole load.
// 2. The host's scope mapping is ignored, so a write tool runs for a read-only principal.
// 3. Bad input reaches the server. A counter on the server proves it did not.
// 4. A huge tool output reaches the model uncut.
// 5. A tool error leaks its text (a secret) to the model.
// 6. Tool output that holds instructions or a forged tag breaks out of its quote.
// 7. Non-text content (an image) is passed through as raw data.
// 8. A plain-HTTP remote server, or a URL with a password, is accepted.
// 9. The scope function throws and takes the whole load with it.
// 10. A schema holds a regular expression that can freeze the host, or text that is far too long.
// 11. A server sends an endless page list, a huge body, or never answers, and the load hangs or runs out of memory.
// 12. A limit is NaN, zero, or negative and turns its guard off.
// 13. A slow tool call is never cut off, or close() leaves the child process running.
// 14. A duplicate tool name is loaded twice.

const SAFE = { risk: "safe" as const };
const STDIO = { type: "stdio" as const, command: process.execPath, args: [new URL("../test-fixtures/notes-stdio.mjs", import.meta.url).pathname] };
const readOnlyScope = (tool: { annotations?: { readOnlyHint?: boolean } }): Scope => (tool.annotations?.readOnlyHint ? "notes:read" : "notes:write");

const open: McpTools[] = [];
let httpServer: Server | undefined;
afterEach(async () => {
  await Promise.all(open.splice(0).map((m) => m.close()));
  httpServer?.closeAllConnections();
  await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
  httpServer = undefined;
});

async function connect(options: Parameters<typeof connectMcpTools>[0]): Promise<McpTools> {
  const connected = await connectMcpTools(options);
  open.push(connected);
  return connected;
}

async function runWith(mcp: McpTools, scopes: Scope[], script: ScriptedTurn[]) {
  const registry = new ToolRegistry().registerAll(mcp.tools);
  const provider = new ScriptedProvider(script);
  const events: AssistantEvent[] = [];
  for await (const event of runAssistant({
    provider,
    registry,
    principal: createPrincipal({ id: "a", kind: "agent_of_human", parentId: "h", scopes }),
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  })) events.push(event);
  const results = events.filter((e): e is Extract<AssistantEvent, { type: "tool_result" }> => e.type === "tool_result");
  return { events, results, provider };
}

const call = (name: string, input: unknown): ScriptedTurn => ({ toolCalls: [{ name, input }] });

describe("MCP over stdio", () => {
  test("loads the good tools and skips the bad ones with a reason", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope, prefix: "n_" });
    expect(mcp.tools.map((t) => t.name).sort()).toEqual([
      "n_big", "n_boom", "n_examples_prop", "n_img", "n_long_text", "n_notes_read", "n_notes_write", "n_pid", "n_slow", "n_stats", "n_structured",
    ]);
    expect(mcp.skipped.map((s) => s.name).sort()).toEqual(["bad name!", "bad_schema", "evil\u001b[2Jname", "huge_schema", "with_pattern"]);
    expect(mcp.skipped.find((s) => s.name === "bad name!")?.reason).toMatch(/invalid tool name/);
    expect(mcp.skipped.find((s) => s.name === "bad_schema")?.reason).toMatch(/invalid input schema/);
  });

  test("runs a tool through the loop and quotes its output", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    const { results, provider } = await runWith(mcp, ["notes:read"], [call("notes_read", { id: "n1" }), { text: "done" }]);
    expect(results[0]).toMatchObject({ content: "note n1", isError: false, untrusted: true });
    expect(JSON.stringify(provider.requests[1]?.messages.at(-1))).toContain('<tool_output tool=\\"notes_read\\">\\nnote n1\\n</tool_output>');
  });

  test("uses the host's scope for each tool", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    const { results, provider } = await runWith(mcp, ["notes:read"], [call("notes_write", { id: "n1", text: "x" }), call("stats", {}), { text: "done" }]);
    expect(provider.requests[0]?.tools.map((t) => t.name)).not.toContain("notes_write");
    expect(results[0]).toMatchObject({ denied: "scope" });
    expect(JSON.parse(results[1]?.content ?? "{}")).not.toHaveProperty("notes_write");
  });

  test("bad input never reaches the server", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    const bad = [{}, { id: 5 }, { id: "a", extra: 1 }];
    const { results } = await runWith(mcp, ["notes:read"], [...bad.map((input) => call("notes_read", input)), call("stats", {}), { text: "done" }]);
    expect(results.slice(0, 3).map((r) => r.denied)).toEqual(["invalid_input", "invalid_input", "invalid_input"]);
    expect(JSON.parse(results[3]?.content ?? "{}")).not.toHaveProperty("notes_read");
  });

  test("cuts a huge output", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope, maxOutputChars: 1000 });
    const { results } = await runWith(mcp, ["notes:read"], [call("big", {}), { text: "done" }]);
    expect(results[0]?.content.length).toBeLessThan(1100);
    expect(results[0]?.content).toContain("[truncated: 99000 characters omitted]");
  });

  test("keeps a tool's error text away from the model", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    const { results, provider } = await runWith(mcp, ["notes:read"], [call("boom", {}), { text: "done" }]);
    expect(results[0]).toMatchObject({ isError: true, content: "tool failed", detail: expect.stringContaining("s3cr3t") });
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain("s3cr3t");
  });

  test("keeps injected instructions inside the quote", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    const { provider } = await runWith(mcp, ["notes:read"], [call("notes_read", { id: "inject" }), { text: "done" }]);
    const sent = JSON.stringify(provider.requests[1]?.messages.at(-1));
    expect(sent.match(/<\/tool_output>/g)).toHaveLength(1);
    expect(sent).toContain("&lt;/tool_output>");
    expect(sent.indexOf("IGNORE ALL PREVIOUS")).toBeLessThan(sent.indexOf("</tool_output>"));
  });

  test("leaves non-text content out", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    const { results } = await runWith(mcp, ["notes:read"], [call("img", {}), { text: "done" }]);
    expect(results[0]?.content).toBe("[image content omitted]\ncaption");
  });

  test("skips a tool when the scope function throws", async () => {
    const mcp = await connect({
...SAFE,
      transport: STDIO,
      scope: (tool) => {
        if (tool.name === "big") throw new Error("no scope for big");
        return "notes:read";
      },
    });
    expect(mcp.tools.map((t) => t.name)).not.toContain("big");
    expect(mcp.skipped.find((s) => s.name === "big")?.reason).toBe("no scope for big");
  });

  test("stops loading at maxTools", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: "notes:read", maxTools: 2 });
    expect(mcp.tools).toHaveLength(2);
    expect(mcp.skipped.some((s) => s.reason === "too many tools")).toBe(true);
  });

  test("refuses a scope that is not valid", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: "notes:delete" });
    expect(mcp.tools).toHaveLength(0);
    expect(mcp.skipped.every((s) => /invalid scope|invalid tool name|too large/.test(s.reason))).toBe(true);
  });

  test("skips a schema with a regular expression and a schema that is too large", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    expect(mcp.skipped.find((s) => s.name === "with_pattern")?.reason).toMatch(/regular expression/);
    expect(mcp.skipped.find((s) => s.name === "huge_schema")?.reason).toMatch(/too large/);
  });

  test("cuts long descriptions, in the tool and in its schema", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope, maxDescriptionChars: 100 });
    const tool = mcp.tools.find((t) => t.name === "long_text");
    expect(tool?.description.length).toBeLessThan(200);
    const schema = tool?.inputSchema as { properties: { id: { description: string } } };
    expect(schema.properties.id.description.length).toBeLessThan(200);
  });

  test.each([
    ["maxTools", { maxTools: Number.NaN }],
    ["maxOutputChars", { maxOutputChars: -1 }],
    ["maxDescriptionChars", { maxDescriptionChars: Number.NaN }],
    ["callTimeoutMs", { callTimeoutMs: 0 }],
    ["callTimeoutMs", { callTimeoutMs: 3_000_000_000 }],
    ["loadTimeoutMs", { loadTimeoutMs: 1.5 }],
    ["maxResponseBytes", { maxResponseBytes: 0 }],
  ])("a bad %s is refused before anything starts", async (name, limits) => {
    await expect(connectMcpTools({ ...SAFE, transport: { type: "stdio", command: "does-not-exist" }, scope: "notes:read", ...limits })).rejects.toThrow(new RegExp(`${name} must be a positive integer`));
  });

  test("keeps a property that is named examples", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    const schema = mcp.tools.find((t) => t.name === "examples_prop")?.inputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("examples");
    const { results } = await runWith(mcp, ["notes:read"], [call("examples_prop", { examples: [] }), { text: "done" }]);
    expect(results[0]).toMatchObject({ isError: false, content: "ok" });
  });

  test("cuts off a slow tool call", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope, callTimeoutMs: 300 });
    const started = Date.now();
    const { results } = await runWith(mcp, ["notes:read"], [call("slow", {}), { text: "done" }]);
    expect(results[0]).toMatchObject({ isError: true, content: "tool failed" });
    expect(Date.now() - started).toBeLessThan(1900);
  });

  test("reads structured content when there is no text", async () => {
    const mcp = await connect({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    const { results } = await runWith(mcp, ["notes:read"], [call("structured", {}), { text: "done" }]);
    expect(results[0]?.content).toBe('{"a":1}');
  });

  test("close() ends the server process", async () => {
    const mcp = await connectMcpTools({ ...SAFE, transport: STDIO, scope: readOnlyScope });
    const { results } = await runWith(mcp, ["notes:read"], [call("pid", {}), { text: "done" }]);
    const pid = Number(results[0]?.content);
    expect(pid).toBeGreaterThan(0);
    await mcp.close();
    const gone = async () => {
      for (let i = 0; i < 30; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    expect(await gone()).toBe(true);
  });
});

describe("MCP tools and approvals", () => {
  test("a write tool waits for a person, and the server is untouched until then", async () => {
    const mcp = await connect({ transport: STDIO, scope: "notes:write", risk: (tool) => (tool.name === "notes_write" ? "risky" : "safe") });
    const gate = new QueueApprovalGate();
    const registry = new ToolRegistry().registerAll(mcp.tools);
    const provider = new ScriptedProvider([call("notes_write", { id: "n1", text: "x" }), call("stats", {}), { text: "done" }]);
    const events: AssistantEvent[] = [];
    let statsBefore = "";
    for await (const event of runAssistant({
      provider,
      registry,
      approvals: gate,
      principal: createPrincipal({ id: "a", kind: "agent_of_human", parentId: "h", scopes: ["notes:write"] }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    })) {
      events.push(event);
      if (event.type === "approval_request") setTimeout(() => gate.approve(event.request.id, "h"), 0);
      if (event.type === "tool_result" && event.name === "stats") statsBefore = event.content;
    }
    expect(events.some((e) => e.type === "approval_request")).toBe(true);
    expect(JSON.parse(statsBefore)).toHaveProperty("notes_write", 1);
  });

  test("a declined write never reaches the server", async () => {
    const mcp = await connect({ transport: STDIO, scope: "notes:write", risk: (tool) => (tool.name === "notes_write" ? "risky" : "safe") });
    const gate = new QueueApprovalGate();
    const registry = new ToolRegistry().registerAll(mcp.tools);
    const provider = new ScriptedProvider([call("notes_write", { id: "n1" }), call("stats", {}), { text: "done" }]);
    let stats = "";
    for await (const event of runAssistant({
      provider,
      registry,
      approvals: gate,
      principal: createPrincipal({ id: "a", kind: "agent_of_human", parentId: "h", scopes: ["notes:write"] }),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    })) {
      if (event.type === "approval_request") setTimeout(() => gate.reject(event.request.id, "h"), 0);
      if (event.type === "tool_result" && event.name === "stats") stats = event.content;
    }
    expect(JSON.parse(stats)).not.toHaveProperty("notes_write");
  });

  test("a tool with no risk from the host is skipped", async () => {
    const mcp = await connect({ transport: STDIO, scope: "notes:read" } as never);
    expect(mcp.tools).toHaveLength(0);
    expect(mcp.skipped.some((s) => /needs a risk/.test(s.reason))).toBe(true);
  });
});

describe("MCP over HTTP", () => {
  async function serveNotes(serverOptions: { pageSize?: number; endless?: boolean; duplicate?: boolean } = {}): Promise<{ url: string; auth: string[]; counters: Record<string, number> }> {
    const auth: string[] = [];
    const counters: Record<string, number> = {};
    httpServer = createServer(async (req: IncomingMessage, res) => {
      auth.push(String(req.headers.authorization));
      const server = createNotesServer(counters, serverOptions);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(httpServer?.address() as AddressInfo).port}/mcp`, auth, counters };
  }

  test("connects with a header and runs a tool", async () => {
    const { url, auth, counters } = await serveNotes();
    const mcp = await connect({ ...SAFE, transport: { type: "http", url, headers: { authorization: "Bearer test-token" } }, scope: readOnlyScope });
    const { results } = await runWith(mcp, ["notes:read"], [call("notes_read", { id: "n9" }), { text: "done" }]);
    expect(results[0]).toMatchObject({ content: "note n9", isError: false });
    expect(auth.every((value) => value === "Bearer test-token")).toBe(true);
    expect(counters.notes_read).toBe(1);
  });

  test("follows pages", async () => {
    const { url } = await serveNotes({ pageSize: 3 });
    const all = await connect({ ...SAFE, transport: { type: "http", url }, scope: readOnlyScope });
    expect(all.tools.length + all.skipped.length).toBe(16);
  });

  test("stops at the page limit when a server never ends the list", async () => {
    const { url } = await serveNotes({ endless: true });
    const capped = await connect({ ...SAFE, transport: { type: "http", url }, scope: "notes:read" });
    expect(capped.tools).toHaveLength(20);
  });

  test("skips a second tool with the same name", async () => {
    const { url } = await serveNotes({ duplicate: true });
    const mcp = await connect({ ...SAFE, transport: { type: "http", url }, scope: readOnlyScope });
    expect(mcp.tools.filter((t) => t.name === "notes_read")).toHaveLength(1);
    expect(mcp.skipped).toContainEqual({ name: "notes_read", reason: "duplicate name" });
  });

  test.each([
    ["a body that streams past the limit", { "content-type": "application/json" }, false],
    ["a body that declares a size over the limit", { "content-type": "application/json", "content-length": "5000000" }, true],
  ])("refuses %s", async (_name, headers, declared) => {
    httpServer = createServer((_req, res) => {
      res.writeHead(200, headers);
      if (declared) res.end("{}");
      else {
        res.write(" ".repeat(5000));
        res.end(" ".repeat(5000));
      }
    });
    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(httpServer?.address() as AddressInfo).port}/mcp`;
    await expect(connectMcpTools({ ...SAFE, transport: { type: "http", url }, scope: "notes:read", maxResponseBytes: 1000 })).rejects.toThrow(/size limit/);
  });

  test("does not follow a redirect", async () => {
    let followed = 0;
    httpServer = createServer((req, res) => {
      if (req.url === "/other") {
        followed += 1;
        res.writeHead(200).end("{}");
        return;
      }
      res.writeHead(307, { location: "/other" }).end();
    });
    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(httpServer?.address() as AddressInfo).port}/mcp`;
    await expect(connectMcpTools({ ...SAFE, transport: { type: "http", url }, scope: "notes:read" })).rejects.toThrow();
    expect(followed).toBe(0);
  });

  test("gives up on a server that never answers", async () => {
    httpServer = createServer(() => undefined);
    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(httpServer?.address() as AddressInfo).port}/mcp`;
    const started = Date.now();
    await expect(connectMcpTools({ ...SAFE, transport: { type: "http", url }, scope: "notes:read", loadTimeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("refuses a remote http URL and a URL with a password", async () => {
    await expect(connectMcpTools({ ...SAFE, transport: { type: "http", url: "http://tools.example.eu/mcp" }, scope: "notes:read" })).rejects.toThrow(/https/);
    await expect(connectMcpTools({ ...SAFE, transport: { type: "http", url: "https://u:pw@tools.example.eu/mcp" }, scope: "notes:read" })).rejects.toThrow(/credentials/);
  });
});
