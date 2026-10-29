import { VERSION } from "./version.js";

export interface WorkerEnv {
  PACK_NAME?: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, pack: env.PACK_NAME ?? "agentic-assistant", version: VERSION });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
