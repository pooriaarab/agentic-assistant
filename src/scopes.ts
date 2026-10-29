// Scope format and cover rules match agentic-identity: `<resource>:<action>`,
// where the resource is a type name or `*`. A stronger action covers a weaker one.
export const ACTIONS = ["read", "comment", "write", "admin"] as const;
export type Action = (typeof ACTIONS)[number];
export type Scope = string;

const SCOPE_PATTERN = /^(\*|[a-z][a-z0-9_-]*):(read|comment|write|admin)$/;

export function parseScope(scope: Scope): { resource: string; action: Action } {
  const match = typeof scope === "string" ? SCOPE_PATTERN.exec(scope) : null;
  if (!match) throw new Error(`invalid scope "${String(scope)}"`);
  return { resource: match[1] as string, action: match[2] as Action };
}

const level = (action: Action): number => ACTIONS.indexOf(action);

/** True when `grant` allows everything `required` asks for. */
export function scopeCovers(grant: Scope, required: Scope): boolean {
  const g = parseScope(grant);
  const r = parseScope(required);
  return (g.resource === "*" || g.resource === r.resource) && level(g.action) >= level(r.action);
}

/** True when any granted scope covers the required one. A malformed scope never matches. */
export function hasScope(granted: readonly Scope[], required: Scope): boolean {
  return granted.some((scope) => {
    try {
      return scopeCovers(scope, required);
    } catch {
      return false;
    }
  });
}
