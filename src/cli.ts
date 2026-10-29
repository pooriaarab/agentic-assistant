#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { TOOL_RISKS, type ToolRisk } from "./approvals.js";
import { ConfigError, buildSetup, readTextFile, runChat, type ChatConfig, type ChatIo, type Setup } from "./chat.js";
import type { AssistantEvent, RunLimits } from "./loop.js";
import { printable } from "./text.js";
import type { Message, Pricing } from "./types.js";
import { VERSION } from "./version.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const HELP = `agentic-assistant ${VERSION}
An AI assistant that acts inside your apps with the user's own permissions.

Usage:
  agentic-assistant chat [flags] [message]   Send a message. Read stdin when there is no message.
  agentic-assistant mcp [flags]              Start an MCP server with one tool, assistant_chat.

Flags for chat and mcp:
  --tools <target>          An https MCP URL, or a command that starts an MCP server on stdio. Required.
  --tools-header-env <h=E>  Send header h with the value of environment variable E (http only). Repeat it.
  --scope <scope>           A scope the assistant may hold, like notes:read. Repeat it. Required.
  --tool-scope <scope>      The scope each tool needs. Required.
  --tool-risk <risk>        safe, risky, or irreversible, for each tool. Default risky.
  --approve-call <json>     Approve one exact call before the run: {"tool":"...","input":{...}}. Repeat it.
  --approve <ask|deny>      ask: question a person on the terminal (chat only). Default deny.
  --provider <name>         anthropic (default), openai-compatible, or scripted (for tests).
  --model <id>              Model id. Default for anthropic: claude-sonnet-5-5.
  --fallback-model <id>     A second model on the same provider. It answers once when --model refuses or fails.
  --base-url <url>          Endpoint. Required for openai-compatible. https, or localhost.
  --use-default-endpoint    Call api.anthropic.com, a US-hosted endpoint. Anthropic only.
  --api-key-env <NAME>      Read the API key from this environment variable. Keys never go in arguments.
  --price-in <n> --price-out <n>   US dollars per million tokens, for the cost cap.
  --script <file>           Turns for --provider scripted.
  --system <text>           Extra system text.
  --user <id>               The person the assistant acts for. Default cli-user.
  --max-turns <n> --max-tokens <n> --max-cost <usd> --max-tool-calls <n>   Run limits.
  --json                    Print one JSON event per line on stdout (chat).

Other:
  --help, -h     Print this help.
  --version, -V  Print the version.

Exit codes: 0 the run ended normally, 1 it stopped for another reason or failed, 2 bad usage.
`;

const OPTIONS = {
  tools: { type: "string" },
  "tools-header-env": { type: "string", multiple: true },
  scope: { type: "string", multiple: true },
  "tool-scope": { type: "string" },
  "tool-risk": { type: "string" },
  "approve-call": { type: "string", multiple: true },
  approve: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  "fallback-model": { type: "string" },
  "base-url": { type: "string" },
  "use-default-endpoint": { type: "boolean" },
  "api-key-env": { type: "string" },
  "price-in": { type: "string" },
  "price-out": { type: "string" },
  script: { type: "string" },
  system: { type: "string" },
  user: { type: "string" },
  "max-turns": { type: "string" },
  "max-tokens": { type: "string" },
  "max-cost": { type: "string" },
  "max-tool-calls": { type: "string" },
  json: { type: "boolean" },
  message: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

function number(name: string, value: string | undefined, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new UsageError(`${name} needs a positive ${integer ? "whole " : ""}number, got "${value}"`);
  }
  return parsed;
}

export interface Parsed {
  command: "chat" | "mcp" | "help" | "version";
  config?: ChatConfig;
  message?: string;
  json: boolean;
}

export function parseCli(argv: string[]): Parsed {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.version) return { command: "version", json: false };
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) return { command: "help", json: false };
  if (command !== "chat" && command !== "mcp") throw new UsageError(`unknown command "${command}"`);
  if (!values.tools) throw new UsageError("--tools is required");
  if (!values["tool-scope"]) throw new UsageError("--tool-scope is required");
  const risk = values["tool-risk"] ?? "risky";
  if (!TOOL_RISKS.includes(risk as ToolRisk)) throw new UsageError(`--tool-risk must be one of ${TOOL_RISKS.join(", ")}`);
  const provider = values.provider ?? "anthropic";
  if (provider !== "anthropic" && provider !== "openai-compatible" && provider !== "scripted") {
    throw new UsageError("--provider must be anthropic, openai-compatible, or scripted");
  }
  const approve = values.approve ?? "deny";
  if (approve !== "ask" && approve !== "deny") throw new UsageError("--approve must be ask or deny");
  if (command === "mcp" && approve === "ask") throw new UsageError("--approve ask works with chat only");
  const preApproved = (values["approve-call"] ?? []).map((text) => {
    try {
      const call = JSON.parse(text) as { tool?: unknown; input?: unknown };
      if (typeof call.tool !== "string" || typeof call.input !== "object" || call.input === null || Array.isArray(call.input)) throw new Error("shape");
      return { tool: call.tool, input: call.input };
    } catch {
      throw new UsageError(`--approve-call needs JSON like {"tool":"name","input":{}}, got ${text.slice(0, 80)}`);
    }
  });
  const priceIn = number("--price-in", values["price-in"], false);
  const priceOut = number("--price-out", values["price-out"], false);
  if ((priceIn === undefined) !== (priceOut === undefined)) throw new UsageError("--price-in and --price-out go together");
  const pricing: Pricing | undefined = priceIn !== undefined && priceOut !== undefined ? { inputPerMTok: priceIn, outputPerMTok: priceOut } : undefined;
  const limits: RunLimits = {
    maxTurns: number("--max-turns", values["max-turns"], true),
    maxTotalTokens: number("--max-tokens", values["max-tokens"], true),
    maxCostUsd: number("--max-cost", values["max-cost"], false),
    maxToolCallsPerTurn: number("--max-tool-calls", values["max-tool-calls"], true),
  };
  for (const key of Object.keys(limits) as (keyof RunLimits)[]) if (limits[key] === undefined) delete limits[key];
  const config: ChatConfig = {
    tools: values.tools,
    toolHeaderEnv: values["tools-header-env"] ?? [],
    scopes: values.scope ?? [],
    toolScope: values["tool-scope"],
    toolRisk: risk as ToolRisk,
    provider,
    model: values.model,
    fallbackModel: values["fallback-model"],
    baseUrl: values["base-url"],
    useDefaultEndpoint: values["use-default-endpoint"] ?? false,
    apiKeyEnv: values["api-key-env"],
    pricing,
    script: values.script,
    system: values.system,
    user: values.user ?? "cli-user",
    limits,
    preApproved,
    approve,
  };
  return { command, config, message: values.message ?? (rest.length > 0 ? rest.join(" ") : undefined), json: values.json ?? false };
}

export interface CliIo {
  /** Final answer text and JSON events go here. */
  out(text: string): void;
  /** Progress, tool lines, and the summary go here. */
  err(line: string): void;
  env: Record<string, string | undefined>;
  readFile(path: string): string;
  readStdin(): Promise<string>;
  isTTY: boolean;
  ask(question: string): Promise<string>;
}

function defaultIo(): CliIo {
  return {
    out: (text) => void process.stdout.write(text),
    err: (line) => console.error(line),
    env: process.env,
    readFile: readTextFile,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += (chunk as Buffer).length;
        if (size > MAX_STDIN_BYTES) throw new UsageError(`the message on stdin is over ${MAX_STDIN_BYTES} bytes`);
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    isTTY: Boolean(process.stdin.isTTY),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

const oneLine = (value: unknown, max = 200): string => {
  const text = printable(typeof value === "string" ? value : JSON.stringify(value) ?? "null").replace(/\s+/g, " ");
  const points = Array.from(text); // cut between characters, never inside an emoji
  return points.length > max ? `${points.slice(0, max).join("")}...` : text;
};

const MAX_STDIN_BYTES = 1_000_000;
const MAX_SKIPPED_LINES = 20;

/** Prints one event for a person. Every assistant part says it is machine-made. */
function render(event: AssistantEvent, io: CliIo, state: { inText: boolean }): void {
  const endText = () => {
    if (state.inText) io.out("\n");
    state.inText = false;
  };
  switch (event.type) {
    case "text_delta":
      if (!state.inText) io.out("Assistant (machine-made): ");
      state.inText = true;
      io.out(printable(event.text));
      break;
    case "turn_end":
      endText();
      if (event.answeredBy.fallback) {
        io.err(`fallback model answered: ${oneLine(event.answeredBy.model, 100)} (first model: ${event.answeredBy.fallbackFor ?? "unknown"})`);
      }
      break;
    case "tool_call":
      endText();
      io.err(`[machine-made] tool call: ${oneLine(event.name, 100)} ${oneLine(event.input)}`);
      break;
    case "approval_request":
      endText();
      io.err(`[machine-made] approval needed: ${oneLine(event.request.tool, 100)} (${event.request.risk}) ${oneLine(event.request.input)}`);
      break;
    case "approval_decision":
      io.err(`approval: ${event.approved ? `approved by ${oneLine(event.decidedBy ?? "unknown", 100)}` : `not approved (${oneLine(event.reason ?? "no reason", 200)})`}`);
      break;
    case "tool_result":
      io.err(`tool result (${event.isError ? "error" : "ok"}${event.denied ? `, ${event.denied}` : ""}): ${oneLine(event.content)}`);
      break;
    case "done":
      endText();
      io.err(`done: ${event.reason}. tokens in ${event.totals.inputTokens}, out ${event.totals.outputTokens}. cost $${event.totals.costUsd.toFixed(6)} (estimate)${event.error ? `. error: ${oneLine(event.error)}` : ""}`);
      break;
    default:
      break;
  }
}

async function runOnce(setup: Setup, messages: Message[], json: boolean, io: CliIo): Promise<{ code: number; transcript: Message[] }> {
  const state = { inText: false };
  let last: Extract<AssistantEvent, { type: "done" }> | undefined;
  for await (const event of runChat(setup, messages)) {
    if (json) io.out(`${JSON.stringify(event)}\n`);
    else render(event, io, state);
    if (event.type === "done") last = event;
  }
  return { code: last?.reason === "end_turn" ? 0 : 1, transcript: last?.messages ?? messages };
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err('Run "agentic-assistant --help" for usage.');
    return 2;
  }
  if (parsed.command === "help") {
    io.out(HELP);
    return 0;
  }
  if (parsed.command === "version") {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const config = parsed.config as ChatConfig;
  const chatIo: ChatIo = { env: io.env, readFile: io.readFile, ...(config.approve === "ask" && io.isTTY ? { ask: io.ask } : {}) };
  let setup: Setup | undefined;
  try {
    setup = await buildSetup(config, chatIo);
    for (const skip of setup.skipped.slice(0, MAX_SKIPPED_LINES)) io.err(`skipped tool ${oneLine(skip.name, 100)}: ${oneLine(skip.reason, 200)}`);
    if (setup.skipped.length > MAX_SKIPPED_LINES) io.err(`skipped ${setup.skipped.length - MAX_SKIPPED_LINES} more tools`);
    if (parsed.command === "mcp") {
      const { startAssistantMcp } = await import("./mcp-server.js");
      await startAssistantMcp(setup); // returns when the client closes its input
      return 0;
    }
    const text = parsed.message ?? (io.isTTY ? undefined : (await io.readStdin()).trim());
    let transcript: Message[] = [];
    if (text !== undefined && text !== "") {
      const { code } = await runOnce(setup, [{ role: "user", content: [{ type: "text", text }] }], parsed.json, io);
      return code;
    }
    if (!io.isTTY) throw new UsageError("give a message as an argument, with --message, or on stdin");
    // A terminal with no message: a short conversation. Type exit, or press Ctrl+D, to end it.
    let code = 0;
    for (;;) {
      const line = (await io.ask("> ").catch(() => "exit")).trim();
      if (line === "" || line === "exit") return code;
      transcript = [...transcript, { role: "user", content: [{ type: "text", text: line }] }];
      const result = await runOnce(setup, transcript, parsed.json, io);
      transcript = result.transcript;
      code = result.code;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UsageError) {
      io.err(`${error.name}: ${oneLine(error.message, 500)}`);
      return 2;
    }
    io.err(`${error instanceof Error ? error.name : "Error"}: ${oneLine(error instanceof Error ? error.message : String(error), 500)}`);
    return 1;
  } finally {
    // A tool server that never closes must not keep the process alive.
    await Promise.race([setup?.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
