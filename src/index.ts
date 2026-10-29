export { VERSION } from "./version.js";
export { DATA_NOTICE, runAssistant } from "./loop.js";
export type { AssistantEvent, DeniedReason, DoneReason, RunLimits, RunOptions, RunTotals } from "./loop.js";
export { createPrincipal, assertPrincipal, actorOf, PrincipalError } from "./principal.js";
export type { Actor, AssistantPrincipal, PrincipalInput } from "./principal.js";
export { ACTIONS, hasScope, parseScope, scopeCovers } from "./scopes.js";
export type { Action, Scope } from "./scopes.js";
export { ToolRegistry, defineTool } from "./tools.js";
export { connectMcpTools } from "./sources/mcp.js";
export type { ConnectMcpOptions, McpToolInfo, McpTools, McpTransportConfig } from "./sources/mcp.js";
export type { ToolContext, ToolDefinition } from "./tools.js";
export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./providers/anthropic.js";
export type { AnthropicProviderOptions } from "./providers/anthropic.js";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
export type { OpenAICompatibleOptions } from "./providers/openai-compatible.js";
export { ProviderError } from "./types.js";
export type {
  ContentBlock,
  JsonSchema,
  Message,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  Pricing,
  StopReason,
  ToolSpec,
  Usage,
} from "./types.js";
