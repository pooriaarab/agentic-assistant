import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";

// End-to-end test. It starts the built CLI as `mcp` with no model key. Stdin stays open.
// A check that moves after the tool servers start fails with exit 1, because the stub
// tool server closes at once.
//
// Ways the start can fail. Each one is a case below.
// 1. No ANTHROPIC_API_KEY, or an empty one: the process keeps running instead of exiting 2.
// 2. The --api-key-env variable is unset: the same.
// 3. stderr is not one line, does not name the variable, holds a stack trace, or leaks the key value.
// 4. stdout holds anything, so a protocol frame goes out before the refusal.

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const BASE = ["mcp", "--tools", "node -e 0", "--tool-scope", "notes:read", "--scope", "notes:read"];
// Below the Vitest test timeout of 5 s, so this limit fires first.
const EXIT_WITHIN_MS = 3000;

beforeAll(() => {
  if (!existsSync(CLI)) execFileSync("npx", ["tsup"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
});

function start(args: string[], env: Record<string, string>): Promise<{ code: number | null; timedOut: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => ((timedOut = true), child.kill()), EXIT_WITHIN_MS);
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, timedOut, out, err })));
  });
}

describe("mcp start without a model key", () => {
  test("a missing or empty ANTHROPIC_API_KEY exits 2 at once and names the variable", async () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: "" }] as Record<string, string>[]) {
      const r = await start([...BASE, "--use-default-endpoint"], env);
      expect(r.timedOut).toBe(false);
      expect([r.code, r.out]).toEqual([2, ""]);
      expect(r.err).toContain("ANTHROPIC_API_KEY");
      expect(r.err.trimEnd().split("\n")).toHaveLength(1);
      expect(r.err).not.toMatch(/\n\s+at /);
    }
  });

  test("an unset --api-key-env variable exits 2 at once and names it", async () => {
    const args = [...BASE, "--provider", "openai-compatible", "--base-url", "https://models.example.eu/v1", "--model", "m", "--api-key-env", "EU_KEY"];
    const r = await start(args, { ANTHROPIC_API_KEY: "sk-not-this-one" });
    expect(r.timedOut).toBe(false);
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toContain("EU_KEY");
    expect(r.err.trimEnd().split("\n")).toHaveLength(1);
    expect(r.err).not.toContain("sk-not-this-one");
  });
});
