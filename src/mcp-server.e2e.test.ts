import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import type { Setup } from "./chat.js";
import { QueueApprovalGate } from "./approvals.js";
import { createAssistantMcpServer } from "./mcp-server.js";
import { ScriptedProvider, type ScriptedTurn } from "./testing.js";
import { ToolRegistry } from "./tools.js";

// Ways the MCP server's shutdown can fail. Each one is a case below.
// 1. A call that is running when the server shuts down keeps its tool running, or reports success.
// 2. A call that arrives after shutdown still runs a tool.

/** One tool, `slow`, that runs `handler` with the call's signal. The script has a second turn, "late", that must not run. */
function setupWith(turns: ScriptedTurn[], handler: (signal: AbortSignal) => Promise<string>): Setup {
  const registry = new ToolRegistry().register({
    name: "slow",
    description: "Answers after a while",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    scope: "notes:read",
    risk: "safe",
    handler: (_input, context) => handler(context.signal ?? new AbortController().signal),
  });
  return {
    provider: new ScriptedProvider(turns),
    registry,
    gate: new QueueApprovalGate(),
    principalOptions: { id: "mcp-agent", parentId: "ana", scopes: ["notes:read"] },
    limits: {},
    skipped: [],
    close: async () => {},
  };
}

async function connect(setup: Setup, shutdown: AbortSignal) {
  const server = createAssistantMcpServer(setup, shutdown);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return { client, close: async () => (await client.close(), await server.close()) };
}

const TURNS: ScriptedTurn[] = [{ toolCalls: [{ name: "slow", input: {} }] }, { text: "late" }];

describe("MCP server shutdown", () => {
  test("a call running at shutdown stops with reason aborted, and reports no success", async () => {
    const shutdown = new AbortController();
    let reached!: () => void;
    const started = new Promise<void>((resolve) => (reached = resolve));
    const setup = setupWith(TURNS, (signal) => new Promise((resolve, reject) => {
      reached();
      const timer = setTimeout(() => resolve("finished"), 5000);
      signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("stopped"))), { once: true });
    }));
    const { client, close } = await connect(setup, shutdown.signal);
    try {
      const call = client.callTool({ name: "assistant_chat", arguments: { message: "be slow" } });
      await started;
      shutdown.abort();
      const result = await call;
      const body = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(result.isError).toBe(true);
      expect(body).toMatchObject({ machineMade: true, reason: "aborted", reply: "" });
    } finally {
      await close();
    }
  });

  test("a call that arrives after shutdown runs no tool", async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    let runs = 0;
    const setup = setupWith(TURNS, async () => {
      runs++;
      return "ran";
    });
    const { client, close } = await connect(setup, shutdown.signal);
    try {
      const result = await client.callTool({ name: "assistant_chat", arguments: { message: "too late" } });
      const body = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(result.isError).toBe(true);
      expect(body).toMatchObject({ reason: "aborted" });
      expect(runs).toBe(0);
    } finally {
      await close();
    }
  });
});
