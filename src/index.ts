export { VERSION } from "./version.js";
export { DATA_NOTICE, runAssistant } from "./loop.js";
export { QueueApprovalGate, TOOL_RISKS, canonicalJson, digestCall } from "./approvals.js";
export type { ApprovalDecision, ApprovalGate, ApprovalRequest, ToolRisk } from "./approvals.js";
export type { AssistantEvent, DeniedReason, DoneReason, RunLimits, RunOptions, RunTotals } from "./loop.js";
export { TRAINED_ALGORITHMIC_MEDIA, createProvenance, provenanceLabel, provenanceMarker } from "./provenance.js";
export type { Provenance, ProvenanceInput } from "./provenance.js";
export { createPrincipal, assertPrincipal, actorOf, PrincipalError } from "./principal.js";
export type { Actor, AssistantPrincipal, PrincipalInput } from "./principal.js";
export { ACTIONS, hasScope, parseScope, scopeCovers } from "./scopes.js";
export type { Action, Scope } from "./scopes.js";
export { ToolRegistry, defineTool } from "./tools.js";
export { connectMcpTools } from "./sources/mcp.js";
export type { ConnectMcpOptions, McpToolInfo, McpTools, McpTransportConfig } from "./sources/mcp.js";
export type { ToolContext, ToolDefinition } from "./tools.js";
export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL, PRICING_CHECKED_ON } from "./providers/anthropic.js";
export type { AnthropicProviderOptions } from "./providers/anthropic.js";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
export type { OpenAICompatibleOptions } from "./providers/openai-compatible.js";
export { FallbackProvider } from "./providers/fallback.js";
export { ProviderError } from "./types.js";
export type {
  AnsweredBy,
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
export { createAssistantMcpServer, startAssistantMcp } from "./mcp-server.js";
export { buildSetup, runChat, ConfigError, parseTarget } from "./chat.js";
export type { ChatConfig, ChatIo, Setup } from "./chat.js";
