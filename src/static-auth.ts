import type { Auth, PrincipalContext } from "agentic-identity";

/** What one bearer token stands for. The caller is always a person: `kind: "human"`. */
export interface StaticTokenEntry {
  id: string;
  scopes: string[];
}

const MIN_TOKEN_BYTES = 32;
const encoder = new TextEncoder();

async function digest(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * An `agentic-identity` Auth that reads `Authorization: Bearer <token>` against a fixed map.
 * It keeps only SHA-256 digests. It throws on a token shorter than 32 bytes or an entry of the wrong shape.
 * An empty map is allowed: every request is then a 401.
 */
export async function createStaticTokenAuth(tokens: Record<string, StaticTokenEntry>): Promise<Auth> {
  const byDigest = new Map<string, PrincipalContext>();
  for (const [token, entry] of Object.entries(tokens)) {
    if (encoder.encode(token).length < MIN_TOKEN_BYTES) throw new Error(`tokens must hold at least ${MIN_TOKEN_BYTES} bytes`);
    if (typeof entry?.id !== "string" || entry.id === "" || !Array.isArray(entry.scopes) || entry.scopes.some((s) => typeof s !== "string")) {
      throw new Error("each token needs an id and a list of scopes");
    }
    byDigest.set(await digest(token), {
      principalId: entry.id,
      kind: "human",
      chain: [{ id: entry.id, kind: "human" }],
      scopes: [...entry.scopes],
    });
  }
  return {
    async authenticate(request) {
      const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "");
      const context = match ? byDigest.get(await digest(match[1] as string)) : undefined;
      return context ? { ...context, chain: context.chain.map((step) => ({ ...step })), scopes: [...context.scopes] } : null;
    },
  };
}
