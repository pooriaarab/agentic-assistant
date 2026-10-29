import { readFileSync } from "node:fs";
import { digestCall, TOOL_RISKS, type ApprovalDecision, type ApprovalGate, type ApprovalRequest, type ToolRisk } from "./approvals.js";
import { runAssistant, type AssistantEvent, type RunLimits } from "./loop.js";
import { PrincipalError, createPrincipal } from "./principal.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { connectMcpTools, type McpTransportConfig } from "./sources/mcp.js";
import { ScriptedProvider, type ScriptedTurn } from "./testing.js";
import { ToolRegistry } from "./tools.js";
import { ProviderError, type Message, type ModelProvider, type Pricing } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ChatConfig {
  /** An http(s) URL of an MCP server, or a command line that starts one on stdio. */
  tools: string;
  /** Names of environment variables that hold HTTP headers for the MCP server: `header=ENV_NAME`. */
  toolHeaderEnv: string[];
  scopes: string[];
  toolScope: string;
  toolRisk: ToolRisk;
  provider: "anthropic" | "openai-compatible" | "scripted";
  model?: string;
  baseUrl?: string;
  useDefaultEndpoint: boolean;
  apiKeyEnv?: string;
  pricing?: Pricing;
  script?: string;
  system?: string;
  user: string;
  limits: RunLimits;
  /** Exact calls a person approved before the run. Each is used once. */
  preApproved: { tool: string; input: unknown }[];
  approve: "deny" | "ask";
}

export interface ChatIo {
  env: Record<string, string | undefined>;
  readFile(path: string): string;
  /** Ask a person a question and return the answer. Only used for `--approve ask`. */
  ask?(question: string): Promise<string>;
}

export interface Setup {
  provider: ModelProvider;
  registry: ToolRegistry;
  gate: ApprovalGate;
  principalOptions: { id: string; parentId: string; scopes: string[] };
  limits: RunLimits;
  system?: string;
  skipped: { name: string; reason: string }[];
  close(): Promise<void>;
}

/** An http(s) URL is an HTTP server. A JSON array of strings, or words split on spaces, is a command. */
export function parseTarget(target: string, headerEnv: string[], env: ChatIo["env"]): McpTransportConfig {
  if (/^https?:\/\//i.test(target)) {
    const headers: Record<string, string> = {};
    for (const entry of headerEnv) {
      const [name, variable] = entry.split("=", 2);
      if (!name || !variable) throw new ConfigError(`--tools-header-env needs header=ENV_NAME, got "${entry}"`);
      const value = env[variable];
      if (!value) throw new ConfigError(`environment variable ${variable} is not set`);
      headers[name] = value;
    }
    return { type: "http", url: target, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  if (headerEnv.length > 0) throw new ConfigError("--tools-header-env works with an http(s) --tools URL only");
  let words: string[];
  if (target.trimStart().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(target);
      if (!Array.isArray(parsed) || parsed.some((word) => typeof word !== "string")) throw new Error("not strings");
      words = parsed as string[];
    } catch {
      throw new ConfigError("--tools looks like a JSON list but is not a list of strings");
    }
  } else {
    words = target.split(/\s+/).filter(Boolean);
  }
  const [command, ...args] = words;
  if (!command) throw new ConfigError("--tools is empty");
  return { type: "stdio", command, args };
}

function buildProvider(config: ChatConfig, io: ChatIo): ModelProvider {
  const key = config.apiKeyEnv === undefined ? undefined : io.env[config.apiKeyEnv];
  if (config.apiKeyEnv !== undefined && !key) throw new ConfigError(`environment variable ${config.apiKeyEnv} is not set`);
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider({
        model: config.model,
        baseUrl: config.baseUrl,
        useDefaultEndpoint: config.useDefaultEndpoint,
        pricing: config.pricing,
        apiKey: key ?? io.env.ANTHROPIC_API_KEY,
      });
    case "openai-compatible":
      if (!config.baseUrl || !config.model) throw new ConfigError("--provider openai-compatible needs --base-url and --model");
      return new OpenAICompatibleProvider({ baseUrl: config.baseUrl, model: config.model, apiKey: key, pricing: config.pricing });
    case "scripted": {
      if (!config.script) throw new ConfigError("--provider scripted needs --script <file>");
      let script: unknown;
      try {
        script = JSON.parse(io.readFile(config.script));
      } catch {
        throw new ConfigError("--script must be a JSON file with a list of turns");
      }
      if (!Array.isArray(script)) throw new ConfigError("--script must be a JSON file with a list of turns");
      return new ScriptedProvider(script as ScriptedTurn[], config.pricing);
    }
  }
}

/**
 * Approves a call only when the person approved this exact tool and these exact arguments, on the
 * command line or at the prompt. The digest binds the tool, the arguments, and the principal.
 */
class CommandLineGate implements ApprovalGate {
  private readonly unused: string[];

  constructor(
    preApproved: ChatConfig["preApproved"],
    principal: { id: string; parentId: string },
    private readonly mode: ChatConfig["approve"],
    private readonly user: string,
    private readonly ask: ChatIo["ask"],
  ) {
    this.unused = preApproved.map((call) => digestCall({ tool: call.tool, input: call.input, principalId: principal.id, onBehalfOf: principal.parentId }));
  }

  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const index = this.unused.indexOf(request.digest);
    if (index >= 0) {
      this.unused.splice(index, 1);
      return { requestId: request.id, approved: true, digest: request.digest, decidedBy: "cli:pre-approved" };
    }
    if (this.mode === "ask" && this.ask !== undefined) {
      const answer = await this.ask(`Approve ${request.tool} (${request.risk}) with ${JSON.stringify(request.input)}? [y/N] `);
      if (/^y(es)?$/i.test(answer.trim())) return { requestId: request.id, approved: true, digest: request.digest, decidedBy: `cli:${this.user}` };
    }
    return { requestId: request.id, approved: false, reason: "not approved on the command line" };
  }
}

export async function buildSetup(config: ChatConfig, io: ChatIo): Promise<Setup> {
  if (config.scopes.length === 0) throw new ConfigError("give at least one --scope, or the assistant can do nothing");
  if (!TOOL_RISKS.includes(config.toolRisk)) throw new ConfigError(`--tool-risk must be one of ${TOOL_RISKS.join(", ")}`);
  if (config.approve === "ask" && io.ask === undefined) throw new ConfigError("--approve ask needs a terminal");
  const principalOptions = { id: "cli-agent", parentId: config.user, scopes: config.scopes };
  // Settings that are wrong fail now, as a usage error, before anything starts.
  let provider: ModelProvider;
  try {
    createPrincipal({ ...principalOptions, kind: "agent_of_human" });
    provider = buildProvider(config, io);
  } catch (error) {
    if (error instanceof PrincipalError || error instanceof ProviderError) throw new ConfigError(error.message);
    throw error;
  }
  const transport = parseTarget(config.tools, config.toolHeaderEnv, io.env);
  const mcp = await connectMcpTools({ transport, scope: config.toolScope, risk: config.toolRisk });
  return {
    provider,
    registry: new ToolRegistry().registerAll(mcp.tools),
    gate: new CommandLineGate(config.preApproved, principalOptions, config.approve, config.user, io.ask),
    principalOptions,
    limits: config.limits,
    system: config.system,
    skipped: mcp.skipped,
    close: () => mcp.close(),
  };
}

export function runChat(setup: Setup, messages: Message[], signal?: AbortSignal): AsyncGenerator<AssistantEvent> {
  return runAssistant({
    provider: setup.provider,
    registry: setup.registry,
    principal: createPrincipal({ ...setup.principalOptions, kind: "agent_of_human" }),
    approvals: setup.gate,
    messages,
    system: setup.system,
    limits: setup.limits,
    signal,
  });
}

export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}
