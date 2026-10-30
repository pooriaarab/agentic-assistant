// Failure cases: invalid subjects must fail; retries must stay empty; registry
// export must accept the contributor; host-owned output must not be claimed.
import { createMemoryStore, PRINCIPAL_KINDS } from "agentic-identity";
import { createAccountRegistry } from "agentic-identity/account";
import { describe, expect, it } from "vitest";
import { assistantAccount } from "./account.js";
import { createPrincipal, runAssistant, ToolRegistry } from "./index.js";
import { ScriptedProvider } from "./testing.js";

const subject = { id: "ana", kind: "human" } as const;

describe("assistant account boundary", () => {
  it.each([null, {}, { id: "ana" }, { id: "", kind: "human" },
    { id: "ana", kind: "robot" }, { id: 42, kind: "human" },
    { id: "  ", kind: "human" }])("refuses a damaged subject %j", async (bad) => {
    await expect(assistantAccount.exportAccount(bad as never, undefined)).rejects.toThrow();
    await expect(assistantAccount.eraseAccount(bad as never, undefined)).rejects.toThrow();
  });

  it("supports every principal kind and repeated erase", async () => {
    for (const kind of PRINCIPAL_KINDS) {
      const who = { id: "ana", kind };
      expect(await assistantAccount.exportAccount(who, undefined)).toEqual({});
      expect(await assistantAccount.eraseAccount(who, undefined)).toEqual({});
      expect(await assistantAccount.eraseAccount(who, undefined)).toEqual({});
    }
  });

  it("registers directly with the identity account registry", async () => {
    const registry = createAccountRegistry().register(assistantAccount, undefined);
    const { manifest } = await registry.export(subject, { now: () => 0 });
    expect(manifest.apps).toEqual([{ id: "assistant", files: [] }]);
    const result = await registry.erase(subject, createMemoryStore(), { actor: null });
    expect(result.counts.assistant).toEqual({});
  });

  it("returns machine-made run output while account records and counts stay empty", async () => {
    const events = [];
    for await (const event of runAssistant({
      provider: new ScriptedProvider([{ text: "A private answer" }]),
      registry: new ToolRegistry(),
      principal: createPrincipal({ id: "agent-a", kind: "agent_of_human", parentId: "ana", scopes: [] }),
      messages: [{ role: "user", content: [{ type: "text", text: "A private question" }] }],
    })) events.push(event);
    const done = events.find((e) => e.type === "done")!;
    expect(done.provenance?.generator).toBe("ai");
    expect(await assistantAccount.exportAccount(subject, undefined)).toEqual({});
    expect(await assistantAccount.eraseAccount(subject, undefined)).toEqual({});
    expect(await assistantAccount.exportAccount(subject, undefined)).toEqual({});
  });
});
