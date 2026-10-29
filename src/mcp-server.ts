import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { runChat, type Setup } from "./chat.js";
import { VERSION } from "./version.js";

const MAX_MESSAGE_CHARS = 10_000;

const TOOL = {
  name: "assistant_chat",
  description:
    "Send one message to the assistant. It acts for a person with the scopes the host gave it. A risky action runs only if the host pre-approved that exact call. The reply says it is machine-made.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS, description: "What to ask the assistant." } },
    required: ["message"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
} as const;

const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/** An MCP server with one tool, `assistant_chat`. Each call starts a new conversation. */
export function createAssistantMcpServer(setup: Setup): Server {
  const server = new Server({ name: "agentic-assistant", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== TOOL.name) return fail(`unknown tool "${request.params.name}"`);
    const message = (request.params.arguments as { message?: unknown } | undefined)?.message;
    if (typeof message !== "string" || message.trim() === "" || message.length > MAX_MESSAGE_CHARS) {
      return fail(`message must be a text of 1 to ${MAX_MESSAGE_CHARS} characters`);
    }
    let reply = "";
    const toolCalls: { name: string; isError: boolean; denied?: string }[] = [];
    let outcome: { reason: string; totals: unknown } | undefined;
    for await (const event of runChat(setup, [{ role: "user", content: [{ type: "text", text: message }] }], extra.signal)) {
      if (event.type === "text_delta") reply += event.text;
      else if (event.type === "turn_start") reply = "";
      else if (event.type === "tool_result") toolCalls.push({ name: event.name, isError: event.isError, ...(event.denied ? { denied: event.denied } : {}) });
      else if (event.type === "done") outcome = { reason: event.reason, totals: event.totals };
    }
    const result = { machineMade: true, reply, reason: outcome?.reason ?? "unknown", toolCalls, totals: outcome?.totals };
    return { ...(outcome?.reason === "end_turn" ? {} : { isError: true }), content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
  return server;
}

/** Serves on stdio. Resolves when the client closes its input, or the transport closes. */
export async function startAssistantMcp(setup: Setup): Promise<void> {
  const server = createAssistantMcpServer(setup);
  const ended = new Promise<void>((resolve) => {
    server.onclose = resolve;
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await server.connect(new StdioServerTransport());
  await ended;
  await server.close().catch(() => undefined);
}
