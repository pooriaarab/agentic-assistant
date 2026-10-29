import type { Auth, PrincipalContext } from "agentic-identity";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "./approvals.js";
import { runAssistant, type AssistantEvent, type RunLimits } from "./loop.js";
import { createPrincipal } from "./principal.js";
import { hasScope, parseScope } from "./scopes.js";
import type { ToolRegistry } from "./tools.js";
import type { ModelProvider } from "./types.js";

export interface AssistantApiOptions {
  /** Reads the credential on a request. Use an `agentic-identity` Auth, such as `createStoreAuth`. */
  auth: Auth;
  /** Makes the model for one chat turn. Called once per request, so a provider may keep state. */
  provider(): ModelProvider;
  /** The tools the assistant may use. Each one has a scope and a risk. */
  registry: ToolRegistry;
  system?: string;
  limits?: RunLimits;
  /** Most chat turns one principal may run at once. Default 4. */
  maxConcurrentRuns?: number;
}

const MAX_BODY_BYTES = 65_536;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_REASON_CHARS = 500;
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const KINDS = ["human", "agent_of_human", "agent_of_agent", "agent", "user_token"];
/** An agent needs this scope before it may decide on a tool call. A person needs no extra scope. */
export const APPROVER_SCOPE = "assistant:admin";

interface Caller {
  id: string;
  kind: string;
  /** The first principal of the chain: the person or the agent that owns it. */
  rootId: string;
  /** Ids from the root to this principal. */
  chain: string[];
  scopes: string[];
}

interface Pending {
  request: ApprovalRequest;
  /** The principal that asked for the chat turn. */
  proposer: Caller;
  resolve(decision: ApprovalDecision): void;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const fail = (status: number, error: string, headers: Record<string, string> = {}): Response => json({ error }, status, headers);

/** Reads a resolved principal. Anything that is not the exact shape is no caller at all. */
function toCaller(context: PrincipalContext | null): Caller | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  const { principalId, kind, chain, scopes } = context;
  if (typeof principalId !== "string" || principalId === "" || !KINDS.includes(kind)) return undefined;
  if (!Array.isArray(chain) || chain.length === 0 || chain[chain.length - 1]?.id !== principalId) return undefined;
  // The kind must agree with the chain: the last step is the caller, and a person has no parent.
  if (chain[chain.length - 1]?.kind !== kind || (kind === "human" && chain.length !== 1)) return undefined;
  const ids = chain.map((step) => step?.id);
  if (ids.some((id) => typeof id !== "string" || id === "")) return undefined;
  const rootId = ids[0] as string;
  if (!Array.isArray(scopes)) return undefined;
  try {
    for (const scope of scopes) parseScope(scope);
  } catch {
    return undefined;
  }
  return { id: principalId, kind, rootId, chain: ids as string[], scopes: [...scopes] };
}

const assistantId = (caller: Caller): string => `assistant:${caller.id}`;

/** Reads a JSON object body. It stops reading at the byte limit, so a body with no length cannot fill memory. */
async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return undefined;
  let text = "";
  if (request.body !== null) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function sseChunk(event: AssistantEvent | { type: "error"; error: string }): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * The hosted API, under `/api/v1`: `GET /tools`, `POST /chat` (a stream of server-sent events),
 * `GET /approvals`, and `POST /approvals/:id/approve` or `/deny`. Every route needs a principal.
 *
 * A pending approval lives in the memory of this object. Run chat and approval on one instance.
 */
export function createAssistantApi(options: AssistantApiOptions): { fetch(request: Request): Promise<Response> } {
  const pending = new Map<string, Pending>();
  const running = new Map<string, number>();
  const maxRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;

  /** Why this caller may not decide on this call, or undefined when it may. */
  function whyNotDecide(caller: Caller, entry: Pending): string | undefined {
    // The proposer is the assistant, and the principal that asked it. A person who asks may decide.
    const { proposer } = entry;
    if (caller.id === assistantId(proposer)) return "an agent cannot decide on its own action";
    if (proposer.kind !== "human") {
      // An agent, an agent it made, and the agent that made it all count as one side. Only the person above them may decide.
      if (caller.chain.includes(proposer.id) || (caller.kind !== "human" && proposer.chain.includes(caller.id))) {
        return "an agent cannot decide on its own action, or on one from an agent it made or that made it";
      }
    }
    if (caller.kind !== "human" && !hasScope(caller.scopes, APPROVER_SCOPE)) {
      return `an agent needs the ${APPROVER_SCOPE} scope to decide`;
    }
    const tool = options.registry.get(entry.request.tool);
    if (tool === undefined || !hasScope(caller.scopes, tool.scope)) return "the approver does not hold the scope of this tool";
    return undefined;
  }

  const gateFor = (proposer: Caller): ApprovalGate => ({
    request(request, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("the request was cancelled"));
        pending.set(request.id, { request, proposer, resolve });
        signal.addEventListener(
          "abort",
          () => {
            pending.delete(request.id);
            reject(new Error("the request was cancelled"));
          },
          { once: true },
        );
      });
    },
  });

  function chat(request: Request, caller: Caller, message: string): Response {
    const abort = new AbortController();
    running.set(caller.id, (running.get(caller.id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (running.get(caller.id) ?? 1) - 1;
      if (left <= 0) running.delete(caller.id);
      else running.set(caller.id, left);
    };
    request.signal.addEventListener(
      "abort",
      () => {
        abort.abort();
        release();
      },
      { once: true },
    );
    let events: AsyncGenerator<AssistantEvent>;
    try {
      events = runAssistant({
        provider: options.provider(),
        registry: options.registry,
        // The assistant holds the caller's scopes and no more.
        principal: createPrincipal({
          id: assistantId(caller),
          kind: "agent_of_human",
          parentId: caller.id,
          scopes: caller.scopes,
          // Each check asks the Auth again. A key revoked during a run, or one with other scopes, stops it.
          isRevoked: async () => {
            const now = toCaller(await options.auth.authenticate(request));
            return now?.id !== caller.id || [...now.scopes].sort().join(" ") !== [...caller.scopes].sort().join(" ");
          },
        }),
        approvals: gateFor(caller),
        messages: [{ role: "user", content: [{ type: "text", text: message }] }],
        system: options.system,
        limits: options.limits,
        signal: abort.signal,
      });
    } catch {
      release();
      return fail(500, "the assistant could not start");
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await events.next();
          if (next.done) {
            release();
            controller.close();
          } else controller.enqueue(sseChunk(next.value));
        } catch {
          // The detail stays on the server. The client gets a plain end of stream.
          release();
          controller.enqueue(sseChunk({ type: "error", error: "the run failed" }));
          controller.close();
        }
      },
      cancel() {
        abort.abort();
        release();
        void events.return(undefined).catch(() => undefined);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }

  async function decide(request: Request, caller: Caller, id: string, approve: boolean): Promise<Response> {
    const body = await readJson(request);
    if (body === undefined) return fail(400, "the body must be a JSON object");
    // From here to the delete there is no await, so two decisions cannot both take the same call.
    const entry = pending.get(id);
    // A call of another owner looks like a call that does not exist.
    if (entry === undefined || entry.proposer.rootId !== caller.rootId) return fail(404, "no pending approval with this id");
    const why = whyNotDecide(caller, entry);
    if (why !== undefined) return fail(403, why);
    let decision: ApprovalDecision;
    if (approve) {
      // The approver names the exact call it saw.
      if (body.digest !== entry.request.digest) return fail(409, "digest does not match the pending call");
      decision = { requestId: id, approved: true, digest: entry.request.digest, decidedBy: caller.id, approverKind: caller.kind === "human" ? "human" : "agent" };
    } else {
      const reason = typeof body.reason === "string" ? body.reason.slice(0, MAX_REASON_CHARS) : undefined;
      decision = { requestId: id, approved: false, decidedBy: caller.id, reason };
    }
    pending.delete(id);
    entry.resolve(decision);
    return json({ requestId: id, approved: approve, decidedBy: caller.id, machineMade: caller.kind !== "human" });
  }

  return {
    async fetch(request) {
      const url = new URL(request.url);
      const match = /^\/api\/v1\/(tools|chat|approvals)(?:\/([^/]+)\/(approve|deny))?\/?$/.exec(url.pathname);
      if (match === null) return fail(404, "not found");
      const [, route, id, verb] = match;
      const allowed = route === "chat" || verb !== undefined ? "POST" : "GET";
      if (request.method !== allowed) return fail(405, "method not allowed", { allow: allowed });
      if (route !== "approvals" && id !== undefined) return fail(404, "not found");

      let caller: Caller | undefined;
      try {
        caller = toCaller(await options.auth.authenticate(request));
      } catch {
        caller = undefined;
      }
      if (caller === undefined) return fail(401, "sign in with a valid key", { "www-authenticate": "Bearer" });

      if (route === "tools") {
        const tools = options.registry
          .list()
          .filter((tool) => hasScope(caller.scopes, tool.scope))
          .map(({ name, description, scope, risk, inputSchema }) => ({ name, description, scope, risk, inputSchema }));
        return json({ tools });
      }
      if (route === "approvals" && verb === undefined) {
        // A call of a tool outside the caller's scopes is not listed, so its arguments stay private.
        const list = [...pending.values()]
          .filter((entry) => entry.proposer.rootId === caller.rootId)
          .filter((entry) => {
            const tool = options.registry.get(entry.request.tool);
            return tool !== undefined && hasScope(caller.scopes, tool.scope);
          })
          .map((entry) => ({
            id: entry.request.id,
            tool: entry.request.tool,
            risk: entry.request.risk,
            input: entry.request.input,
            digest: entry.request.digest,
            proposedBy: entry.request.actor,
            requestedBy: entry.proposer.id,
            canDecide: whyNotDecide(caller, entry) === undefined,
          }));
        return json({ approvals: list });
      }
      if (route === "approvals" && id !== undefined) {
        let requestId: string;
        try {
          requestId = decodeURIComponent(id);
        } catch {
          return fail(404, "no pending approval with this id");
        }
        return decide(request, caller, requestId, verb === "approve");
      }

      // chat
      const body = await readJson(request);
      const message = body?.message;
      if (typeof message !== "string" || message.trim() === "" || message.length > MAX_MESSAGE_CHARS) {
        return fail(400, `message must be a text of 1 to ${MAX_MESSAGE_CHARS} characters`);
      }
      if ((running.get(caller.id) ?? 0) >= maxRuns) return fail(429, "too many chat turns at once", { "retry-after": "5" });
      return chat(request, caller, message);
    },
  };
}
