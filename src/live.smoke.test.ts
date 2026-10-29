import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { AnthropicProvider, ToolRegistry, createPrincipal, runAssistant, type AssistantEvent } from "./index.js";

// A live check against the real Anthropic API. It costs a few cents, so it runs only when you ask:
//   AGENTIC_ASSISTANT_LIVE=1 ANTHROPIC_API_KEY=... npx vitest run src/live.smoke.test.ts
const live = process.env.AGENTIC_ASSISTANT_LIVE === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = process.env.AGENTIC_ASSISTANT_LIVE_MODEL ?? "claude-haiku-5-5";

describe.skipIf(!live)("live smoke test (Anthropic API)", () => {
  test("the loop calls a tool and answers, inside its caps", async () => {
    const calls: Record<string, unknown>[] = [];
    const registry = new ToolRegistry().register({
      name: "add",
      description: "Add two numbers and return the sum.",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
      scope: "math:read",
      risk: "safe",
      handler: (input) => {
        calls.push(input);
        return String(Number(input.a) + Number(input.b));
      },
    });
    const events: AssistantEvent[] = [];
    for await (const event of runAssistant({
      provider: new AnthropicProvider({ model: MODEL, useDefaultEndpoint: true, pricing: { inputPerMTok: 0.5, outputPerMTok: 2.5 } }),
      registry,
      principal: createPrincipal({ id: "agent:live", kind: "agent_of_human", parentId: "human:live", scopes: ["math:read"] }),
      messages: [{ role: "user", content: [{ type: "text", text: "Use the add tool to add 17 and 25. Then tell me the sum in one short sentence." }] }],
      limits: { maxTurns: 4, maxTotalTokens: 20_000, maxCostUsd: 0.25 },
          })) events.push(event);
    const end = events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
    expect(end.reason, end.error).toBe("end_turn");
    expect(calls).toHaveLength(1);
    expect([calls[0]?.a, calls[0]?.b].sort()).toEqual([17, 25]);
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toContain("42");
    expect(end.totals.inputTokens).toBeGreaterThan(0);
    expect(end.totals.outputTokens).toBeGreaterThan(0);
    expect(end.totals.costUsd).toBeGreaterThan(0);
  }, 120_000);

  test("the CLI drives a real MCP server with the real model", () => {
    const out = execFileSync(
      process.execPath,
      [
        new URL("../dist/cli.js", import.meta.url).pathname,
        "chat",
        "--tools",
        JSON.stringify([process.execPath, new URL("../test-fixtures/notes-stdio.mjs", import.meta.url).pathname]),
        "--scope", "notes:read", "--tool-scope", "notes:read", "--tool-risk", "safe",
        "--model", MODEL, "--use-default-endpoint", "--json", "--max-tokens", "20000",
        "Call the notes_read tool with id n1 and quote what it returns.",
      ],
      {
        // Some keys are tied to a workspace, and the SDK reads that header from the environment.
        env: {
          PATH: process.env.PATH,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          ...(process.env.ANTHROPIC_CUSTOM_HEADERS ? { ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS } : {}),
        },
        encoding: "utf8",
        timeout: 110_000,
      },
    );
    const events = out.trim().split("\n").map((line) => JSON.parse(line) as AssistantEvent);
    expect(events.some((e) => e.type === "tool_call" && e.name === "notes_read")).toBe(true);
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toContain("note n1");
  }, 120_000);
});
