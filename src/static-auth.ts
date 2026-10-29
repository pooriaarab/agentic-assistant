import { createMemoryStore, createStoreAuth, type Auth } from "agentic-identity";
import { parseScope } from "./scopes.js";

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
 * An `agentic-identity` Auth (`createStoreAuth` over a memory Store) for a fixed map of bearer tokens.
 * It keeps only SHA-256 digests. It throws on a token shorter than 32 bytes or an entry of the wrong shape.
 * An empty map is allowed: every request is then a 401.
 */
export async function createStaticTokenAuth(tokens: Record<string, StaticTokenEntry>): Promise<Auth> {
  // The tokens sit in a memory Store as digests. `createStoreAuth` reads the credential, so this file parses no header.
  const store = createMemoryStore();
  const ids = new Set<string>();
  for (const [token, entry] of Object.entries(tokens)) {
    if (encoder.encode(token).length < MIN_TOKEN_BYTES) throw new Error(`tokens must hold at least ${MIN_TOKEN_BYTES} bytes`);
    // The identity middleware refuses any other Bearer token with a 401, so such a token could never sign in.
    if (/\s/.test(token)) throw new Error("a token may not hold white space");
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) throw new Error("a token may hold only A-Z a-z 0-9 _ - and at most 512 characters");
    // A field such as `kind` would be dropped, and the caller would sign in as a person. Refuse it.
    if (typeof entry !== "object" || entry === null || Object.keys(entry).some((key) => key !== "id" && key !== "scopes")) {
      throw new Error("a token entry has only an id and scopes: every caller is a person");
    }
    if (typeof entry?.id !== "string" || entry.id === "" || !Array.isArray(entry.scopes) || entry.scopes.some((s) => typeof s !== "string")) {
      throw new Error("each token needs an id and a list of scopes");
    }
    for (const scope of entry.scopes) parseScope(scope);
    if (ids.has(entry.id)) throw new Error("each token needs its own id");
    ids.add(entry.id);
    await store.put("principals", entry.id, { id: entry.id, kind: "human", scopes: [...entry.scopes] });
    await store.put("credentials", await digest(token), { principalId: entry.id, kind: "api_key" });
  }
  return createStoreAuth(store);
}
