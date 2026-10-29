import Ajv2020Module from "ajv/dist/2020.js";
import type { AssistantPrincipal } from "./principal.js";
import { parseScope, type Scope } from "./scopes.js";
import type { JsonSchema, ToolSpec } from "./types.js";

export interface ToolContext {
  principal: AssistantPrincipal;
  toolUseId: string;
  signal?: AbortSignal;
}

export interface ToolDefinition<Input = Record<string, unknown>> {
  name: string;
  description: string;
  /** A JSON Schema with `type: "object"`. The loop validates the model's input against it. */
  inputSchema: JsonSchema;
  /** The scope the acting principal must hold to call this tool. */
  scope: Scope;
  handler(input: Input, context: ToolContext): Promise<unknown> | unknown;
}

/** Types a tool for an SDK function. The loop checks the input against `inputSchema` before it calls `handler`. */
export function defineTool<Input>(tool: ToolDefinition<Input>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

// ajv is CommonJS. Under NodeNext the default import is the module, and `.default` is the class.
const Ajv2020 = Ajv2020Module.default;

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_ERROR_CHARS = 200;

type Validate = (input: unknown) => boolean;
type ValidateWithErrors = Validate & { errors?: { instancePath: string; message?: string; params: Record<string, unknown> }[] | null };

export class ToolRegistry {
  private readonly tools = new Map<string, { tool: ToolDefinition; validate: ValidateWithErrors }>();
  // One validator per registry, so an `$id` in one tool's schema cannot clash with another registry's.
  private readonly ajv = new Ajv2020({ strict: false, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });

  register(tool: ToolDefinition): this {
    if (!NAME_PATTERN.test(tool.name)) throw new Error(`invalid tool name "${tool.name}"`);
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    parseScope(tool.scope);
    if (tool.inputSchema?.type !== "object") throw new Error(`tool "${tool.name}" needs an input schema with type "object"`);
    // A schema from another server may name a draft or an id that this validator does not know.
    const { $schema: _draft, $id: _id, ...schema } = tool.inputSchema;
    let validate: ValidateWithErrors;
    try {
      validate = this.ajv.compile(schema) as ValidateWithErrors;
    } catch (error) {
      throw new Error(`tool "${tool.name}" has an invalid input schema: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.tools.set(tool.name, { tool, validate });
    return this;
  }

  registerAll(tools: readonly ToolDefinition[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.tool;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((entry) => entry.tool);
  }

  /** Returns a short description of the first schema violation, or undefined when the input is valid. */
  checkInput(name: string, input: unknown): string | undefined {
    const entry = this.tools.get(name);
    if (entry === undefined) return `unknown tool "${name}"`;
    if (entry.validate(input)) return undefined;
    const first = entry.validate.errors?.[0];
    if (first === undefined) return "input is not valid";
    const extra = typeof first.params.additionalProperty === "string" ? ` "${first.params.additionalProperty}"` : "";
    return `${first.instancePath === "" ? "input" : first.instancePath} ${first.message ?? "is not valid"}${extra}`.slice(0, MAX_ERROR_CHARS);
  }
}

export function toToolSpec(tool: ToolDefinition): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}
