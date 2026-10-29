import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./principal.js";

/** `safe` runs at once. `risky` and `irreversible` wait for a person. */
export type ToolRisk = "safe" | "risky" | "irreversible";
export const TOOL_RISKS: readonly ToolRisk[] = ["safe", "risky", "irreversible"];

export interface ApprovalRequest {
  id: string;
  tool: string;
  risk: "risky" | "irreversible";
  /** A frozen copy of the arguments the tool will get. */
  input: Readonly<Record<string, unknown>>;
  /** Binds the tool, the arguments, and the acting principal. The decision must echo it. */
  digest: string;
  actor: Actor;
}

export type ApprovalDecision =
  | { requestId: string; approved: true; digest: string; decidedBy: string }
  | { requestId: string; approved: false; decidedBy?: string; reason?: string };

/**
 * The approval port. Answer a request with a decision, or fail. The loop treats
 * a failure, a timeout, and a decision that does not match the request as a refusal.
 */
export interface ApprovalGate {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

/** JSON with sorted keys, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function digestCall(call: { tool: string; input: unknown; principalId: string; onBehalfOf: string }): string {
  return createHash("sha256").update(canonicalJson(call)).digest("hex");
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Returns why a decision does not approve this request, or undefined when it does. */
export function refuseDecision(decision: unknown, request: ApprovalRequest, principalId: string): string | undefined {
  if (typeof decision !== "object" || decision === null) return "the approver sent no decision";
  const d = decision as Partial<Record<"requestId" | "approved" | "digest" | "decidedBy" | "reason", unknown>>;
  if (d.requestId !== request.id) return "the decision is for another request";
  if (d.approved === false) return "the person declined";
  if (d.approved !== true) return "the decision is not a clear yes or no";
  if (d.digest !== request.digest) return "the approval is for other arguments";
  if (typeof d.decidedBy !== "string" || d.decidedBy.length === 0) return "the approval names no approver";
  if (d.decidedBy === principalId) return "an agent cannot approve its own action";
  return undefined;
}

interface Pending {
  request: ApprovalRequest;
  resolve(decision: ApprovalDecision): void;
}

/**
 * An in-memory gate. `request` waits until `approve` or `reject` is called with the request id.
 * A panel, a CLI, or a test calls them. `approve` signs the stored digest, so a caller cannot
 * approve other arguments than the ones the loop asked about.
 */
export class QueueApprovalGate implements ApprovalGate {
  private readonly waiting = new Map<string, Pending>();

  pending(): ApprovalRequest[] {
    return [...this.waiting.values()].map((entry) => entry.request);
  }

  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("the request was cancelled"));
      if (this.waiting.has(request.id)) return reject(new Error(`a request with id "${request.id}" is already pending`));
      this.waiting.set(request.id, { request, resolve });
      signal.addEventListener(
        "abort",
        () => {
          this.waiting.delete(request.id);
          reject(new Error("the request was cancelled"));
        },
        { once: true },
      );
    });
  }

  approve(id: string, decidedBy: string): void {
    const entry = this.take(id);
    entry.resolve({ requestId: id, approved: true, digest: entry.request.digest, decidedBy });
  }

  reject(id: string, decidedBy?: string, reason?: string): void {
    this.take(id).resolve({ requestId: id, approved: false, decidedBy, reason });
  }

  private take(id: string): Pending {
    const entry = this.waiting.get(id);
    if (entry === undefined) throw new Error(`no pending approval with id "${id}"`);
    this.waiting.delete(id);
    return entry;
  }
}

export const newApprovalId = (): string => randomUUID();
