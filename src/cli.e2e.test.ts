import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli, type CliIo } from "./cli.js";
import { serveNotes } from "../test-fixtures/notes-http.mjs";
import type { ScriptedTurn } from "./testing.js";
import { VERSION } from "./version.js";

// Ways the CLI and the MCP server can fail. Each one is a case below.
// 1. The answer or the tool call does not come through the real MCP server.
// 2. A risky call runs without a pre-approval, or with a pre-approval for other arguments, or twice.
// 3. A tool outside --scope or --tool-scope is offered or runs.
// 4. A missing flag (scope, tools, tool scope, a bad risk) is guessed instead of refused with exit 2.
// 5. An API key is read from an argument, or printed.
// 6. A run that stopped on a cap or an error exits with 0.
// 7. JSON mode loses the machine-made label, or text mode prints an assistant part without it.
// 8. The MCP server prints to stdout besides the protocol, or answers a bad call with success.
// 9. A tool name, a tool result, or the model's text carries a terminal escape code to the user's terminal.
// 10. A huge stdin or a flood of "skipped" lines fills memory or the screen.
// 11. The MCP server keeps running, with its tool servers, after the client closes stdin.
// 12. A pre-approval for the same arguments covers another tool, or an approval prompt says yes to a blank or "n".
// 13. A header setting with a second "=" reads half of the variable name.

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FIXTURE_STDIO = new URL("../test-fixtures/notes-stdio.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "assistant-cli-"));

beforeAll(() => {
  if (!existsSync(CLI)) execFileSync("npx", ["tsup"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
});

let notes: Awaited<ReturnType<typeof serveNotes>>;
let sseServer: Server | undefined;
beforeAll(async () => {
  notes = await serveNotes();
});
afterAll(async () => {
  await notes.close();
  sseServer?.closeAllConnections();
  sseServer?.close();
});

function script(turns: ScriptedTurn[]): string {
  const file = join(dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(turns));
  return file;
}

function cli(args: string[], options: { env?: Record<string, string>; stdin?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...options.env }, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end(options.stdin ?? "");
  });
}

const base = (extra: string[]) => ["chat", "--tools", notes.url, "--provider", "scripted", ...extra];
const read = (id = "n1"): ScriptedTurn => ({ toolCalls: [{ name: "notes_read", input: { id } }] });
const write = (id = "n1", text = "x"): ScriptedTurn => ({ toolCalls: [{ name: "notes_write", input: { id, text } }] });
const readOnly = ["--scope", "notes:read", "--tool-scope", "notes:read", "--tool-risk", "safe"];
const writer = ["--scope", "notes:write", "--tool-scope", "notes:write"]; // risk defaults to risky

describe("chat", () => {
  test("answers through a real MCP server over HTTP", async () => {
    const before = notes.counters.notes_read ?? 0;
    const result = await cli(base([...readOnly, "--script", script([read(), { text: "The note says: note n1" }]), "read note n1"]));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Assistant (machine-made): The note says: note n1");
    expect(result.stderr).toContain("[machine-made] tool call: notes_read");
    expect(result.stderr).toContain("tool result (ok): note n1");
    expect(result.stderr).toContain("done: end_turn");
    expect(notes.counters.notes_read).toBe(before + 1);
  });

  test("reads the message from stdin", async () => {
    const result = await cli(base([...readOnly, "--script", script([{ text: "hi" }])]), { stdin: "hello there\n" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hi");
  });

  test("works with an MCP server on stdio", async () => {
    const result = await cli(["chat", "--tools", JSON.stringify([process.execPath, FIXTURE_STDIO]), "--provider", "scripted", ...readOnly, "--script", script([read("s1"), { text: "done" }]), "go"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("tool result (ok): note s1");
  });

  test("sends a header from an environment variable, not from an argument", async () => {
    const result = await cli(base([...readOnly, "--tools-header-env", "authorization=MCP_AUTH", "--script", script([{ text: "hi" }]), "go"]), {
      env: { MCP_AUTH: "Bearer secret-token-value" },
    });
    expect(result.code).toBe(0);
    expect(notes.headers.some((h) => h.authorization === "Bearer secret-token-value")).toBe(true);
    expect(result.stdout + result.stderr).not.toContain("secret-token-value");
  });

  test("--json prints every event, and every action carries the machine-made label", async () => {
    const result = await cli(base([...readOnly, "--json", "--script", script([read(), { text: "ok" }]), "go"]));
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["run_start", "tool_call", "tool_result", "done"]));
    for (const event of events.filter((e) => ["run_start", "tool_call", "tool_result", "done"].includes(e.type))) {
      expect(event.actor).toMatchObject({ kind: "agent_of_human", onBehalfOf: "cli-user", machineMade: true });
    }
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ untrusted: true });
  });

  test("a tool outside the scope is not offered and does not run", async () => {
    const before = notes.counters.notes_write ?? 0;
    const result = await cli(base(["--scope", "notes:read", "--tool-scope", "notes:write", "--tool-risk", "safe", "--script", script([write(), { text: "ok" }]), "go"]));
    expect(result.stderr).toContain("denied: tool \"notes_write\" needs scope");
    expect(notes.counters.notes_write ?? 0).toBe(before);
  });
});

describe("approvals on the command line", () => {
  test("a risky call without a pre-approval does not run", async () => {
    const before = notes.counters.notes_write ?? 0;
    const result = await cli(base([...writer, "--script", script([write(), { text: "ok" }]), "go"]));
    expect(result.stderr).toContain("approval needed: notes_write (risky)");
    expect(result.stderr).toContain("not approved");
    expect(notes.counters.notes_write ?? 0).toBe(before);
  });

  test("a pre-approval for the exact call lets it run, whatever the key order", async () => {
    const before = notes.counters.notes_write ?? 0;
    const result = await cli(base([...writer, "--approve-call", '{"tool":"notes_write","input":{"text":"x","id":"n1"}}', "--script", script([write("n1", "x"), { text: "ok" }]), "go"]));
    expect(result.stderr).toContain("approved by cli:pre-approved");
    expect(notes.counters.notes_write).toBe(before + 1);
  });

  test("a pre-approval for other arguments does not cover the call", async () => {
    const before = notes.counters.notes_write ?? 0;
    const result = await cli(base([...writer, "--approve-call", '{"tool":"notes_write","input":{"id":"n1","text":"DIFFERENT"}}', "--script", script([write("n1", "x"), { text: "ok" }]), "go"]));
    expect(result.stderr).toContain("not approved");
    expect(notes.counters.notes_write ?? 0).toBe(before);
  });

  test("a pre-approval is used once", async () => {
    const before = notes.counters.notes_write ?? 0;
    const result = await cli(base([...writer, "--approve-call", '{"tool":"notes_write","input":{"id":"n1","text":"x"}}', "--script", script([{ toolCalls: [write().toolCalls![0]!, write().toolCalls![0]!] }, { text: "ok" }]), "go"]));
    expect(notes.counters.notes_write).toBe(before + 1);
    expect(result.stderr.match(/not approved/g)).toHaveLength(1);
  });
});

describe("usage and exit codes", () => {
  test("help and version", async () => {
    expect((await cli(["--help"])).stdout).toContain("agentic-assistant chat");
    expect((await cli(["--version"])).stdout.trim()).toBe(VERSION);
  });

  test.each([
    ["no tools", ["chat", "--scope", "a:read", "--tool-scope", "a:read", "--provider", "scripted", "go"], /--tools is required/],
    ["no scope", ["chat", "--tools", "http://127.0.0.1:1/mcp", "--tool-scope", "a:read", "--provider", "scripted", "--script", "x", "go"], /at least one --scope/],
    ["no tool scope", ["chat", "--tools", "http://127.0.0.1:1/mcp", "--scope", "a:read", "go"], /--tool-scope is required/],
    ["a bad risk", ["chat", "--tools", "x", "--scope", "a:read", "--tool-scope", "a:read", "--tool-risk", "fine", "go"], /--tool-risk must be one of/],
    ["a bad scope", ["chat", "--tools", "x", "--scope", "a:delete", "--tool-scope", "a:read", "--provider", "scripted", "--script", "x", "go"], /invalid scope/],
    ["a bad limit", ["chat", "--tools", "x", "--scope", "a:read", "--tool-scope", "a:read", "--max-turns", "0", "go"], /--max-turns needs a positive whole number/],
    ["a bad pre-approval", ["chat", "--tools", "x", "--scope", "a:read", "--tool-scope", "a:read", "--approve-call", "nope", "go"], /--approve-call needs JSON/],
    ["a key in an argument", ["chat", "--tools", "x", "--scope", "a:read", "--tool-scope", "a:read", "--api-key", "sk-SECRET", "go"], /Unknown option/i],
    ["a plain http tool server on a remote host", ["chat", "--tools", "http://notes.example.eu/mcp", "--tools-header-env", "authorization=NOTES_TOKEN", "--scope", "a:read", "--tool-scope", "a:read", "--provider", "scripted", "--script", script([{ text: "hi" }]), "go"], /--tools needs an https URL/],
    ["an unknown command", ["frobnicate"], /unknown command/],
    ["openai-compatible with no base url", ["chat", "--tools", "http://127.0.0.1:1/mcp", "--scope", "a:read", "--tool-scope", "a:read", "--provider", "openai-compatible", "go"], /needs --base-url and --model/],
    ["anthropic with no endpoint choice", ["chat", "--tools", "http://127.0.0.1:1/mcp", "--scope", "a:read", "--tool-scope", "a:read", "go"], /useDefaultEndpoint|apiKey/],
    ["approve ask without a terminal", ["chat", "--tools", "http://127.0.0.1:1/mcp", "--scope", "a:read", "--tool-scope", "a:read", "--provider", "scripted", "--script", "x", "--approve", "ask", "go"], /needs a terminal/],
  ])("%s exits with 2", async (_name, args, message) => {
    const result = await cli(args as string[]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(message as RegExp);
    expect(result.stderr).not.toContain("sk-SECRET");
  });

  test("a run that stops on a cap exits with 1", async () => {
    const result = await cli(base([...readOnly, "--max-turns", "1", "--script", script([read(), { text: "never" }]), "go"]));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("done: max_turns");
  });

  test("an unreachable tool server exits with 1 and no stack", async () => {
    const result = await cli(["chat", "--tools", "http://127.0.0.1:1/mcp", ...readOnly, "--provider", "scripted", "--script", script([{ text: "x" }]), "go"]);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("    at ");
  });
});

describe("OpenAI-compatible provider through the CLI", () => {
  test("streams from a local endpoint and keeps the key out of the output", async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    sseServer = createServer((req, res) => {
      seen.push(req.headers);
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello from the EU model" }, finish_reason: "stop" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => sseServer?.listen(0, "127.0.0.1", resolve));
    const port = (sseServer?.address() as AddressInfo).port;
    const result = await cli(
      ["chat", "--tools", notes.url, ...readOnly, "--provider", "openai-compatible", "--base-url", `http://127.0.0.1:${port}`, "--model", "eu-model", "--api-key-env", "EU_KEY", "--price-in", "1", "--price-out", "2", "go"],
      { env: { EU_KEY: "eu-secret-key-value" } },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello from the EU model");
    expect(seen[0]?.authorization).toBe("Bearer eu-secret-key-value");
    expect(result.stdout + result.stderr).not.toContain("eu-secret-key-value");
    expect(result.stderr).toContain("tokens in 12, out 6");
  });
});

describe("MCP server", () => {
  async function connect(extra: string[]): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp", "--tools", notes.url, "--provider", "scripted", ...extra],
      env: { PATH: process.env.PATH ?? "" },
      stderr: "ignore",
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    return client;
  }
  const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0] as { text: string }).text;

  test("lists one tool and answers a message, labeled machine-made", async () => {
    const client = await connect([...readOnly, "--script", script([read(), { text: "The note says: note n1" }])]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["assistant_chat"]);
      const result = await client.callTool({ name: "assistant_chat", arguments: { message: "read note n1" } });
      const body = JSON.parse(text(result));
      expect(result.isError).toBeUndefined();
      expect(body).toMatchObject({ machineMade: true, reply: "The note says: note n1", reason: "end_turn" });
      expect(body.toolCalls).toEqual([{ name: "notes_read", isError: false }]);
    } finally {
      await client.close();
    }
  });

  test("a risky call is refused without a pre-approval, and the answer says so", async () => {
    const before = notes.counters.notes_write ?? 0;
    const client = await connect([...writer, "--script", script([write(), { text: "I could not do it" }])]);
    try {
      const body = JSON.parse(text(await client.callTool({ name: "assistant_chat", arguments: { message: "write" } })));
      expect(body.toolCalls).toEqual([{ name: "notes_write", isError: true, denied: "approval" }]);
      expect(notes.counters.notes_write ?? 0).toBe(before);
    } finally {
      await client.close();
    }
  });

  test("a run that stops on a cap is an error result", async () => {
    const client = await connect([...readOnly, "--max-turns", "1", "--script", script([read(), { text: "x" }])]);
    try {
      const result = await client.callTool({ name: "assistant_chat", arguments: { message: "go" } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(text(result)).reason).toBe("max_turns");
    } finally {
      await client.close();
    }
  });

  test.each([[{}], [{ message: "" }], [{ message: 5 }], [{ message: "x".repeat(10_001) }]])("refuses the arguments %j", async (args) => {
    const client = await connect([...readOnly, "--script", script([{ text: "x" }])]);
    try {
      const result = await client.callTool({ name: "assistant_chat", arguments: args });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("refuses --approve ask", async () => {
    const result = await cli(["mcp", "--tools", notes.url, "--provider", "scripted", ...readOnly, "--script", "x", "--approve", "ask"]);
    expect(result.code).toBe(2);
  });
});

function fakeIo(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const io: CliIo = {
    out: (text) => void out.push(text),
    err: (line) => void err.push(line),
    env: {},
    readFile: (path) => readFileSync(path, "utf8"),
    readStdin: async () => "",
    isTTY: false,
    ask: async (question) => {
      questions.push(question);
      return "n";
    },
    ...overrides,
  };
  return { io, out, err, questions };
}

describe("approving at the terminal", () => {
  const args = (turns: ScriptedTurn[], extra: string[] = []) => [...base([...writer, "--approve", "ask", "--script", script(turns), ...extra]), "go"];

  test.each([["y"], ["Yes"]])("answer %j runs the exact call that was shown", async (answer) => {
    const before = notes.counters.notes_write ?? 0;
    const { io, questions } = fakeIo({ isTTY: true, ask: async (q) => (questions.push(q), answer) });
    const code = await runCli(args([write("n5", "hi"), { text: "ok" }]), io);
    expect(code).toBe(0);
    expect(questions[0]).toContain("notes_write");
    expect(questions[0]).toContain('{"id":"n5","text":"hi"}');
    expect(notes.counters.notes_write).toBe(before + 1);
  });

  test.each([["n"], [""], ["maybe"], ["yes please do it"]])("answer %j does not run it", async (answer) => {
    const before = notes.counters.notes_write ?? 0;
    const { io } = fakeIo({ isTTY: true, ask: async () => answer });
    await runCli(args([write(), { text: "ok" }]), io);
    expect(notes.counters.notes_write ?? 0).toBe(before);
  });

  test("the question carries the label and has no control characters", async () => {
    const questions: string[] = [];
    const { io } = fakeIo({ isTTY: true, ask: async (q) => (questions.push(q), "n") });
    await runCli(args([{ toolCalls: [{ name: "notes_write", input: { id: "\u009b2J\u202Ex", text: "t" } }] }, { text: "ok" }]), io);
    expect(questions[0]).toContain("[machine-made request] Approve notes_write");
    expect(questions[0]).not.toMatch(/[\u009b\u202e]/);
  });

  test("a conversation on a terminal keeps going until exit", async () => {
    const answers = ["first question", "second question", "exit"];
    const { io, out } = fakeIo({ isTTY: true, ask: async () => answers.shift() ?? "exit" });
    const code = await runCli(["chat", "--tools", notes.url, "--provider", "scripted", ...readOnly, "--script", script([{ text: "one" }, { text: "two" }])], io);
    expect(code).toBe(0);
    expect(out.join("")).toContain("one");
    expect(out.join("")).toContain("two");
  });
});

describe("hardening", () => {
  test("removes terminal control characters from text, tool lines, and skipped-tool lines", async () => {
    const turns: ScriptedTurn[] = [read("\u001b[2Jx"), { text: "\u001b[2J\u001b]0;pwned\u0007hello\r\nworld" }];
    const result = await cli(base([...readOnly, "--script", script(turns), "go"]));
    expect(result.stdout + result.stderr).not.toMatch(/[\u001b\u0007\r]/);
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("world");
    expect(result.stderr).toContain("skipped tool evil[2Jname");
  });

  test("removes control characters from a tool name the model made up", async () => {
    const result = await cli(base([...readOnly, "--script", script([{ toolCalls: [{ name: "\u001b]0;pwned\u0007\u001b[2J", input: {} }] }, { text: "ok" }]), "go"]));
    expect(result.stderr + result.stdout).not.toMatch(/[\u001b\u0007]/);
    expect(result.stderr).toContain("[machine-made] tool call:");
  });

  test("removes text direction marks and zero-width characters, and cuts between characters", async () => {
    const result = await cli(base([...readOnly, "--script", script([read(`\u202Eetirw_seton\u200b${"😀".repeat(300)}`), { text: "ok" }]), "go"]));
    expect(result.stderr).not.toMatch(/[\u202e\u200b]/);
    expect(result.stderr).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  test("removes control characters from the error of a tool server", async () => {
    const evil = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32000, message: "\u001b]0;x\u0007boom" } }));
      });
    });
    await new Promise<void>((resolve) => evil.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(evil.address() as AddressInfo).port}/mcp`;
      const result = await cli(["chat", "--tools", url, ...readOnly, "--provider", "scripted", "--script", script([{ text: "x" }]), "go"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("boom");
      expect(result.stderr).not.toMatch(/[\u001b\u0007]/);
    } finally {
      evil.closeAllConnections();
      evil.close();
    }
  });

  test("a message of exactly 1,000,000 bytes is accepted", async () => {
    const result = await cli(base([...readOnly, "--script", script([{ text: "x" }])]), { stdin: "a".repeat(1_000_000) });
    expect(result.code).toBe(0);
  });

  test("a multibyte message over 1,000,000 bytes is refused", async () => {
    const result = await cli(base([...readOnly, "--script", script([{ text: "x" }])]), { stdin: "é".repeat(500_001) });
    expect(result.code).toBe(2);
  });

  test("--json keeps events as they are, escaped by JSON", async () => {
    const result = await cli(base([...readOnly, "--json", "--script", script([{ text: "\u001b[2Jhi" }]), "go"]));
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).toContain("\\u001b[2Jhi");
  });

  test("a message on stdin over 1 MB exits with 2", async () => {
    const result = await cli(base([...readOnly, "--script", script([{ text: "x" }])]), { stdin: "a".repeat(1_000_001) });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("over 1000000 bytes");
  });

  test.each([
    ["a header setting with a second equals sign", ["--tools-header-env", "authorization=A=B"], /header=ENV_NAME/],
    ["a header setting with no variable", ["--tools-header-env", "authorization"], /header=ENV_NAME/],
  ])("%s exits with 2", async (_name, extra, message) => {
    const result = await cli(base([...readOnly, ...extra, "--script", script([{ text: "x" }]), "go"]));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(message);
  });

  test("a header setting on a stdio target exits with 2", async () => {
    const result = await cli(["chat", "--tools", JSON.stringify([process.execPath, FIXTURE_STDIO]), "--tools-header-env", "a=B", "--provider", "scripted", ...readOnly, "--script", script([{ text: "x" }]), "go"], { env: { B: "v" } });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("http(s) --tools URL only");
  });

  test("a pre-approval for the same arguments does not cover another tool", async () => {
    const before = notes.counters.notes_write ?? 0;
    const result = await cli(base([...writer, "--approve-call", '{"tool":"notes_read","input":{"id":"n1","text":"x"}}', "--script", script([write("n1", "x"), { text: "ok" }]), "go"]));
    expect(result.stderr).toContain("not approved");
    expect(notes.counters.notes_write ?? 0).toBe(before);
  });
});

describe("MCP server shutdown", () => {
  test("a call still running when stdin closes is stopped, and the process exits at once", async () => {
    const child = spawn(process.execPath, [CLI, "mcp", "--tools", notes.url, "--provider", "scripted", ...readOnly, "--script", script([{ toolCalls: [{ name: "slow", input: {} }] }, { text: "late" }])], {
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "assistant_chat", arguments: { message: "be slow" } } });
    await new Promise((resolve) => setTimeout(resolve, 1200)); // the call has reached the five-second tool
    const started = Date.now();
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 4000))]);
    if (code === "still running") child.kill();
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(3500);
  });
});

describe("MCP server process", () => {
  function startServer(extra: string[]) {
    const child = spawn(process.execPath, [CLI, "mcp", "--tools", notes.url, "--provider", "scripted", ...extra], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    return { child, send, exited, waitFor, stdout: () => stdout };
  }

  test("prints only protocol on stdout, runs a pre-approved call, and stops when stdin closes", async () => {
    const before = notes.counters.notes_write ?? 0;
    const server = startServer([...writer, "--approve-call", '{"tool":"notes_write","input":{"id":"n2","text":"y"}}', "--script", script([write("n2", "y"), { text: "written" }])]);
    server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    server.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "assistant_chat", arguments: { message: "write it" } } });
    await server.waitFor(() => server.stdout().includes('"id":2'));
    const lines = server.stdout().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    const reply = JSON.parse(lines.find((line) => line.includes('"id":2')) as string);
    expect(JSON.parse(reply.result.content[0].text).toolCalls).toEqual([{ name: "notes_write", isError: false }]);
    expect(notes.counters.notes_write).toBe(before + 1);
    server.child.stdin.end();
    const code = await Promise.race([server.exited, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 5000))]);
    if (code === "still running") server.child.kill();
    expect(code).toBe(0);
  });
});
