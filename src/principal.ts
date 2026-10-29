import { parseScope, type Scope } from "./scopes.js";

/**
 * The acting principal. The assistant always acts as an agent of a signed-in
 * person. The host passes the scopes, already narrowed to what the person
 * granted this agent. The assistant never widens them.
 */
export interface AssistantPrincipal {
  readonly id: string;
  readonly kind: "agent_of_human";
  /** The person the assistant acts for. */
  readonly parentId: string;
  readonly scopes: readonly Scope[];
  /** Epoch milliseconds. Calls stop at this time. */
  readonly expiresAt?: number;
  /** Host check, run before every tool call. A throw or a true result denies the call. */
  readonly isRevoked?: () => boolean | Promise<boolean>;
}

export interface PrincipalInput {
  id: string;
  kind?: string;
  parentId: string;
  scopes: readonly Scope[];
  expiresAt?: number;
  isRevoked?: () => boolean | Promise<boolean>;
}

export class PrincipalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrincipalError";
  }
}

/** Validates host input. A missing or other kind is an error, never a default. */
export function createPrincipal(input: PrincipalInput): AssistantPrincipal {
  if (input.kind !== "agent_of_human") {
    throw new PrincipalError(`principal kind must be "agent_of_human", got ${JSON.stringify(input.kind)}`);
  }
  for (const field of ["id", "parentId"] as const) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new PrincipalError(`principal ${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(input.scopes)) throw new PrincipalError("principal scopes must be an array");
  for (const scope of input.scopes) {
    try {
      parseScope(scope);
    } catch (error) {
      throw new PrincipalError(error instanceof Error ? error.message : String(error));
    }
  }
  if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) {
    throw new PrincipalError("principal expiresAt must be a finite number of epoch milliseconds");
  }
  return Object.freeze({
    id: input.id,
    kind: "agent_of_human",
    parentId: input.parentId,
    scopes: Object.freeze([...input.scopes]),
    expiresAt: input.expiresAt,
    isRevoked: input.isRevoked,
  });
}

/** Who a run, a tool call, and every audit row is attributed to. Always machine-made. */
export interface Actor {
  principalId: string;
  kind: "agent_of_human";
  onBehalfOf: string;
  machineMade: true;
}

export function actorOf(principal: AssistantPrincipal): Actor {
  return { principalId: principal.id, kind: principal.kind, onBehalfOf: principal.parentId, machineMade: true };
}
