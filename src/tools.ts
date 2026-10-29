import Ajv2020Module from "ajv/dist/2020.js";
import type { AssistantPrincipal } from "./principal.js";
import { TOOL_RISKS, type ToolRisk } from "./approvals.js";
import { canGenerateCode, compileFallback } from "./schema-fallback.js";
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
  /** How much harm a call can do. `risky` and `irreversible` wait for a person's approval. Every tool must say. */
  risk: ToolRisk;
  handler(input: Input, context: ToolContext): Promise<unknown> | unknown;
}

/** Types a tool for an SDK function. The loop checks the input against `inputSchema` before it calls `handler`. */
export function defineTool<Input>(tool: ToolDefinition<Input>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

// ajv is CommonJS. Under NodeNext the default import is the module, and `.default` is the class.
const Ajv2020 = Ajv2020Module.default;

// Workers and other hosts refuse `new Function`, which Ajv needs. They use a small checker that fails closed.
// Checked at register time, not at load: Workers allow it while a module loads and refuse it inside a request.
let codegen: boolean | undefined;

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_ERROR_CHARS = 200;

type Validate = (input: unknown) => boolean;
type ValidateWithErrors = Validate & { errors?: { instancePath: string; message?: string; params: Record<string, unknown> }[] | null };

/**
 * Ajv turns a `pattern` into a backtracking regular expression. A schema from another server could
 * hold one that takes hours on a short input, and the check runs on the host's event loop. So a
 * schema may not use `pattern` or `patternProperties`.
 */
function usesRegexKeyword(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesRegexKeyword);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => key === "patternProperties" || (key === "pattern" && typeof child === "string") || usesRegexKeyword(child),
  );
}

export class ToolRegistry {
  private readonly tools = new Map<string, { tool: ToolDefinition; validate: ValidateWithErrors }>();
  // One validator per registry, so an `$id` in one tool's schema cannot clash with another registry's.
  private readonly ajv = new Ajv2020({ strict: false, logger: false, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });

  register(tool: ToolDefinition): this {
    if (!NAME_PATTERN.test(tool.name)) throw new Error(`invalid tool name "${tool.name}"`);
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    parseScope(tool.scope);
    if (!TOOL_RISKS.includes(tool.risk)) throw new Error(`tool "${tool.name}" needs a risk of safe, risky, or irreversible`);
    if (tool.inputSchema?.type !== "object") throw new Error(`tool "${tool.name}" needs an input schema with type "object"`);
    if (usesRegexKeyword(tool.inputSchema)) {
      throw new Error(`tool "${tool.name}" has an input schema with a regular expression (pattern), which is not allowed`);
    }
    // A schema from another server may name a draft or an id that this validator does not know.
    const { $schema: _draft, $id: _id, ...schema } = tool.inputSchema;
    let validate: ValidateWithErrors;
    try {
      validate = ((codegen ??= canGenerateCode()) ? this.ajv.compile(schema) : compileFallback(schema)) as ValidateWithErrors;
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
    try {
      if (entry.validate(input)) return undefined;
    } catch {
      return "input is nested too deeply to check";
    }
    const first = entry.validate.errors?.[0];
    if (first === undefined) return "input is not valid";
    const extra = typeof first.params.additionalProperty === "string" ? ` "${first.params.additionalProperty}"` : "";
    return `${first.instancePath === "" ? "input" : first.instancePath} ${first.message ?? "is not valid"}${extra}`.slice(0, MAX_ERROR_CHARS);
  }
}

export function toToolSpec(tool: ToolDefinition): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}
