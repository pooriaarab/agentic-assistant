import type { AssistantPrincipal } from "./principal.js";
import { parseScope, type Scope } from "./scopes.js";
import type { JsonSchema, ToolSpec } from "./types.js";

export interface ToolContext {
  principal: AssistantPrincipal;
  toolUseId: string;
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** The scope the acting principal must hold to call this tool. */
  scope: Scope;
  handler(input: Record<string, unknown>, context: ToolContext): Promise<unknown> | unknown;
}

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (!NAME_PATTERN.test(tool.name)) throw new Error(`invalid tool name "${tool.name}"`);
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    parseScope(tool.scope);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }
}

export function toToolSpec(tool: ToolDefinition): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}
