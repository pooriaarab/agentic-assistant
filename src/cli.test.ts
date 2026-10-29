import { describe, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { VERSION } from "./version.js";

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(argv, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
}

describe("cli", () => {
  test("prints help with no arguments", () => {
    const { code, out } = run([]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Usage: agentic-assistant");
  });
  test("prints the version", () => {
    expect(run(["--version"])).toMatchObject({ code: 0, out: [VERSION] });
  });
  test("rejects an unknown command", () => {
    expect(run(["summary"])).toMatchObject({ code: 2 });
  });
});
