import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { checkBaseUrl } from "../providers/url.js";
import type { Scope } from "../scopes.js";
import { ToolRegistry, type ToolDefinition } from "../tools.js";
import { VERSION } from "../version.js";

export type McpTransportConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface McpToolInfo {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface ConnectMcpOptions {
  transport: McpTransportConfig;
  /** The scope each tool needs. There is no default. A function can choose per tool. */
  scope: Scope | ((tool: McpToolInfo) => Scope);
  /** Put before each tool name, to keep names from two servers apart. */
  prefix?: string;
  /** Most characters of tool output to keep. Default 32768. */
  maxOutputChars?: number;
  /** Most tools to load. Default 200. */
  maxTools?: number;
  /** Longest tool description to pass to the model. Default 1000. */
  maxDescriptionChars?: number;
  /** Time to wait for one tool call. Default 30000. */
  callTimeoutMs?: number;
}

export interface McpTools {
  tools: ToolDefinition[];
  /** Tools that were not loaded, with the reason. */
  skipped: { name: string; reason: string }[];
  close(): Promise<void>;
}

const MAX_PAGES = 20;

function makeTransport(config: McpTransportConfig): Transport {
  if (config.type === "stdio") {
    return new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd, stderr: "ignore" });
  }
  const { url } = checkBaseUrl(config.url);
  return new StreamableHTTPClientTransport(url, config.headers ? { requestInit: { headers: config.headers } } : undefined);
}

/** Cuts text at `max` characters and says how much was cut. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated: ${text.length - max} characters omitted]`;
}

type CallResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };

function flatten(result: CallResult, max: number): string {
  const parts = (result.content ?? []).map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : `[${block.type} content omitted]`));
  let text = parts.join("\n");
  if (text === "" && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
  return cut(text, max);
}

/**
 * Connects to an MCP server and turns its tools into assistant tools. The host
 * names the scope each tool needs. Output text is capped, and non-text content is
 * left out. Tools with a bad name, schema, or scope are skipped, not loaded.
 */
export async function connectMcpTools(options: ConnectMcpOptions): Promise<McpTools> {
  const maxOutput = options.maxOutputChars ?? 32_768;
  const maxTools = options.maxTools ?? 200;
  const maxDescription = options.maxDescriptionChars ?? 1000;
  const prefix = options.prefix ?? "";
  const client = new Client({ name: "agentic-assistant", version: VERSION });
  await client.connect(makeTransport(options.transport));
  try {
    const listed: McpToolInfo[] = [];
    const schemas = new Map<string, Record<string, unknown>>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await client.listTools(cursor === undefined ? undefined : { cursor });
      for (const tool of response.tools) {
        listed.push(tool);
        schemas.set(tool.name, tool.inputSchema as Record<string, unknown>);
      }
      cursor = response.nextCursor;
      if (cursor === undefined) break;
    }

    const tools: ToolDefinition[] = [];
    const skipped: McpTools["skipped"] = [];
    for (const info of listed) {
      if (tools.length >= maxTools) {
        skipped.push({ name: info.name, reason: "too many tools" });
        continue;
      }
      try {
        const scope = typeof options.scope === "function" ? options.scope(info) : options.scope;
        const definition: ToolDefinition = {
          name: `${prefix}${info.name}`,
          description: cut(info.description ?? "", maxDescription),
          inputSchema: schemas.get(info.name) ?? {},
          scope,
          handler: async (input, context) => {
            const result = (await client.callTool({ name: info.name, arguments: input }, undefined, {
              signal: context.signal,
              timeout: options.callTimeoutMs ?? 30_000,
            })) as CallResult;
            const text = flatten(result, maxOutput);
            if (result.isError) throw new Error(text === "" ? "the tool reported an error" : text);
            return text;
          },
        };
        new ToolRegistry().register(definition);
        tools.push(definition);
      } catch (error) {
        skipped.push({ name: info.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { tools, skipped, close: () => client.close() };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
