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
  /** Time to connect and list every tool, all pages together. Default 30000. */
  loadTimeoutMs?: number;
  /** Most bytes to read from one HTTP response. Default 4000000. Stdio is limited by the SDK. */
  maxResponseBytes?: number;
}

export interface McpTools {
  tools: ToolDefinition[];
  /** Tools that were not loaded, with the reason. */
  skipped: { name: string; reason: string }[];
  close(): Promise<void>;
}

const MAX_PAGES = 20;
/** Longest schema, as JSON text, that is passed to the model. */
const MAX_SCHEMA_CHARS = 20_000;

function positive(name: string, value: number | undefined, fallback: number): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen <= 0) throw new RangeError(`${name} must be a positive integer`);
  return chosen;
}

/** A fetch that stops reading a response after `limit` bytes. */
function boundedFetch(limit: number): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel();
      throw new Error(`the tool server sent a response over the size limit of ${limit} bytes`);
    }
    if (response.body === null) return response;
    let seen = 0;
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > limit) controller.error(new Error(`the tool server sent a response over the size limit of ${limit} bytes`));
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** Copies a schema with its free text cut, so it cannot carry a long instruction to the model. */
function limitSchemaText(value: unknown, max: number): unknown {
  if (Array.isArray(value)) return value.map((item) => limitSchemaText(item, max));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "examples") continue;
    out[key] = (key === "description" || key === "title" || key === "$comment") && typeof child === "string" ? cut(child, max) : limitSchemaText(child, max);
  }
  return out;
}

function makeTransport(config: McpTransportConfig, maxResponseBytes: number): Transport {
  if (config.type === "stdio") {
    return new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd, stderr: "ignore" });
  }
  const { url } = checkBaseUrl(config.url);
  return new StreamableHTTPClientTransport(url, {
    fetch: boundedFetch(maxResponseBytes),
    ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
  });
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
  const maxOutput = positive("maxOutputChars", options.maxOutputChars, 32_768);
  const maxTools = positive("maxTools", options.maxTools, 200);
  const maxDescription = positive("maxDescriptionChars", options.maxDescriptionChars, 1000);
  const callTimeout = positive("callTimeoutMs", options.callTimeoutMs, 30_000);
  const loadTimeout = positive("loadTimeoutMs", options.loadTimeoutMs, 30_000);
  const maxResponseBytes = positive("maxResponseBytes", options.maxResponseBytes, 4_000_000);
  const prefix = options.prefix ?? "";
  const client = new Client({ name: "agentic-assistant", version: VERSION });
  const loading = AbortSignal.timeout(loadTimeout);
  try {
    await client.connect(makeTransport(options.transport, maxResponseBytes), { signal: loading, timeout: loadTimeout });
    const listed: (McpToolInfo & { inputSchema: unknown })[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await client.listTools(cursor === undefined ? undefined : { cursor }, { signal: loading, timeout: loadTimeout });
      listed.push(...response.tools);
      cursor = response.nextCursor;
      if (cursor === undefined) break;
    }

    const tools: ToolDefinition[] = [];
    const skipped: McpTools["skipped"] = [];
    const seen = new Set<string>();
    for (const info of listed) {
      if (seen.has(info.name)) {
        skipped.push({ name: info.name, reason: "duplicate name" });
        continue;
      }
      seen.add(info.name);
      if (tools.length >= maxTools) {
        skipped.push({ name: info.name, reason: "too many tools" });
        continue;
      }
      try {
        if (JSON.stringify(info.inputSchema).length > MAX_SCHEMA_CHARS) throw new Error("input schema is too large");
        const scope = typeof options.scope === "function" ? options.scope(info) : options.scope;
        const definition: ToolDefinition = {
          name: `${prefix}${info.name}`,
          description: cut(info.description ?? "", maxDescription),
          inputSchema: limitSchemaText(info.inputSchema, maxDescription) as Record<string, unknown>,
          scope,
          handler: async (input, context) => {
            const result = (await client.callTool({ name: info.name, arguments: input }, undefined, {
              signal: context.signal,
              timeout: callTimeout,
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
