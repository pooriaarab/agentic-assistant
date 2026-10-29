import type { AssistantApiOptions } from "./api.js";
import { DEMO_CSP, DEMO_PAGE } from "./demo-page.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { createStaticTokenAuth, type StaticTokenEntry } from "./static-auth.js";
import { ToolRegistry } from "./tools.js";
import { VERSION } from "./version.js";
import { createWorker } from "./worker.js";

export interface DemoEnv {
  PACK_NAME?: string;
  /** Secret. A JSON map of bearer token (32 bytes or more) to `{ "id": "...", "scopes": ["demo:read"] }`. Unset means every call is a 401. */
  ASSISTANT_TOKENS?: string;
  /** Secret. The model API key. Unset means chat answers 503 "not_configured". */
  MODEL_KEY?: string;
  /** Base URL of the model endpoint, for example an EU-hosted gateway. */
  MODEL_URL?: string;
  /** Set to "1" to call api.anthropic.com, a US-hosted endpoint, when `MODEL_URL` is not set. */
  MODEL_USE_DEFAULT_ENDPOINT?: string;
  MODEL_NAME?: string;
}

const demoRegistry = (): ToolRegistry =>
  new ToolRegistry().register({
    name: "demo_time",
    description: "Return the current UTC time as an ISO 8601 text.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    scope: "demo:read",
    risk: "safe",
    handler: () => ({ now: new Date().toISOString() }),
  });

const DEMO_SYSTEM = "You are a demo assistant. You may use the demo_time tool. Answer in short, plain text.";

function modelOptions(env: DemoEnv): { apiKey: string; baseUrl?: string; useDefaultEndpoint?: boolean; model?: string } | undefined {
  if (!env.MODEL_KEY) return undefined;
  if (env.MODEL_URL) return { apiKey: env.MODEL_KEY, baseUrl: env.MODEL_URL, model: env.MODEL_NAME || undefined };
  if (env.MODEL_USE_DEFAULT_ENDPOINT === "1") return { apiKey: env.MODEL_KEY, useDefaultEndpoint: true, model: env.MODEL_NAME || undefined };
  return undefined;
}

const notConfigured = (message: string): Response =>
  Response.json({ error: "not_configured", message }, { status: 503, headers: { "cache-control": "no-store" } });

interface Demo {
  worker: ReturnType<typeof createWorker>;
  auth: AssistantApiOptions["auth"];
}

// One build per env object. The API keeps pending approvals in memory, so a new one per request would lose them.
const demos = new WeakMap<object, Promise<Demo>>();

async function buildDemo(env: DemoEnv): Promise<Demo> {
  const tokens = env.ASSISTANT_TOKENS ? (JSON.parse(env.ASSISTANT_TOKENS) as Record<string, StaticTokenEntry>) : {};
  const auth = await createStaticTokenAuth(tokens);
  const worker = createWorker({
    auth,
    registry: demoRegistry(),
    system: DEMO_SYSTEM,
    limits: { maxTurns: 4, maxTotalTokens: 20_000, maxOutputTokensPerTurn: 1024 },
    provider: () => {
      const options = modelOptions(env);
      if (options === undefined) throw new Error("no model");
      return new AnthropicProvider(options);
    },
  });
  return { worker, auth };
}

/**
 * The demo Worker. It serves a demo page at `/`, `/health`, and the `/api/v1` routes with bearer auth.
 * It never fakes output: with no tokens every call is a 401, and with no model key chat answers 503.
 */
export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, pack: env.PACK_NAME ?? "agentic-assistant", version: VERSION });
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(DEMO_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": DEMO_CSP, "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    if (!url.pathname.startsWith("/api/v1/")) return Response.json({ error: "not found" }, { status: 404 });
    let demo: Demo;
    try {
      let built = demos.get(env);
      if (built === undefined) demos.set(env, (built = buildDemo(env)));
      demo = await built;
    } catch {
      demos.delete(env);
      return notConfigured("this demo is not set up");
    }
    if (request.method === "POST" && url.pathname.replace(/\/$/, "") === "/api/v1/chat" && modelOptions(env) === undefined) {
      // Sign-in comes first, so a caller with no key learns nothing from this answer.
      if ((await demo.auth.authenticate(request.clone())) !== null) return notConfigured("this demo has no model key or model endpoint set");
    }
    return demo.worker.fetch(request, env);
  },
};
