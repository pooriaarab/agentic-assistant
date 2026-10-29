import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  DATA_NOTICE,
  AnthropicProvider,
  OpenAICompatibleProvider,
  ToolRegistry,
  createPrincipal,
  runAssistant,
  type AssistantEvent,
  type ModelProvider,
} from "./index.js";

// Ways an adapter can fail. Each one is a case below.
// 1. The request body is wrong: model, tools, tool results, or a stray sampling parameter.
// 2. Reasoning blocks are dropped between turns, so the next request is rejected.
// 3. Streamed text or tool input arrives split and is assembled wrong.
// 4. Usage is missing and the caps go blind instead of failing.
// 5. A plain-HTTP remote endpoint is accepted and would send the key in the clear.
// 6. A server error is reported as a success.
// 7. Tool arguments that are not JSON reach a handler.

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, any>;
}

let server: Server | undefined;
afterEach(() => server?.close());

async function serve(respond: (seen: Seen, call: number) => { status?: number; chunks: string[] }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const entry = { url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) };
      seen.push(entry);
      const { status = 200, chunks } = respond(entry, seen.length);
      res.writeHead(status, { "content-type": "text/event-stream" });
      for (const chunk of chunks) res.write(chunk);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server?.address() as AddressInfo).port}`, seen };
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const anthropicTurn = (blocks: unknown[], stop: string, usage = { input_tokens: 25, output_tokens: 7 }, cache = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) => [
  sse("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1, ...cache } } }),
  ...blocks.flatMap((b, i) => blockEvents(b as any, i)),
  sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }),
  sse("message_stop", { type: "message_stop" }),
];
function blockEvents(block: { type: string; [k: string]: any }, index: number): string[] {
  if (block.type === "thinking") {
    return [
      sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }),
      sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }),
      sse("content_block_stop", { type: "content_block_stop", index }),
    ];
  }
  if (block.type === "text") {
    return [
      sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }),
      ...block.parts.map((text: string) => sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } })),
      sse("content_block_stop", { type: "content_block_stop", index }),
    ];
  }
  return [
    sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }),
    ...block.parts.map((partial_json: string) => sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } })),
    sse("content_block_stop", { type: "content_block_stop", index }),
  ];
}

function harness(provider: ModelProvider) {
  const calls: unknown[] = [];
  const registry = new ToolRegistry()
    .register({ name: "notes_read", description: "Read a note", inputSchema: { type: "object", properties: { id: { type: "string" } } }, scope: "notes:read", risk: "safe", handler: (input) => { calls.push(input); return "note body"; } })
    .register({ name: "notes_delete", description: "Delete", inputSchema: { type: "object" }, scope: "notes:write", risk: "safe", handler: () => "gone" });
  const run = async (): Promise<AssistantEvent[]> => {
    const events: AssistantEvent[] = [];
    for await (const e of runAssistant({
      provider,
      registry,
      principal: createPrincipal({ id: "a", kind: "agent_of_human", parentId: "h", scopes: ["notes:read"] }),
      system: "You are a test assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "read n1" }] }],
    })) events.push(e);
    return events;
  };
  return { calls, run };
}

describe("Anthropic adapter", () => {
  test("sends a clean request, assembles streamed blocks, and returns reasoning unchanged", async () => {
    const { url, seen } = await serve((_s, call) => ({
      chunks:
        call === 1
          ? anthropicTurn(
              [
                { type: "thinking", thinking: "plan", signature: "sig-abc" },
                { type: "text", parts: ["Reading ", "now."] },
                { type: "tool_use", id: "toolu_1", name: "notes_read", parts: ['{"id":', '"n1"}'] },
              ],
              "tool_use",
              { input_tokens: 25, output_tokens: 7 },
              { cache_creation_input_tokens: 10, cache_read_input_tokens: 100 },
            )
          : anthropicTurn([{ type: "text", parts: ["It says: note body"] }], "end_turn", { input_tokens: 60, output_tokens: 9 }),
    }));
    const { calls, run } = harness(new AnthropicProvider({ apiKey: "test-key", baseUrl: url }));
    const events = await run();

    expect(calls).toEqual([{ id: "n1" }]);
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as any).text).join("")).toBe("Reading now.It says: note body");
    const end = events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
    expect(end).toMatchObject({ reason: "end_turn", totals: { inputTokens: 195, outputTokens: 16 } });

    const [first, second] = seen;
    expect(first?.url).toBe("/v1/messages");
    expect(JSON.stringify(first?.headers)).toContain("test-key");
    expect(first?.body).toMatchObject({ model: "claude-sonnet-5-5", stream: true, system: `You are a test assistant.\n\n${DATA_NOTICE}` });
    expect(first?.body).not.toHaveProperty("temperature");
    expect(first?.body.tools).toEqual([
      { name: "notes_read", description: "Read a note", input_schema: { type: "object", properties: { id: { type: "string" } } } },
    ]);
    expect(second?.body.messages.at(-2).content).toEqual([
      { type: "thinking", thinking: "plan", signature: "sig-abc" },
      { type: "text", text: "Reading now." },
      { type: "tool_use", id: "toolu_1", name: "notes_read", input: { id: "n1" } },
    ]);
    expect(second?.body.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '<tool_output tool="notes_read">\nnote body\n</tool_output>', is_error: false }],
    });
  });

  test("a server error ends the run as provider_error", async () => {
    const { url } = await serve(() => ({ status: 400, chunks: [JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } })] }));
    const { run } = harness(new AnthropicProvider({ apiKey: "k", baseUrl: url }));
    const events = await run();
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "provider_error" });
  });

  test("calling the default US endpoint needs an explicit opt-in", () => {
    expect(() => new AnthropicProvider({ apiKey: "k" })).toThrow(/useDefaultEndpoint/);
    expect(() => new AnthropicProvider({ apiKey: "k", useDefaultEndpoint: true })).not.toThrow();
    expect(() => new AnthropicProvider({ apiKey: "k", baseUrl: "https://models.example.eu" })).not.toThrow();
    expect(() => new AnthropicProvider({ apiKey: "k", baseUrl: "http://models.example.eu" })).toThrow(/https/);
  });

  test("the default endpoint cannot be redirected by the environment", () => {
    const saved = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://evil.example";
    try {
      const provider = new AnthropicProvider({ apiKey: "k", useDefaultEndpoint: true }) as unknown as { client: { baseURL: string } };
      expect(provider.client.baseURL).toBe("https://api.anthropic.com");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
    }
  });

  test("reasoning blocks from another provider are not sent", async () => {
    const { url, seen } = await serve(() => ({ chunks: anthropicTurn([{ type: "text", parts: ["ok"] }], "end_turn") }));
    const provider = new AnthropicProvider({ apiKey: "k", baseUrl: url });
    const events = [];
    for await (const event of provider.stream({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "provider_block", provider: "other", raw: { type: "thinking", thinking: "x", signature: "s" } }, { type: "text", text: "yo" }] },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
      tools: [],
      maxOutputTokens: 100,
    })) events.push(event);
    expect(JSON.stringify(seen[0]?.body.messages)).not.toContain("thinking");
  });

  test("a missing or empty key is refused", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new AnthropicProvider({ useDefaultEndpoint: true })).toThrow(/apiKey/);
      expect(() => new AnthropicProvider({ apiKey: "", useDefaultEndpoint: true })).toThrow(/apiKey/);
      process.env.ANTHROPIC_API_KEY = "from-env";
      expect(() => new AnthropicProvider({ useDefaultEndpoint: true })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe("OpenAI-compatible adapter", () => {
  const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
  const usageChunk = (prompt_tokens: number, completion_tokens: number) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens, completion_tokens } })}\n\n`;

  test("streams text and split tool calls, and maps the transcript back", async () => {
    const { url, seen } = await serve((_s, call) => ({
      chunks:
        call === 1
          ? [
              chunk({ content: "Reading " }),
              chunk({ content: "now." }),
              chunk({ tool_calls: [{ index: 0, id: "call_9", function: { name: "notes_", arguments: '{"id"' } }] }),
              chunk({ tool_calls: [{ index: 0, function: { name: "read", arguments: ':"n1"}' } }] }, "tool_calls"),
              usageChunk(30, 8),
              "data: [DONE]\n\n",
            ]
          : [chunk({ content: "Done." }, "stop"), usageChunk(50, 3), "data: [DONE]\n\n"],
    }));
    const { calls, run } = harness(new OpenAICompatibleProvider({ baseUrl: url, model: "eu-model", apiKey: "eu-key" }));
    const events = await run();

    expect(calls).toEqual([{ id: "n1" }]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "end_turn", totals: { inputTokens: 80, outputTokens: 11 } });
    const [first, second] = seen;
    expect(first?.url).toBe("/chat/completions");
    expect(first?.headers.authorization).toBe("Bearer eu-key");
    expect(first?.body).toMatchObject({ model: "eu-model", stream: true });
    expect(first?.body.tools[0]).toEqual({
      type: "function",
      function: { name: "notes_read", description: "Read a note", parameters: { type: "object", properties: { id: { type: "string" } } } },
    });
    expect(second?.body.messages).toEqual([
      { role: "system", content: `You are a test assistant.\n\n${DATA_NOTICE}` },
      { role: "user", content: "read n1" },
      { role: "assistant", content: "Reading now.", tool_calls: [{ id: "call_9", type: "function", function: { name: "notes_read", arguments: '{"id":"n1"}' } }] },
      { role: "tool", tool_call_id: "call_9", content: '<tool_output tool="notes_read">\nnote body\n</tool_output>' },
    ]);
  });

  test("a response with no usage ends the run as provider_error", async () => {
    const { url } = await serve(() => ({ chunks: [chunk({ content: "hi" }, "stop"), "data: [DONE]\n\n"] }));
    const { run } = harness(new OpenAICompatibleProvider({ baseUrl: url, model: "m" }));
    expect((await run()).at(-1)).toMatchObject({ type: "done", reason: "provider_error", error: expect.stringContaining("no token usage") });
  });

  test("tool arguments that are not JSON never reach the handler", async () => {
    const { url } = await serve((_s, call) => ({
      chunks:
        call === 1
          ? [chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "notes_read", arguments: "{not json" } }] }, "tool_calls"), usageChunk(5, 5), "data: [DONE]\n\n"]
          : [chunk({ content: "ok" }, "stop"), usageChunk(5, 5), "data: [DONE]\n\n"],
    }));
    const { calls, run } = harness(new OpenAICompatibleProvider({ baseUrl: url, model: "m" }));
    const events = await run();
    expect(calls).toEqual([]);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, denied: "invalid_input" });
  });

  test("a non-2xx response ends the run as provider_error", async () => {
    const { url } = await serve(() => ({ status: 503, chunks: ["{}"] }));
    const { run } = harness(new OpenAICompatibleProvider({ baseUrl: url, model: "m" }));
    expect((await run()).at(-1)).toMatchObject({ type: "done", reason: "provider_error", error: expect.stringContaining("503") });
  });

  test("a stream of comment lines is cut at the size limit", async () => {
    const { url } = await serve(() => ({ chunks: [`: ${"ping ".repeat(30)}\n`, `: ${"ping ".repeat(30)}\n`] }));
    const { run } = harness(new OpenAICompatibleProvider({ baseUrl: url, model: "m", maxResponseBytes: 100 }));
    expect((await run()).at(-1)).toMatchObject({ reason: "provider_error", error: expect.stringContaining("size limit") });
  });

  test.each([[Number.NaN], [0], [-5], [1.5]])("a bad response limit %j is refused", (limit) => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: "http://localhost:1/v1", model: "m", maxResponseBytes: limit })).toThrow(/maxResponseBytes/);
  });

  test("a URL with a query or a fragment is refused", () => {
    for (const baseUrl of ["https://models.example.eu/v1#x", "https://models.example.eu/v1?key=1"]) {
      expect(() => new OpenAICompatibleProvider({ baseUrl, model: "m", apiKey: "k" })).toThrow(/query string or a fragment/);
    }
  });

  test("a URL with credentials is refused without echoing them", () => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: "https://user:sk-SECRET@host.example.eu/v1", model: "m", apiKey: "k" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("SECRET") }),
    );
    expect(() => new OpenAICompatibleProvider({ baseUrl: "sk-SECRET not a url", model: "m", apiKey: "k" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("SECRET") }),
    );
  });

  test("tool calls with no id get unique ids", async () => {
    const { url, seen } = await serve((_s, call) => ({
      chunks:
        call === 1
          ? [
              chunk({ tool_calls: [{ index: 0, function: { name: "notes_read", arguments: "{}" } }, { index: 1, function: { name: "notes_read", arguments: "{}" } }] }, "tool_calls"),
              usageChunk(5, 5),
            ]
          : [chunk({ content: "ok" }, "stop"), usageChunk(5, 5)],
    }));
    const { run } = harness(new OpenAICompatibleProvider({ baseUrl: url, model: "m" }));
    await run();
    const ids = (seen[1]?.body.messages as { role: string; tool_call_id?: string }[]).filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  test("a key must be non-empty, and remote hosts need one", () => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: "https://models.example.eu/v1", model: "m", apiKey: "" })).toThrow(/apiKey/);
    expect(() => new OpenAICompatibleProvider({ baseUrl: "https://models.example.eu/v1", model: "m" })).toThrow(/apiKey/);
    expect(() => new OpenAICompatibleProvider({ baseUrl: "http://localhost:8080/v1", model: "m" })).not.toThrow();
  });

  test("a plain-HTTP remote URL is refused", () => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: "http://models.example.eu/v1", model: "m", apiKey: "k" })).toThrow(/https/);
    expect(() => new OpenAICompatibleProvider({ baseUrl: "https://models.example.eu/v1", model: "m", apiKey: "k" })).not.toThrow();
    expect(() => new OpenAICompatibleProvider({ baseUrl: "not a url", model: "m", apiKey: "k" })).toThrow(/valid URL/);
  });
});
