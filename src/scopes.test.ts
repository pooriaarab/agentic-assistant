import { describe, expect, test } from "vitest";
import { hasScope, scopeCovers } from "./scopes.js";

// Ways scope math can fail. Each one is a case below.
// 1. A weaker grant covers a stronger need (read covers write).
// 2. A grant for one resource covers another resource.
// 3. A wildcard resource fails to cover, or covers a stronger action.
// 4. A malformed granted scope matches (fail open).
// 5. A malformed required scope is allowed (fail open).
// 6. An empty grant list allows something.
describe("scope covers", () => {
  test.each([
    ["docs:write", "docs:read", true],
    ["docs:write", "docs:write", true],
    ["docs:read", "docs:write", false],
    ["docs:comment", "docs:write", false],
    ["docs:admin", "docs:comment", true],
    ["docs:write", "drive:read", false],
    ["*:read", "drive:read", true],
    ["*:read", "drive:write", false],
  ])("%s covers %s: %s", (grant, required, expected) => {
    expect(scopeCovers(grant, required)).toBe(expected);
  });

  test("a malformed granted scope never matches", () => {
    expect(hasScope(["docs:delete", "nonsense", ""], "docs:read")).toBe(false);
    expect(hasScope(["docs:delete", "docs:read"], "docs:read")).toBe(true);
  });

  test("a malformed required scope is denied", () => {
    expect(hasScope(["*:admin"], "docs:delete")).toBe(false);
  });

  test("no grants allow nothing", () => {
    expect(hasScope([], "docs:read")).toBe(false);
  });
});
