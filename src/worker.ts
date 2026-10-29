import { createAssistantApi, type AssistantApiOptions } from "./api.js";
import { VERSION } from "./version.js";

export { APPROVER_SCOPE, createAssistantApi } from "./api.js";
export type { AssistantApiOptions } from "./api.js";
export { createStaticTokenAuth } from "./static-auth.js";
export type { StaticTokenEntry } from "./static-auth.js";

export interface WorkerEnv {
  PACK_NAME?: string;
}

const health = (env: WorkerEnv): Response => Response.json({ ok: true, pack: env.PACK_NAME ?? "agentic-assistant", version: VERSION });

/** A Worker that serves `/health` and the `/api/v1` routes. Build the options in your own entry file. */
export function createWorker(options: AssistantApiOptions): { fetch(request: Request, env?: WorkerEnv): Promise<Response> } {
  const api = createAssistantApi(options);
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return health(env);
      if (url.pathname.startsWith("/api/v1/")) return api.fetch(request);
      return Response.json({ error: "not found" }, { status: 404 });
    },
  };
}
