import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { createNotesServer } from "../test-fixtures/notes-server.mjs";
import {
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

const STDIO = { type: "stdio" as const, command: process.execPath, args: [new URL("../test-fixtures/notes-stdio.mjs", import.meta.url).pathname] };
const readOnlyScope = (tool: { annotations?: { readOnlyHint?: boolean } }): Scope => (tool.annotations?.readOnlyHint ? "notes:read" : "notes:write");

const open: McpTools[] = [];
let httpServer: Server | undefined;
afterEach(async () => {
  await Promise.all(open.splice(0).map((m) => m.close()));
  httpServer?.close();
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
    const mcp = await connect({ transport: STDIO, scope: readOnlyScope, prefix: "n_" });
    expect(mcp.tools.map((t) => t.name).sort()).toEqual(["n_big", "n_boom", "n_img", "n_notes_read", "n_notes_write", "n_stats"]);
    expect(mcp.skipped.map((s) => s.name).sort()).toEqual(["bad name!", "bad_schema"]);
    expect(mcp.skipped.find((s) => s.name === "bad name!")?.reason).toMatch(/invalid tool name/);
    expect(mcp.skipped.find((s) => s.name === "bad_schema")?.reason).toMatch(/invalid input schema/);
  });

  test("runs a tool through the loop and quotes its output", async () => {
    const mcp = await connect({ transport: STDIO, scope: readOnlyScope });
    const { results, provider } = await runWith(mcp, ["notes:read"], [call("notes_read", { id: "n1" }), { text: "done" }]);
    expect(results[0]).toMatchObject({ content: "note n1", isError: false, untrusted: true });
    expect(JSON.stringify(provider.requests[1]?.messages.at(-1))).toContain('<tool_output tool=\\"notes_read\\">\\nnote n1\\n</tool_output>');
  });

  test("uses the host's scope for each tool", async () => {
    const mcp = await connect({ transport: STDIO, scope: readOnlyScope });
    const { results, provider } = await runWith(mcp, ["notes:read"], [call("notes_write", { id: "n1", text: "x" }), call("stats", {}), { text: "done" }]);
    expect(provider.requests[0]?.tools.map((t) => t.name)).not.toContain("notes_write");
    expect(results[0]).toMatchObject({ denied: "scope" });
    expect(JSON.parse(results[1]?.content ?? "{}")).not.toHaveProperty("notes_write");
  });

  test("bad input never reaches the server", async () => {
    const mcp = await connect({ transport: STDIO, scope: readOnlyScope });
    const bad = [{}, { id: 5 }, { id: "a", extra: 1 }];
    const { results } = await runWith(mcp, ["notes:read"], [...bad.map((input) => call("notes_read", input)), call("stats", {}), { text: "done" }]);
    expect(results.slice(0, 3).map((r) => r.denied)).toEqual(["invalid_input", "invalid_input", "invalid_input"]);
    expect(JSON.parse(results[3]?.content ?? "{}")).not.toHaveProperty("notes_read");
  });

  test("cuts a huge output", async () => {
    const mcp = await connect({ transport: STDIO, scope: readOnlyScope, maxOutputChars: 1000 });
    const { results } = await runWith(mcp, ["notes:read"], [call("big", {}), { text: "done" }]);
    expect(results[0]?.content.length).toBeLessThan(1100);
    expect(results[0]?.content).toContain("[truncated: 99000 characters omitted]");
  });

  test("keeps a tool's error text away from the model", async () => {
    const mcp = await connect({ transport: STDIO, scope: readOnlyScope });
    const { results, provider } = await runWith(mcp, ["notes:read"], [call("boom", {}), { text: "done" }]);
    expect(results[0]).toMatchObject({ isError: true, content: "tool failed", detail: expect.stringContaining("s3cr3t") });
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain("s3cr3t");
  });

  test("keeps injected instructions inside the quote", async () => {
    const mcp = await connect({ transport: STDIO, scope: readOnlyScope });
    const { provider } = await runWith(mcp, ["notes:read"], [call("notes_read", { id: "inject" }), { text: "done" }]);
    const sent = JSON.stringify(provider.requests[1]?.messages.at(-1));
    expect(sent.match(/<\/tool_output>/g)).toHaveLength(1);
    expect(sent).toContain("&lt;/tool_output>");
    expect(sent.indexOf("IGNORE ALL PREVIOUS")).toBeLessThan(sent.indexOf("</tool_output>"));
  });

  test("leaves non-text content out", async () => {
    const mcp = await connect({ transport: STDIO, scope: readOnlyScope });
    const { results } = await runWith(mcp, ["notes:read"], [call("img", {}), { text: "done" }]);
    expect(results[0]?.content).toBe("[image content omitted]\ncaption");
  });

  test("skips a tool when the scope function throws", async () => {
    const mcp = await connect({
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
    const mcp = await connect({ transport: STDIO, scope: "notes:read", maxTools: 2 });
    expect(mcp.tools).toHaveLength(2);
    expect(mcp.skipped.some((s) => s.reason === "too many tools")).toBe(true);
  });

  test("refuses a scope that is not valid", async () => {
    const mcp = await connect({ transport: STDIO, scope: "notes:delete" });
    expect(mcp.tools).toHaveLength(0);
    expect(mcp.skipped.every((s) => /invalid scope/.test(s.reason) || /invalid tool name/.test(s.reason))).toBe(true);
  });
});

describe("MCP over HTTP", () => {
  async function serveNotes(): Promise<{ url: string; auth: string[]; counters: Record<string, number> }> {
    const auth: string[] = [];
    const counters: Record<string, number> = {};
    httpServer = createServer(async (req: IncomingMessage, res) => {
      auth.push(String(req.headers.authorization));
      const server = createNotesServer(counters);
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
    const mcp = await connect({ transport: { type: "http", url, headers: { authorization: "Bearer test-token" } }, scope: readOnlyScope });
    const { results } = await runWith(mcp, ["notes:read"], [call("notes_read", { id: "n9" }), { text: "done" }]);
    expect(results[0]).toMatchObject({ content: "note n9", isError: false });
    expect(auth.every((value) => value === "Bearer test-token")).toBe(true);
    expect(counters.notes_read).toBe(1);
  });

  test("refuses a remote http URL and a URL with a password", async () => {
    await expect(connectMcpTools({ transport: { type: "http", url: "http://tools.example.eu/mcp" }, scope: "notes:read" })).rejects.toThrow(/https/);
    await expect(connectMcpTools({ transport: { type: "http", url: "https://u:pw@tools.example.eu/mcp" }, scope: "notes:read" })).rejects.toThrow(/credentials/);
  });
});
