import { afterEach, describe, expect, test, vi } from "vitest";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ProviderError, type ModelEvent, type ModelRequest } from "../types.js";

// Ways the adapter can fail on a mocked fetch. Each one is a case below.
// 1. The request is wrong: URL, auth header, tools, or transcript mapping.
// 2. A stream chunk is split across reads and is lost.
// 3. A chunk is valid JSON but not an object, and a TypeError escapes instead of a ProviderError.
// 4. A tool call has no index, and two calls merge into one.
// 5. An error status is read as a success, or its body is left open.
// 6. The stop reason is mapped wrong, or usage is missing.

const request: ModelRequest = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], maxOutputTokens: 100 };
const enc = new TextEncoder();
const usageChunk = { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } };
const line = (data: unknown) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

function mockFetch(chunks: string[], init: ResponseInit = { status: 200 }) {
  const fn = vi.fn(async (_url: unknown, _init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, init);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function collect(provider: OpenAICompatibleProvider, req = request): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(req)) events.push(event);
  return events;
}

const make = (extra: Record<string, unknown> = {}) => new OpenAICompatibleProvider({ baseUrl: "https://llm.example.eu/v1/", model: "m", apiKey: "k", ...extra });
const final = (events: ModelEvent[]) => events.at(-1) as Extract<ModelEvent, { type: "message" }>;

afterEach(() => vi.unstubAllGlobals());

describe("OpenAICompatibleProvider with a mocked fetch", () => {
  test("sends the request to the base URL with a bearer key and maps the transcript", async () => {
    const fn = mockFetch([line(usageChunk)]);
    await collect(make(), {
      system: "be brief",
      maxOutputTokens: 50,
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "ok" }] },
      ],
    });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("https://llm.example.eu/v1/chat/completions");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ model: "m", stream: true, max_tokens: 50 });
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } });
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]);
  });

  test("sends no authorization header and no tools key when there is no key and no tool", async () => {
    const fn = mockFetch([line(usageChunk)]);
    await collect(new OpenAICompatibleProvider({ baseUrl: "http://localhost:11434/v1", model: "m" }));
    const [, init] = fn.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(init?.body as string).tools).toBeUndefined();
  });

  test("streams text deltas, then one final message with usage", async () => {
    mockFetch([line({ choices: [{ delta: { content: "Hel" } }] }), line({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }), line(usageChunk), "data: [DONE]\n\n"]);
    const events = await collect(make());
    expect(events.slice(0, 2)).toEqual([{ type: "text_delta", text: "Hel" }, { type: "text_delta", text: "lo" }]);
    expect(final(events)).toEqual({ type: "message", content: [{ type: "text", text: "Hello" }], stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } });
  });

  test("reassembles a line that is split across reads, including CRLF and a last line with no newline", async () => {
    const whole = line({ choices: [{ delta: { content: "ab" } }] }).replace("\n\n", "\r\n\r\n");
    mockFetch([whole.slice(0, 10), whole.slice(10), `data: ${JSON.stringify(usageChunk)}`]);
    const events = await collect(make());
    expect(final(events).content).toEqual([{ type: "text", text: "ab" }]);
    expect(final(events).usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  test("ignores comments, blank lines, and lines that are not data", async () => {
    mockFetch([": keep-alive\n\nevent: ping\n\n", line(usageChunk)]);
    expect(final(await collect(make())).content).toEqual([]);
  });

  test("joins split tool calls by index and parses their arguments", async () => {
    mockFetch([
      line({ choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "two", arguments: "{}" } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "on", arguments: '{"x"' } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "e", arguments: ":1}" } }] }, finish_reason: "tool_calls" }] }),
      line(usageChunk),
    ]);
    const message = final(await collect(make()));
    expect(message.stopReason).toBe("tool_use");
    expect(message.content).toEqual([
      { type: "tool_use", id: "a", name: "one", input: { x: 1 } },
      { type: "tool_use", id: "b", name: "two", input: {} },
    ]);
  });

  test("keeps two parallel tool calls apart when the server omits the index", async () => {
    mockFetch([
      line({ choices: [{ delta: { tool_calls: [{ id: "a", function: { name: "one", arguments: "{}" } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ id: "b", function: { name: "two", arguments: "{}" } }] } }] }),
      line(usageChunk),
    ]);
    const names = final(await collect(make())).content.map((block) => (block.type === "tool_use" ? block.name : ""));
    expect(names).toEqual(["one", "two"]);
  });

  test.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
    ["surprise", "other"],
  ])("maps finish reason %s to %s", async (reason, expected) => {
    mockFetch([line({ choices: [{ delta: {}, finish_reason: reason }] }), line(usageChunk)]);
    expect(final(await collect(make())).stopReason).toBe(expected);
  });

  test("a missing finish reason is other", async () => {
    mockFetch([line(usageChunk)]);
    expect(final(await collect(make())).stopReason).toBe("other");
  });

  test.each([401, 429, 500])("status %i is a ProviderError and the body is closed", async (status) => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { status })));
    await expect(collect(make())).rejects.toThrow(new ProviderError(`openai-compatible request failed with status ${status}`));
    expect(cancel).toHaveBeenCalled();
  });

  test("the error does not echo the key or the body", async () => {
    mockFetch(["secret-body k"], { status: 500 });
    const error = await collect(make({ apiKey: "sk-secret" })).catch((e: Error) => e);
    expect((error as Error).message).not.toMatch(/sk-secret|secret-body/);
  });

  test("uses the custom provider name in errors", async () => {
    mockFetch([], { status: 500 });
    await expect(collect(make({ name: "mistral" }))).rejects.toThrow(/^mistral request failed/);
  });

  test("a network failure rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(collect(make())).rejects.toThrow("fetch failed");
  });

  test("passes the abort signal to fetch", async () => {
    const fn = mockFetch([line(usageChunk)]);
    const controller = new AbortController();
    await collect(make(), { ...request, signal: controller.signal });
    expect(fn.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });

  test("a chunk that is not JSON is a ProviderError", async () => {
    mockFetch(["data: {oops\n\n"]);
    await expect(collect(make())).rejects.toBeInstanceOf(ProviderError);
  });

  test.each(["null", "5", '"text"', "true", "[]"])("a JSON chunk of %s is ignored", async (data) => {
    mockFetch([line(data), line(usageChunk)]);
    const events = await collect(make()).catch((e: unknown) => e);
    expect(events).not.toBeInstanceOf(Error);
    expect(final(events as ModelEvent[]).content).toEqual([]);
  });

  test.each([
    ["choices that is not an array", { choices: "x" }],
    ["a delta that is null", { choices: [{ delta: null }] }],
    ["tool_calls that is not an array", { choices: [{ delta: { tool_calls: "x" } }] }],
    ["a tool call that is null", { choices: [{ delta: { tool_calls: [null] } }] }],
  ])("%s is ignored", async (_name, chunk) => {
    mockFetch([line(chunk), line(usageChunk)]);
    const events = await collect(make()).catch((e: unknown) => e);
    expect(events).not.toBeInstanceOf(Error);
    expect(final(events as ModelEvent[]).content).toEqual([]);
  });

  test.each([
    ["no usage at all", []],
    ["usage with a string count", [line({ usage: { prompt_tokens: "3", completion_tokens: 2 } })]],
    ["usage with a fraction", [line({ usage: { prompt_tokens: 3.5, completion_tokens: 2 } })]],
    ["usage with null", [line({ usage: null })]],
  ])("%s is a ProviderError", async (_name, chunks) => {
    mockFetch(chunks);
    await expect(collect(make())).rejects.toThrow(/no token usage/);
  });

  test("tool arguments that are not JSON become null input", async () => {
    mockFetch([line({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "t", arguments: "{bad" } }] } }] }), line(usageChunk)]);
    expect(final(await collect(make())).content).toEqual([{ type: "tool_use", id: "a", name: "t", input: null }]);
  });

  test("a response over the size limit is a ProviderError", async () => {
    mockFetch([": " + "x".repeat(200) + "\n"]);
    await expect(collect(make({ maxResponseBytes: 100 }))).rejects.toThrow(/size limit of 100 bytes/);
  });

  test("a bad maxResponseBytes is refused", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => make({ maxResponseBytes: bad })).toThrow(ProviderError);
  });
});
