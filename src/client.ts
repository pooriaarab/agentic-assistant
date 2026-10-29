// A typed client for the hosted HTTP API. It uses only fetch, URL, and AbortSignal, so it runs in
// browsers, Workers, and Node 22. It never retries: a retried decision or chat turn could apply twice.
import type { ApprovalRequest } from "./approvals.js";
import type { AssistantEvent } from "./loop.js";
import type { Actor } from "./principal.js";

export type { ApprovalRequest } from "./approvals.js";
export type { AssistantEvent, DoneReason, DeniedReason, RunTotals } from "./loop.js";
export type { Actor } from "./principal.js";

/** The error code of a failed call. The client derives it from the HTTP status and the error body. */
export type ApiErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "CONFLICT"
  | "RATE_LIMITED"
  // The demo Worker has no model key set (503 `not_configured`).
  | "NOT_CONFIGURED"
  | "INTERNAL"
  // The reply was not an API reply, for example from a proxy.
  | "UNKNOWN";

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "INVALID_INPUT",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  429: "RATE_LIMITED",
};

/** Thrown for every reply that is not a success. `code` is the error code and `status` is the HTTP status. */
export class AssistantApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Seconds to wait before a new try, from `retry-after` of a 429 reply. */
  readonly retryAfter?: number;

  constructor(code: ApiErrorCode, status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = "AssistantApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface ClientOptions {
  /** The Worker origin, for example https://assistant.example.com. The client adds /api/v1. */
  baseUrl: string;
  /** A bearer credential that the Worker's auth accepts. */
  token: string;
  fetch?: typeof fetch;
}

/** Every method takes an optional signal. An aborted call rejects with the signal reason, not an AssistantApiError. */
export interface CallOptions {
  signal?: AbortSignal;
}

export interface ToolInfo {
  name: string;
  description: string;
  scope: string;
  risk: "safe" | "risky" | "irreversible";
  inputSchema: unknown;
}

export interface PendingApproval {
  id: string;
  tool: string;
  risk: ApprovalRequest["risk"];
  input: Record<string, unknown>;
  /** Send this digest back to approve the exact call. */
  digest: string;
  proposedBy: Actor;
  requestedBy: string;
  /** False when this caller may not decide, for example an agent that asked for the turn. */
  canDecide: boolean;
}

export interface Decision {
  requestId: string;
  approved: boolean;
  decidedBy: string;
  /** True when the decider is not a person. */
  machineMade: boolean;
}

export interface Health {
  ok: boolean;
  pack: string;
  version: string;
}

/** An event of the chat stream. `error` ends the stream: the run failed on the server. */
export type ChatEvent = AssistantEvent | { type: "error"; error: string };

export interface AssistantClient {
  health(options?: CallOptions): Promise<Health>;
  tools(options?: CallOptions): Promise<ToolInfo[]>;
  /**
   * Yields the events of one new conversation, ending with `done` (or `error`). The request is sent on the
   * first read, not when you call `chat`. The stream stays open while a risky call waits for a person.
   * Stop reading, or abort the signal, to stop the run. A stream that ends with no `done` or `error` throws.
   */
  chat(message: string, options?: CallOptions): AsyncGenerator<ChatEvent, void, undefined>;
  approvals(options?: CallOptions): Promise<PendingApproval[]>;
  /** Approves the exact call: `digest` comes from the pending call. A wrong digest is a CONFLICT. */
  approve(id: string, digest: string, options?: CallOptions): Promise<Decision>;
  deny(id: string, reason?: string, options?: CallOptions): Promise<Decision>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown) => typeof v === "string";
const RISKS = ["safe", "risky", "irreversible"];
const isTool = (v: unknown) =>
  isObject(v) && isString(v.name) && isString(v.description) && isString(v.scope) && RISKS.includes(v.risk as string) && "inputSchema" in v;
const isPending = (v: unknown) =>
  isObject(v) && isString(v.id) && isString(v.tool) && RISKS.includes(v.risk as string) && isString(v.digest) && isObject(v.input) && isObject(v.proposedBy) && isString(v.requestedBy) && typeof v.canDecide === "boolean";

// A success reply must have the expected shape, or the call fails. A proxy or a wrong baseUrl can answer 200 with any body.
const SHAPES = {
  health: (v: unknown) => isObject(v) && typeof v.ok === "boolean" && isString(v.pack) && isString(v.version),
  tools: (v: unknown) => isObject(v) && Array.isArray(v.tools) && v.tools.every(isTool),
  approvals: (v: unknown) => isObject(v) && Array.isArray(v.approvals) && v.approvals.every(isPending),
  decision: (v: unknown) => isObject(v) && isString(v.requestId) && typeof v.approved === "boolean" && isString(v.decidedBy) && typeof v.machineMade === "boolean",
};

/** The most characters the client buffers while it waits for the end of one event. */
const MAX_EVENT_CHARS = 4_194_304;
const EVENT_TYPES = ["run_start", "turn_start", "text_delta", "tool_call", "approval_request", "approval_decision", "tool_result", "turn_end", "done", "error"];
/** Checks the fields that a caller reads to tell success from a stop. */
const isEvent = (v: unknown): boolean => {
  if (!isObject(v) || typeof v.type !== "string" || !EVENT_TYPES.includes(v.type)) return false;
  switch (v.type) {
    case "done":
      return isString(v.reason) && isObject(v.totals);
    case "error":
      return isString(v.error);
    case "text_delta":
      return isString(v.text);
    case "tool_result":
      return isString(v.id) && isString(v.name) && isString(v.content) && typeof v.isError === "boolean";
    case "tool_call":
      return isString(v.id) && isString(v.name);
    case "approval_request":
      return isObject(v.request) && isString(v.request.id) && isString(v.request.digest);
    case "approval_decision":
      return isString(v.requestId) && typeof v.approved === "boolean";
    default:
      return true;
  }
};

export function createClient(options: ClientOptions): AssistantClient {
  if (typeof options.baseUrl !== "string" || options.baseUrl === "") throw new TypeError("createClient needs a baseUrl");
  if (typeof options.token !== "string" || options.token === "") throw new TypeError("createClient needs a token");
  let origin: URL;
  try {
    origin = new URL(options.baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  // The token goes in every request, so plain http is for this machine only.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && local)) {
    throw new TypeError("baseUrl must be an https URL, or an http URL on localhost, 127.0.0.1, or [::1]");
  }
  if (origin.search !== "" || origin.hash !== "" || origin.username !== "" || origin.password !== "") {
    throw new TypeError("baseUrl must have no query, hash, or credentials");
  }
  const prefix = origin.pathname.replace(/\/+$/, "");
  const root = `${origin.origin}${prefix}/api/v1`;
  const token = options.token;
  // Read at call time so a test can swap the global. A custom fetch is called as a plain function, with no `this`.
  const send = (input: string, init: RequestInit) => {
    const run = options.fetch ?? globalThis.fetch;
    return run(input, init);
  };
  // A segment of "", ".", or ".." is dropped or resolved by the URL parser, so the call would go to another route.
  const seg = (value: string): string => {
    if (typeof value !== "string" || /^(?:\.|%2e){0,2}$/i.test(value)) throw new TypeError("an id must be a non-empty string that is not . or ..");
    return encodeURIComponent(value);
  };

  async function request(url: string, method: string, body: unknown, callOptions: CallOptions | undefined, authed = true): Promise<Response> {
    const headers: Record<string, string> = authed ? { authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers["content-type"] = "application/json";
    return send(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: callOptions?.signal,
      // Never follow a redirect: it would send the token to another host.
      redirect: "manual",
    });
  }

  async function failure(response: Response): Promise<AssistantApiError> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      parsed = undefined;
    }
    const error = isObject(parsed) ? parsed.error : undefined;
    const message = isObject(parsed) && typeof parsed.message === "string" ? parsed.message : typeof error === "string" ? error : `HTTP ${response.status}`;
    let code: ApiErrorCode = STATUS_CODES[response.status] ?? (response.status >= 500 ? "INTERNAL" : "UNKNOWN");
    if (response.status === 503 && error === "not_configured") code = "NOT_CONFIGURED";
    // A reply with no error body is not from this API.
    if (typeof error !== "string") code = response.status >= 500 ? "INTERNAL" : "UNKNOWN";
    const after = response.headers.get("retry-after")?.trim() ?? "";
    return new AssistantApiError(code, response.status, message, /^\d{1,9}$/.test(after) ? Number(after) : undefined);
  }

  async function call<T>(url: string, method: string, body: unknown, callOptions: CallOptions | undefined, shape: keyof typeof SHAPES, authed = true): Promise<T> {
    const response = await request(url, method, body, callOptions, authed);
    if (!response.ok) throw await failure(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      parsed = undefined;
    }
    if (!SHAPES[shape](parsed)) throw new AssistantApiError("UNKNOWN", response.status, `the reply is not a ${shape}`);
    return parsed as T;
  }

  async function* chat(message: string, callOptions?: CallOptions): AsyncGenerator<ChatEvent, void, undefined> {
    const response = await request(`${root}/chat`, "POST", { message }, callOptions);
    if (!response.ok) throw await failure(response);
    if (!(response.headers.get("content-type") ?? "").startsWith("text/event-stream") || response.body === null) {
      await response.body?.cancel();
      throw new AssistantApiError("UNKNOWN", response.status, "the reply is not an event stream");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    // Reads the complete events in the buffer. A "\r" at the end waits for the next chunk, as it may start "\r\n".
    function* drain(final: boolean): Generator<ChatEvent> {
      const text = final ? buffer : buffer.replace(/\r$/, "");
      const normal = text.replace(/\r\n?/g, "\n");
      const rest = buffer.slice(text.length);
      let from = 0;
      for (let end = normal.indexOf("\n\n", from); end >= 0; end = normal.indexOf("\n\n", from)) {
        const event = parseBlock(normal.slice(from, end), response.status);
        from = end + 2;
        if (event === undefined) continue;
        if (ended) throw new AssistantApiError("UNKNOWN", response.status, "an event came after the end of the stream");
        ended = event.type === "done" || event.type === "error";
        yield event;
      }
      buffer = normal.slice(from) + rest;
    }
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        yield* drain(false);
        if (buffer.length > MAX_EVENT_CHARS) throw new AssistantApiError("UNKNOWN", response.status, "an event is too long");
      }
      buffer += decoder.decode();
      yield* drain(true);
      // The server always ends with "done" or "error". Anything else is a cut stream, not a finished run.
      if (!ended || buffer.trim() !== "") throw new AssistantApiError("UNKNOWN", response.status, "the stream ended before a done event");
    } finally {
      // Stops the run on the server when the caller stops reading.
      await reader.cancel().catch(() => undefined);
    }
  }

  function parseBlock(block: string, status: number): ChatEvent | undefined {
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    // A block with no data is a comment or a keep-alive.
    if (data === "") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = undefined;
    }
    if (!isEvent(parsed)) throw new AssistantApiError("UNKNOWN", status, "an event is not valid");
    return parsed as unknown as ChatEvent;
  }

  // A decision for another call than the one sent is not a decision for this one.
  const decided = (id: string, decision: Decision): Decision => {
    if (decision.requestId !== id) throw new AssistantApiError("UNKNOWN", 200, "the reply is for another approval");
    return decision;
  };

  const methods: AssistantClient = {
    // /health is outside /api/v1 and needs no token, so the client sends none.
    health: async (o) => call(`${origin.origin}${prefix}/health`, "GET", undefined, o, "health", false),
    tools: async (o) => (await call<{ tools: ToolInfo[] }>(`${root}/tools`, "GET", undefined, o, "tools")).tools,
    chat,
    approvals: async (o) => (await call<{ approvals: PendingApproval[] }>(`${root}/approvals`, "GET", undefined, o, "approvals")).approvals,
    approve: async (id, digest, o) => decided(id, await call<Decision>(`${root}/approvals/${seg(id)}/approve`, "POST", { digest }, o, "decision")),
    deny: async (id, reason, o) => decided(id, await call<Decision>(`${root}/approvals/${seg(id)}/deny`, "POST", reason === undefined ? {} : { reason }, o, "decision")),
  };
  return methods;
}
