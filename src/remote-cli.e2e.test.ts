import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serveNotes } from "../test-fixtures/notes-http.mjs";
import { createClient, type AssistantClient, type ChatEvent } from "./client.js";
import { ToolRegistry } from "./index.js";
import { createStaticTokenAuth } from "./static-auth.js";
import { ScriptedProvider, type ScriptedTurn } from "./testing.js";
import { createWorker } from "./worker.js";

// Ways the remote commands can fail. Each one is a case below. The CLI and the MCP server are real child
// processes. The assistant API is the real Worker behind a local HTTP server.
// 1. A command reaches the wrong route, or lists tools without their scope and risk.
// 2. approve runs a call with a wrong digest, or approves one that belongs to another person.
// 3. deny lets the call run, or a denied call can run again.
// 4. A missing flag, id, digest, or token variable is guessed, not refused with exit 2. A failed call exits 0.
// 5. The token appears in output, or is read from an argument.
// 6. The MCP server offers the remote tools with no --api, or approve without --allow-approve.
// 7. An MCP tool answers a bad argument with success, or shows a pending call's arguments unquoted.

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const TOKEN = "k".repeat(40);
const OTHER = "o".repeat(40);

const emptyScript = join(mkdtempSync(join(tmpdir(), "assistant-remote-")), "script.json");
writeFileSync(emptyScript, "[]");

let notes: Awaited<ReturnType<typeof serveNotes>>;
let server: Server;
let base: string;
let ran: string[];
let turns: ScriptedTurn[];

beforeAll(async () => {
  if (!existsSync(CLI)) execFileSync("npx", ["tsup"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
  notes = await serveNotes();
  const auth = await createStaticTokenAuth({
    [TOKEN]: { id: "ana", scopes: ["notes:read", "notes:write"] },
    [OTHER]: { id: "bob", scopes: ["notes:read", "notes:write"] },
  });
  const registry = new ToolRegistry()
    .register({ name: "notes_read", description: "Read a note", inputSchema: { type: "object" }, scope: "notes:read", risk: "safe", handler: async () => "hello" })
    .register({
      name: "notes_delete",
      description: "Delete a note",
      inputSchema: { type: "object" },
      scope: "notes:write",
      risk: "risky",
      handler: async (input) => {
        ran.push(JSON.stringify(input));
        return "deleted";
      },
    });
  const worker = createWorker({ auth, registry, provider: () => new ScriptedProvider(turns) });
  server = createServer(async (req, res) => {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${req.url}`;
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream);
    const response = await worker.fetch(new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body, duplex: "half" } as RequestInit));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) return void res.end();
    Readable.fromWeb(response.body as never).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await notes.close();
  server.closeAllConnections();
  server.close();
});

function cli(args: string[], env: Record<string, string> = { ASSISTANT_TOKEN: TOKEN }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end("");
  });
}
const api = (command: string[], extra: string[] = [], env?: Record<string, string>) => cli([...command, "--api", base, "--api-token-env", "ASSISTANT_TOKEN", ...extra], env);

const sdk = (): AssistantClient => createClient({ baseUrl: base, token: TOKEN });
/** Starts a run that asks for one risky call, and waits until it is pending. */
async function pendingRun(second: ScriptedTurn) {
  ran = [];
  turns = [{ toolCalls: [{ name: "notes_delete", input: { id: "n1" } }] }, second];
  const events: ChatEvent[] = [];
  const reading = (async () => {
    for await (const event of sdk().chat("delete n1")) events.push(event);
  })();
  for (let i = 0; i < 400; i++) {
    const [pending] = await sdk().approvals();
    if (pending !== undefined) return { pending, reading, events };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no pending call");
}

describe("CLI remote commands", { timeout: 30_000 }, () => {
  test("tools lists each tool with its risk and scope, as text and as JSON", async () => {
    const text = await api(["tools"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("notes_delete  risky  notes:write  Delete a note");
    expect(text.stdout).toContain("notes_read  safe  notes:read");
    expect(JSON.parse((await api(["tools"], ["--json"])).stdout).tools.map((t: { name: string }) => t.name)).toEqual(["notes_read", "notes_delete"]);
    expect((await api(["approvals"])).stdout.trim()).toBe("no pending approvals");
  });

  test("approvals shows a pending call, and approve with its digest runs it", async () => {
    const { pending, reading, events } = await pendingRun({ text: "Gone." });
    const list = await api(["approvals"]);
    expect(list.stdout).toContain(pending.id);
    expect(list.stdout).toContain(`digest ${pending.digest}`);
    expect(list.stdout).toContain("notes_delete (risky)");
    expect(ran).toEqual([]);
    const result = await api(["approve", pending.id], ["--digest", pending.digest]);
    expect([result.code, result.stdout]).toEqual([0, expect.stringContaining(`approved ${pending.id} by ana`)]);
    await reading;
    expect(ran).toEqual([JSON.stringify({ id: "n1" })]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "end_turn" });
    expect((await api(["approve", pending.id], ["--digest", pending.digest])).stderr).toContain("NOT_FOUND");
  });

  test("approve with a wrong digest fails with exit 1 and the call does not run", async () => {
    const { pending, reading, events } = await pendingRun({ text: "Kept." });
    const result = await api(["approve", pending.id], ["--digest", "wrong"]);
    expect([result.code, result.stderr]).toEqual([1, expect.stringContaining("CONFLICT")]);
    expect(ran).toEqual([]);
    expect((await api(["approve", pending.id], ["--digest", pending.digest], { ASSISTANT_TOKEN: OTHER })).stderr).toContain("NOT_FOUND");
    await api(["deny", pending.id]);
    await reading;
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ denied: "approval" });
  });

  test("deny stops the call, with a reason, and it is final", async () => {
    const { pending, reading, events } = await pendingRun({ text: "Kept." });
    expect((await api(["deny", pending.id], ["--reason", "not now"])).stdout).toContain(`denied ${pending.id} by ana`);
    await reading;
    expect(ran).toEqual([]);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ denied: "approval" });
    expect((await api(["approve", pending.id], ["--digest", pending.digest])).code).toBe(1);
    expect(ran).toEqual([]);
  });

  test("bad usage exits with 2 and never prints the token", async () => {
    const cases: [string[], string][] = [
      [["tools"], "--api and --api-token-env are required"],
      [["tools", "--api", base], "--api and --api-token-env go together"],
      [["approve", "--api", base, "--api-token-env", "ASSISTANT_TOKEN", "--digest", "d"], "approve needs one approval id"],
      [["approve", "x", "--api", base, "--api-token-env", "ASSISTANT_TOKEN"], "approve needs --digest"],
      [["tools", "--api", base, "--api-token-env", "ASSISTANT_TOKEN", "--digest", "d"], "--digest works with approve only"],
      [["tools", "--api", "http://example.com", "--api-token-env", "ASSISTANT_TOKEN"], "https URL"],
      [["approvals", "--api", base, "--api-token-env", "ASSISTANT_TOKEN", "--scope", "notes:write"], "--scope does not work with approvals"],
      [["mcp", "--tools", notes.url, "--scope", "a:b", "--tool-scope", "a:b", "--allow-approve"], "--allow-approve works with mcp and --api only"],
    ];
    for (const [args, message] of cases) {
      const result = await cli(args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stderr + result.stdout).not.toContain(TOKEN);
    }
    expect((await api(["tools"], [], {})).stderr).toContain("environment variable ASSISTANT_TOKEN is not set");
    const bad = await api(["tools"], [], { ASSISTANT_TOKEN: "z".repeat(40) });
    expect([bad.code, bad.stderr, bad.stdout.includes("z".repeat(40))]).toEqual([1, expect.stringContaining("UNAUTHENTICATED"), false]);
    const token = await cli(["tools", "--api", base, "--token", TOKEN]);
    expect(token.code).toBe(2);
    expect(token.stderr).toContain("Unknown option '--token'");
    expect(token.stderr).not.toContain(TOKEN);
  });

  test("--help names the four commands and their flags", async () => {
    const { stdout } = await cli(["--help"]);
    for (const text of ["agentic-assistant tools", "agentic-assistant approvals", "agentic-assistant approve <id> --digest", "agentic-assistant deny <id>", "--api-token-env", "--allow-approve"]) expect(stdout).toContain(text);
  });
});

describe("MCP remote tools", () => {
  async function connect(withApi: boolean, token = TOKEN, allowApprove = false): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp", "--tools", notes.url, "--provider", "scripted", "--script", emptyScript, "--scope", "notes:read", "--tool-scope", "notes:read", ...(withApi ? ["--api", base, "--api-token-env", "ASSISTANT_TOKEN"] : []), ...(allowApprove ? ["--allow-approve"] : [])],
      env: { PATH: process.env.PATH ?? "", ASSISTANT_TOKEN: token },
      stderr: "ignore",
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    return client;
  }
  const body = (result: unknown) => JSON.parse(((result as { content: { text: string }[] }).content[0] as { text: string }).text);
  const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;

  test("without --api there is one tool", async () => {
    const client = await connect(false);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["assistant_chat"]);
    } finally {
      await client.close();
    }
  });

  test("with --api it offers no approve tool, and a call to it fails", async () => {
    const client = await connect(true);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["assistant_chat", "assistant_tools", "assistant_approvals", "assistant_deny"]);
      const { pending, reading } = await pendingRun({ text: "Kept." });
      expect(isError(await client.callTool({ name: "assistant_approve", arguments: { id: pending.id, digest: pending.digest } }))).toBe(true);
      expect(ran).toEqual([]);
      // The arguments of the pending call come back quoted as data, with "<" escaped.
      const listedPending = body(await client.callTool({ name: "assistant_approvals", arguments: {} })).approvals[0];
      expect(listedPending.input).toBe('<tool_output tool="notes_delete">\n{"id":"n1"}\n</tool_output>');
      expect(isError(await client.callTool({ name: "assistant_deny", arguments: {} }))).toBe(true);
      expect(isError(await client.callTool({ name: "assistant_deny", arguments: { id: "missing" } }))).toBe(true);
      expect(body(await client.callTool({ name: "assistant_deny", arguments: { id: pending.id, reason: "no" } }))).toMatchObject({ approved: false });
      await reading;
    } finally {
      await client.close();
    }
  });

  test("with --api and --allow-approve it lists tools and approvals, approves, and denies", async () => {
    const client = await connect(true, TOKEN, true);
    try {
      const listed = (await client.listTools()).tools;
      expect(listed.map((t) => t.name)).toEqual(["assistant_chat", "assistant_tools", "assistant_approvals", "assistant_approve", "assistant_deny"]);
      expect(body(await client.callTool({ name: "assistant_tools", arguments: {} })).tools.map((t: { name: string }) => t.name)).toEqual(["notes_read", "notes_delete"]);
      expect(body(await client.callTool({ name: "assistant_approvals", arguments: {} }))).toEqual({ approvals: [] });

      const first = await pendingRun({ text: "Gone." });
      const pendingList = body(await client.callTool({ name: "assistant_approvals", arguments: {} }));
      expect(pendingList.approvals[0]).toMatchObject({ id: first.pending.id, digest: first.pending.digest });
      expect(pendingList.approvals[0].input).toContain("<tool_output");
      const wrong = await client.callTool({ name: "assistant_approve", arguments: { id: first.pending.id, digest: "wrong" } });
      expect(isError(wrong)).toBe(true);
      expect(JSON.stringify(wrong)).toContain("CONFLICT");
      expect(ran).toEqual([]);
      const approved = body(await client.callTool({ name: "assistant_approve", arguments: { id: first.pending.id, digest: first.pending.digest } }));
      expect(approved).toMatchObject({ requestId: first.pending.id, approved: true, decidedBy: "ana", machineMade: false });
      await first.reading;
      expect(ran).toEqual([JSON.stringify({ id: "n1" })]);
    } finally {
      await client.close();
    }
  });
});

