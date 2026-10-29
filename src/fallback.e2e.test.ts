import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { FallbackProvider, OpenAICompatibleProvider, ToolRegistry, createPrincipal, runAssistant, type AssistantEvent, type ModelEvent, type ModelProvider, type ModelRequest } from "./index.js";
import { runCli, type CliIo } from "./cli.js";
import { ScriptedProvider, type ScriptedTurn } from "./testing.js";
import { serveNotes } from "../test-fixtures/notes-http.mjs";

// Ways the fallback can fail. Each one is a case below.
// 1. A refusal or an error stops the run when a fallback model is set.
// 2. The fallback runs when the first model answered well, or runs twice.
// 3. The event does not say which model answered.
// 4. Text from the refused turn reaches the user before the fallback text.
// 5. A refusal from the fallback is shown as success.
// 6. Tokens of the refused ask are not counted, so a cap sees too little.
// 7. A stopped run starts the fallback.
// 8. A cost cap uses the cheaper price when the dearer model answers.
// 9. The CLI flag does not reach a real endpoint.
// 10. The fallback spends past a token or cost cap: its budget is not cut by what the first ask used.
// 11. A first ask that failed after it streamed is not counted.
// 12. An empty --fallback-model is accepted.
// 13. A bad token count from the second ask is hidden by the sum, or a nested pair or a bad maxAsks widens the room.
// 14. A refusal that comes after the run stopped still starts the second ask.
// 15. A nested pair names the model that refused instead of the one that answered.
// 16. A bad token count from the first ask (negative, not whole) widens the room of the second.

const message = (text: string) => [{ role: "user" as const, content: [{ type: "text" as const, text }] }];

class Named extends ScriptedProvider {
  constructor(
    readonly model: string,
    ...rest: ConstructorParameters<typeof ScriptedProvider>
  ) {
    super(...rest);
  }
}

class Broken implements ModelProvider {
  readonly name = "broken";
  readonly model = "broken-1";
  calls = 0;
  // eslint-disable-next-line require-yield
  async *stream(request: ModelRequest): AsyncGenerator<never> {
    this.calls++;
    if (request.signal?.aborted) throw new Error("aborted");
    throw new Error("503 from the model");
  }
}

async function run(provider: ModelProvider, extra: Partial<Parameters<typeof runAssistant>[0]> = {}): Promise<AssistantEvent[]> {
  const events: AssistantEvent[] = [];
  const principal = createPrincipal({ id: "agent:a", kind: "agent_of_human", parentId: "human:ana", scopes: [] });
  for await (const event of runAssistant({ provider, registry: new ToolRegistry(), principal, messages: message("go"), ...extra })) events.push(event);
  return events;
}
const done = (events: AssistantEvent[]) => events.find((e): e is Extract<AssistantEvent, { type: "done" }> => e.type === "done");
const turn = (events: AssistantEvent[]) => events.find((e): e is Extract<AssistantEvent, { type: "turn_end" }> => e.type === "turn_end");
const text = (events: AssistantEvent[]) => events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");

describe("FallbackProvider", () => {
  test("a refusal on the first model is answered by the fallback, and the event names it", async () => {
    const primary = new Named("big-1", [{ text: "partial ", stopReason: "refusal", usage: { inputTokens: 20, outputTokens: 2 } }]);
    const fallback = new Named("small-1", [{ text: "Here is the answer.", usage: { inputTokens: 30, outputTokens: 4 } }]);
    const events = await run(new FallbackProvider(primary, fallback));
    expect(done(events)?.reason).toBe("end_turn");
    expect(text(events)).toBe("Here is the answer.");
    expect(turn(events)?.answeredBy).toEqual({ provider: "scripted", model: "small-1", fallback: true, fallbackFor: "refusal" });
    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
    expect(fallback.requests[0]?.messages).toEqual(primary.requests[0]?.messages);
    // Tokens of both asks count.
    expect(done(events)?.totals).toMatchObject({ inputTokens: 50, outputTokens: 6 });
  });

  test("an error on the first model is answered by the fallback", async () => {
    const primary = new Broken();
    const fallback = new Named("small-1", [{ text: "ok" }]);
    const events = await run(new FallbackProvider(primary, fallback));
    expect(done(events)?.reason).toBe("end_turn");
    expect(turn(events)?.answeredBy).toMatchObject({ model: "small-1", fallback: true, fallbackFor: "error" });
    expect(primary.calls).toBe(1);
  });

  test("a good first answer never touches the fallback, and names the first model", async () => {
    const primary = new Named("big-1", [{ text: "fine" }]);
    const fallback = new Named("small-1", []);
    const events = await run(new FallbackProvider(primary, fallback));
    expect(text(events)).toBe("fine");
    expect(turn(events)?.answeredBy).toEqual({ provider: "scripted", model: "big-1", fallback: false });
    expect(fallback.requests).toHaveLength(0);
  });

  test("the fallback is tried once: a refusal from it stops the run as a refusal", async () => {
    const primary = new Named("big-1", [{ text: "no", stopReason: "refusal" }]);
    const fallback = new Named("small-1", [{ text: "also no", stopReason: "refusal" }, { text: "third" }]);
    const events = await run(new FallbackProvider(primary, fallback));
    expect(done(events)?.reason).toBe("refusal");
    expect(fallback.requests).toHaveLength(1);
  });

  test("two errors stop the run with provider_error", async () => {
    const events = await run(new FallbackProvider(new Broken(), new Broken()));
    expect(done(events)).toMatchObject({ reason: "provider_error", error: "503 from the model" });
  });

  test("a stopped run does not start the fallback", async () => {
    const controller = new AbortController();
    const fallback = new Named("small-1", [{ text: "late" }]);
    const failing: ModelProvider = {
      name: "slow",
      model: "slow-1",
      // eslint-disable-next-line require-yield
      async *stream() {
        controller.abort();
        throw new Error("cancelled");
      },
    };
    const events = await run(new FallbackProvider(failing, fallback), { signal: controller.signal });
    expect(done(events)?.reason).toBe("aborted");
    expect(fallback.requests).toHaveLength(0);
  });

  test("a cost cap uses the higher price of the two models", async () => {
    const primary = new Named("big-1", [{ text: "x", stopReason: "refusal", usage: { inputTokens: 1000, outputTokens: 0 } }], { inputPerMTok: 1, outputPerMTok: 1 });
    const fallback = new Named("small-1", [{ text: "y", usage: { inputTokens: 1000, outputTokens: 0 } }], { inputPerMTok: 10, outputPerMTok: 10 });
    const provider = new FallbackProvider(primary, fallback);
    expect(provider.pricing).toEqual({ inputPerMTok: 10, outputPerMTok: 10 });
    const events = await run(provider);
    expect(done(events)?.totals.costUsd).toBeCloseTo(0.02, 10);
  });

  test("the fallback gets only the output budget that the first ask left", async () => {
    // maxTotalTokens 400 leaves a room of a few hundred tokens for one ask. The refused ask used 60 of the output room.
    const primary = new Named("big-1", [{ text: "no", stopReason: "refusal", usage: { inputTokens: 10, outputTokens: 60 } }]);
    const fallback = new Named("small-1", [{ text: "ok", usage: { inputTokens: 10, outputTokens: 5 } }]);
    const events = await run(new FallbackProvider(primary, fallback), { limits: { maxTotalTokens: 400 } });
    const first = primary.requests[0]?.maxOutputTokens as number;
    expect(fallback.requests[0]?.maxOutputTokens).toBe(first - 60);
    // The pre-check counted the input of both asks, so the first room is cut too.
    const single = new Named("single-1", [{ text: "ok" }]);
    await run(single, { limits: { maxTotalTokens: 400 } });
    expect(first).toBeLessThan(single.requests[0]?.maxOutputTokens as number);
    expect(done(events)?.reason).toBe("end_turn");
  });

  test("a refusal that used the whole output room is returned as a refusal, with no second ask", async () => {
    const primary = new Named("big-1", [{ text: "no", stopReason: "refusal", usage: { inputTokens: 10, outputTokens: 4096 } }]);
    const fallback = new Named("small-1", [{ text: "late" }]);
    const events = await run(new FallbackProvider(primary, fallback));
    expect(done(events)?.reason).toBe("refusal");
    expect(fallback.requests).toHaveLength(0);
    expect(turn(events)?.answeredBy).toMatchObject({ model: "big-1", fallback: false });
  });

  test("a first ask that failed after it streamed is counted by an estimate", async () => {
    const dropped: ModelProvider = {
      name: "dropped",
      model: "dropped-1",
      async *stream() {
        yield { type: "text_delta", text: "x".repeat(300) };
        throw new Error("connection reset");
      },
    };
    const fallback = new Named("small-1", [{ text: "ok", usage: { inputTokens: 10, outputTokens: 5 } }]);
    const events = await run(new FallbackProvider(dropped, fallback));
    const totals = done(events)?.totals;
    // 300 characters of output at 3 per token is 100 tokens, and the input is counted again.
    expect(totals?.outputTokens).toBe(105);
    expect(totals?.inputTokens).toBeGreaterThan(10);
    expect(text(events)).toBe("ok");
  });

  test("a first ask that failed before it streamed anything costs nothing", async () => {
    const events = await run(new FallbackProvider(new Broken(), new Named("small-1", [{ text: "ok", usage: { inputTokens: 10, outputTokens: 5 } }])));
    expect(done(events)?.totals).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  test("a bad token count from the first ask stops the run, and the fallback is not asked", async () => {
    for (const outputTokens of [-5000, 1.5, Number.NaN]) {
      const primary = new Named("big-1", [{ text: "no", stopReason: "refusal", usage: { inputTokens: 10, outputTokens } }]);
      const fallback = new Named("small-1", [{ text: "ok" }]);
      const events = await run(new FallbackProvider(primary, fallback));
      expect(done(events)?.reason, String(outputTokens)).toBe("provider_error");
      expect(fallback.requests).toHaveLength(0);
    }
  });

  test("the estimate for a first ask that failed after it streamed counts the system text and the tools too", async () => {
    const dropped: ModelProvider = {
      name: "dropped",
      model: "dropped-1",
      async *stream() {
        yield { type: "text_delta", text: "hi" };
        throw new Error("connection reset");
      },
    };
    const request = { system: "s".repeat(3000), messages: [], tools: [], maxOutputTokens: 100 };
    const out: ModelEvent[] = [];
    for await (const event of new FallbackProvider(dropped, new Named("small-1", [{ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } }])).stream(request)) out.push(event);
    const final = out.at(-1) as Extract<ModelEvent, { type: "message" }>;
    expect(final.usage.inputTokens).toBeGreaterThanOrEqual(1000);
  });

  test("a bad token count from the fallback stops the run, as it does with one model", async () => {
    const primary = new Named("big-1", [{ text: "no", stopReason: "refusal", usage: { inputTokens: 10, outputTokens: 100 } }]);
    const fallback = new Named("small-1", [{ text: "ok", usage: { inputTokens: 10, outputTokens: -90 } }]);
    expect(done(await run(new FallbackProvider(primary, fallback)))?.reason).toBe("provider_error");
  });

  test("a nested pair counts every ask, so the room is cut for three models", async () => {
    const limited = { system: "s".repeat(300), limits: { maxTotalTokens: 1000 } };
    // The room that the loop gives the first model, when the pair of models is wrapped as given.
    const roomFor = async (wrap: (first: Named) => FallbackProvider | Named) => {
      const first = new Named("a", [{ text: "ok" }]);
      await run(wrap(first), limited);
      return first.requests[0]?.maxOutputTokens as number;
    };
    const none = new Named("x", []);
    const single = await roomFor((first) => first);
    const pair = await roomFor((first) => new FallbackProvider(first, none));
    const nested = await roomFor((first) => new FallbackProvider(new FallbackProvider(first, none), none));
    expect(new FallbackProvider(new FallbackProvider(none, none), none).maxAsks).toBe(3);
    expect(pair).toBeLessThan(single);
    expect(nested).toBeLessThan(pair);
  });

  test("a nested pair names the model that really answered", async () => {
    const refuse = { text: "no", stopReason: "refusal" as const };
    const who = async (a: ScriptedTurn, b: ScriptedTurn, c: ScriptedTurn, wrap: "first" | "second") => {
      const [pa, pb, pc] = [new Named("a", [a]), new Named("b", [b]), new Named("c", [c])];
      const provider = wrap === "first" ? new FallbackProvider(new FallbackProvider(pa, pb), pc) : new FallbackProvider(pa, new FallbackProvider(pb, pc));
      return turn(await run(provider))?.answeredBy;
    };
    const ok = { text: "ok" };
    expect(await who(ok, ok, ok, "first")).toEqual({ provider: "scripted", model: "a", fallback: false });
    expect(await who(refuse, ok, ok, "first")).toEqual({ provider: "scripted", model: "b", fallback: true, fallbackFor: "refusal" });
    expect(await who(refuse, refuse, ok, "first")).toEqual({ provider: "scripted", model: "c", fallback: true, fallbackFor: "refusal" });
    expect(await who(refuse, refuse, ok, "second")).toEqual({ provider: "scripted", model: "c", fallback: true, fallbackFor: "refusal" });
    expect(await who(refuse, ok, ok, "second")).toEqual({ provider: "scripted", model: "b", fallback: true, fallbackFor: "refusal" });
  });

  test("a bad maxAsks is refused before a model is asked", async () => {
    for (const maxAsks of [0, -1, 1.5, Number.NaN]) {
      const provider = Object.assign(new Named("a", [{ text: "x" }]), { maxAsks });
      await expect(run(provider), String(maxAsks)).rejects.toThrow(/maxAsks/);
      expect(provider.requests).toHaveLength(0);
    }
  });

  test("a refusal that arrives after the run was stopped does not start the fallback", async () => {
    const controller = new AbortController();
    const primary: ModelProvider = {
      name: "refuser",
      model: "refuser-1",
      async *stream() {
        controller.abort();
        yield { type: "message", content: [], stopReason: "refusal", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const fallback = new Named("small-1", [{ text: "late" }]);
    const events = await run(new FallbackProvider(primary, fallback), { signal: controller.signal });
    expect(fallback.requests).toHaveLength(0);
    expect(done(events)?.reason).toBe("refusal");
  });

  test("one model without a price leaves the pair without a price", () => {
    const priced = new Named("a", [], { inputPerMTok: 1, outputPerMTok: 1 });
    expect(new FallbackProvider(priced, new Named("b", [])).pricing).toBeUndefined();
  });
});

describe("--fallback-model", () => {
  let server: Server | undefined;
  let notes: Awaited<ReturnType<typeof serveNotes>> | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    await notes?.close();
  });

  async function chat(extra: string[]): Promise<{ code: number; out: string; err: string; asked: string[] }> {
    const asked: string[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const model = JSON.parse(raw).model as string;
        asked.push(model);
        if (model === "first-model") {
          res.writeHead(500).end("down");
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "from the backup" }, finish_reason: "stop" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    notes = await serveNotes();
    let out = "";
    let err = "";
    const io: CliIo = {
      out: (t) => void (out += t),
      err: (t) => void (err += `${t}\n`),
      env: {},
      readFile: () => "",
      readStdin: async () => "",
      isTTY: false,
      ask: async () => "",
    };
    const code = await runCli(
      ["chat", "--tools", notes.url, "--scope", "notes:read", "--tool-scope", "notes:read", "--provider", "openai-compatible", "--base-url", `http://127.0.0.1:${port}`, "--model", "first-model", ...extra, "go"],
      io,
    );
    return { code, out, err, asked };
  }

  test("the CLI retries on the fallback model and says so", async () => {
    const result = await chat(["--fallback-model", "backup-model"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("from the backup");
    expect(result.err).toContain("fallback model answered: backup-model (first model failed: error)");
    expect(result.asked).toEqual(["first-model", "backup-model"]);
  });

  test("an empty --fallback-model is a usage error", async () => {
    const result = await chat(["--fallback-model", ""]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--fallback-model needs a model id");
    expect(result.asked).toEqual([]);
  });

  test("without the flag the same failure stops the run", async () => {
    const result = await chat([]);
    expect(result.code).toBe(1);
    expect(result.asked).toEqual(["first-model"]);
  });
});
