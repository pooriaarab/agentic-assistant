# agentic-assistant

[![npm version](https://img.shields.io/npm/v/agentic-assistant)](https://www.npmjs.com/package/agentic-assistant)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-assistant) · [Source](https://github.com/pooriaarab/agentic-assistant) · [Support](https://github.com/pooriaarab/agentic-assistant/issues)

An AI assistant that acts inside your apps with the user's own permissions.

> Status: early. The core loop, the tool sources, approvals, the React panel, the CLI, the MCP server, and the hosted HTTP API work.

A demo Worker runs at https://agentic-assistant-demo.hello-fd1.workers.dev. `GET /` shows a demo page and `GET /health` answers 200. The `/api/v1` routes need a bearer key, so without one they answer 401. The demo has no model key set. A signed-in `POST /api/v1/chat` answers 503 with `not_configured`. The demo never fakes an answer.

## Install

```sh
npm install agentic-assistant
```

You need Node.js 22 or newer. The React panel needs `react` 18 or newer.

To build from source:

```sh
git clone https://github.com/pooriaarab/agentic-assistant && cd agentic-assistant
npm ci && npm run build
```

## Quick start

```ts
import { AnthropicProvider, ToolRegistry, createPrincipal, runAssistant } from "agentic-assistant";

const registry = new ToolRegistry().register({
  name: "notes_read",
  description: "Read one note by id",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  scope: "notes:read",
  risk: "safe", // "risky" and "irreversible" tools wait for a person
  handler: async ({ id }) => ({ text: `note ${id}` }),
});

// The host decides the scopes. The assistant never widens them.
const principal = createPrincipal({
  id: "agent-1",
  kind: "agent_of_human",
  parentId: "user-42",
  scopes: ["notes:read"],
});

for await (const event of runAssistant({
  // Reads ANTHROPIC_API_KEY. Model claude-sonnet-5-5. useDefaultEndpoint calls a US-hosted API: pass baseUrl for an EU one.
  provider: new AnthropicProvider({ useDefaultEndpoint: true }),
  registry,
  principal,
  messages: [{ role: "user", content: [{ type: "text", text: "Read note 7." }] }],
  limits: { maxTurns: 6, maxTotalTokens: 50_000 },
})) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
```

## Load tools from an MCP server

```ts
import { connectMcpTools } from "agentic-assistant";

const mcp = await connectMcpTools({
  transport: { type: "stdio", command: "npx", args: ["-y", "some-notes-mcp-server"] },
  // The host decides the scope of each tool, by name. There is no default. Do not trust
  // `tool.annotations`: the server writes them. A tool that is not in the list is skipped.
  scope: (tool) => {
    const scope = { notes_read: "notes:read", notes_write: "notes:write" }[tool.name];
    if (scope === undefined) throw new Error("tool is not on the host's list");
    return scope;
  },
  // The host also says how risky each tool is. There is no default.
  risk: (tool) => (tool.name === "notes_read" ? "safe" : "risky"),
});
registry.registerAll(mcp.tools); // mcp.skipped lists tools that were not loaded, with the reason
// ...run the assistant, then:
await mcp.close();
```

An HTTP server works the same way: `{ type: "http", url: "https://tools.example.eu/mcp", headers: { authorization: "Bearer ..." } }`.

## Ask a person before a risky action

```ts
import { QueueApprovalGate } from "agentic-assistant";

const approvals = new QueueApprovalGate();
for await (const event of runAssistant({ provider, registry, principal, messages, approvals })) {
  if (event.type === "approval_request") {
    showToPerson(event.request); // tool, risk, exact arguments
    // when the person clicks, from any handler:
    //   approvals.approve(event.request.id, "user-42")
    //   approvals.reject(event.request.id, "user-42", "not now")
  }
}
```

An approval covers one request: the tool, the exact arguments, and the acting principal. The request carries a digest of those three. The decision must return the same digest, or the call is refused. The tool runs on a copy of the exact arguments the person saw, so a change to the original object cannot reach it. The agent cannot approve its own action. A gate that fails, a missed deadline (`approvalTimeoutMs`, default five minutes), or a wrong answer means the call is refused. To connect your own approval service, implement `ApprovalGate`: one method that returns a decision.

## Add the side panel

```tsx
import { AssistantPanel } from "agentic-assistant/react";
import "agentic-design/tokens.css";
import "agentic-assistant/react.css";

<AssistantPanel
  title="Notes assistant"
  // Run the assistant where your app wants: in the page, or behind your own HTTP stream.
  run={(messages, signal) => runAssistant({ provider, registry, principal, messages, approvals, signal })}
  // Pass a person's choice to your approval gate. Your app knows who the person is.
  decide={(id, approved, reason) => (approved ? approvals.approve(id, userId) : approvals.reject(id, userId, reason))}
/>;
```

The panel colors are `agentic-design` tokens (`--agd-color-*`), so load `agentic-design/tokens.css` once, as above. The panel also reads the `--agd-*` space, radius, type, control-size, and shadow tokens from the same file. Each one has a fallback. The panel then follows your light or dark theme. Without the tokens the panel uses system colors. Set all `--agd-color-*` tokens or none: a partial set can give a pair that fails contrast. To set your own colors, override the `--aa-*` variables on `.agd-assistant`. If you override `--aa-bg` or `--aa-accent`, also set `--aa-hover-bg` and `--aa-accent-hover`.

The panel streams the answer, shows each tool call as a card, and shows an approval prompt with the exact arguments. Every message, card, and prompt that the assistant makes carries a visible "AI-generated" label. Tool output is shown as text and never as HTML. The panel does not hold a model, a key, or a gate. It needs `react` 18 or newer.

The look comes from plain CSS variables (`--aa-bg`, `--aa-fg`, `--aa-accent`, and others). Set them on `.agd-assistant` or a parent. The sheet loads no font, image, or file from another host. A prompt that the run left open (after Stop or an error) is closed and marked expired. Closing the panel stops the run.

## Use the CLI

```sh
export ANTHROPIC_API_KEY=...
agentic-assistant chat \
  --tools https://notes.example.eu/mcp --tools-header-env authorization=NOTES_TOKEN \
  --scope notes:read --tool-scope notes:read --tool-risk safe \
  --use-default-endpoint \
  "What does note 7 say?"
```

The assistant prints its answer on stdout. The answer starts with `Assistant (machine-made):`. Tool calls and approval requests on stderr start with `[machine-made]`, and so does the question that `--approve ask` shows. Control characters are removed from all text it prints for a person, so a tool cannot move your cursor or change your terminal title. `--json` events are not changed: they carry the `actor` with `machineMade: true` on each action, and the text events belong to the labeled run. Add `--json` to get one event per line on stdout: that is the form for agents and tests. The exit code is 0 when the run ends normally, 1 when it stops for another reason (a cap, an error), and 2 for a usage error.

- `--tools` takes an `https` MCP URL, or a command that starts a server on stdio (words split on spaces, or a JSON list like `'["node","server.js"]'`).
- `--scope` is what the assistant may hold. `--tool-scope` is what each tool needs. Both are required, and the CLI guesses neither.
- `--tool-risk` defaults to `risky`. A risky call needs approval. Approve one exact call ahead of time with `--approve-call '{"tool":"notes_write","input":{"id":"7","text":"hi"}}'`. The call must match the tool and the arguments, and each approval is used once. On a terminal, `--approve ask` asks you.
- Keys come from the environment: `ANTHROPIC_API_KEY`, or the variable named by `--api-key-env`. There is no flag that takes a key.
- With `ANTHROPIC_API_KEY`, or the variable named by `--api-key-env`, unset or empty, `mcp` prints one line on stderr that names the variable, writes nothing to stdout, and exits 2.
- For an EU-hosted model, use `--provider openai-compatible --base-url https://models.example.eu/v1 --model <id> --api-key-env EU_KEY`. Add `--price-in` and `--price-out` to use the cost cap.
- A message on stdin may be up to 1 MB.
- Limits: `--max-turns`, `--max-tokens`, `--max-cost`, `--max-tool-calls`.
- `--provider scripted --script turns.json` replays fixed turns. It is for tests.

## Run it as an MCP server

```sh
agentic-assistant mcp --tools https://notes.example.eu/mcp --scope notes:read --tool-scope notes:read --tool-risk safe --use-default-endpoint
```

Add this to an MCP client as a stdio server. Without `--api`, it offers one tool, `assistant_chat`, with one argument, `message`. Each call starts a new conversation. The reply is JSON with `machineMade: true`, the answer, the stop reason, and the tool calls. A run that stops on a cap is an error result. The caps (`--max-turns`, `--max-cost`) apply to one call, and the server has no total limit, so set a limit in the client that calls it. The server stops when the client closes its input. A call that is still running is cancelled and dropped: the client gets no reply for it. The tool servers are closed. The server cannot ask a person, so a risky call runs only when you started the server with a matching `--approve-call`.

### Tools and approvals from the CLI and MCP

A running assistant API holds the calls that wait for a person. Four CLI commands reach it. The token comes from an environment variable, never from an argument.

```sh
export ASSISTANT_TOKEN=...
agentic-assistant approvals --api https://assistant.example.eu --api-token-env ASSISTANT_TOKEN
agentic-assistant approve <id> --digest <digest> --api https://assistant.example.eu --api-token-env ASSISTANT_TOKEN
```

`tools` lists the tools, `approvals` prints the id and digest of each waiting call, `approve` needs that digest so you approve the exact call you read, and `deny <id> --reason ...` is final. Add `--json` for JSON. Exit codes: 0 done, 1 the API refused or failed, 2 bad usage.

Start the MCP server with `--api` and `--api-token-env` and it also offers `assistant_tools`, `assistant_approvals`, and `assistant_deny`. They act with the token you gave. `assistant_approvals` returns the arguments of each call quoted as data. `assistant_approve` is off unless you add `--allow-approve`. An AI client could use it to approve a call in the name of the token's owner. So use a token for an agent, which needs the `assistant:admin` scope and is recorded as machine-made. Never give it a person's token.

## Run it as a hosted HTTP API

```ts
// src/index.ts of your Worker. `store`, `registry`, and `Env` are yours.
import { createWorker } from "agentic-assistant/worker";
import { AnthropicProvider } from "agentic-assistant";
import { createStoreAuth } from "agentic-identity";

let worker: ReturnType<typeof createWorker> | undefined;

export default {
  fetch(request: Request, env: Env) {
    // Build the worker once. It keeps the pending approvals, so a new one per request would lose them.
    worker ??= createWorker({
      auth: createStoreAuth(store(env)),
      registry,
      provider: () => new AnthropicProvider({ baseUrl: env.MODEL_URL, apiKey: env.MODEL_KEY }),
    });
    return worker.fetch(request, env);
  },
};
```

To deploy the demo Worker yourself, set the secrets `ASSISTANT_TOKENS` (a JSON map of a bearer token of 32 to 512 characters from `A-Za-z0-9_-` to `{"id":"ana","scopes":["demo:read"]}`) and `MODEL_KEY`, set the var `MODEL_URL` (or `MODEL_USE_DEFAULT_ENDPOINT=1` to call the US-hosted `api.anthropic.com`), then run `npm run deploy:demo`. Without `MODEL_KEY`, chat answers 503. `agentic-assistant/worker` also exports `createStaticTokenAuth`, an `agentic-identity` `Auth` for a fixed map of bearer tokens. The demo Worker requires the scope `demo:read` on every route (a 403 without it): add it to each `ASSISTANT_TOKENS` entry when you upgrade. In your own Worker, pass `routeScopes` to `createWorker` to ask for a scope per route group.

Every route is under `/api/v1` and needs `Authorization: Bearer <key>`. The key resolves to an `agentic-identity` principal. A person, an agent, and a token that acts for a user all work. A missing, bad, or odd credential is a 401. An Auth that fails gives a 503. A write signed in with a session cookie needs an `Origin` listed in the `origins` option, or it is a 403. Every chat response has the header `x-ai-generated: true`.

| Route | What it does |
|---|---|
| `GET /tools` | The tools inside the caller's scopes: name, description, scope, risk, input schema. |
| `POST /chat` `{"message":"..."}` | One new conversation. The answer is a stream of server-sent events (`event: <type>`, `data: <json>`), the same events as `runAssistant`, ending with `done`. |
| `GET /approvals` | Pending risky calls of the same owner, with the digest and `canDecide`. |
| `POST /approvals/:id/approve` `{"digest":"..."}` | Approve the exact call. A wrong digest is a 409. |
| `POST /approvals/:id/deny` `{"reason":"..."}` | Refuse the call. |

The assistant holds the caller's scopes and no more. A chat turn waits at a risky call until another principal decides. The stream stays open for that time. A principal that asked for the turn never decides on its own proposal: an agent gets a 403 for both approve and deny. The same holds for an agent it made and for the agent that made it. A person who asks may decide, because the assistant proposed the call. Another agent may decide only when it holds `assistant:admin` and the scope of the tool. A principal with another owner sees a 404. The list hides a call whose tool the caller has no scope for. If a client hangs up, the run stops and its pending calls go. If the key is revoked or its scopes change during a run, the run stops before its next tool call.

## Use the HTTP client

`agentic-assistant/client` is a typed client for the hosted API routes. It uses only `fetch`, so it runs in Workers and Node. In a browser it works on the same origin only, because the API sends no CORS headers.

```ts
import { createClient, AssistantApiError } from "agentic-assistant/client";

const assistant = createClient({ baseUrl: "https://assistant.example.com", token });
const tools = await assistant.tools();
for await (const event of assistant.chat("Delete note n1")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
try {
  const [pending] = await assistant.approvals();
  if (pending?.canDecide) await assistant.approve(pending.id, pending.digest);
} catch (error) {
  if (error instanceof AssistantApiError) console.error(error.code, error.status);
}
```

- The methods match the routes: `health`, `tools`, `chat`, `approvals`, `approve`, `deny`. Each takes an optional `{ signal }` as its last argument.
- `chat` is an async generator of the same events as `runAssistant`, ending with `done`. It sends the request on the first read. A run that fails on the server ends with an `error` event. A stream that ends with no `done` or `error` throws `UNKNOWN`: the run did not finish. Stop reading to stop the run. The stream stays open while a risky call waits, so decide from another call.
- `baseUrl` is the Worker URL: `https`, or `http` on `localhost`, `127.0.0.1`, or `[::1]`, with no query, hash, or credentials. A path prefix is for a host that strips it before the Worker. Pass `fetch` to use your own. `health` sends no token.
- A failed call throws `AssistantApiError`. `code` is `INVALID_INPUT`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `CONFLICT`, `RATE_LIMITED`, `NOT_CONFIGURED`, `INTERNAL`, or `UNKNOWN`. `status` is the HTTP status. `retryAfter` is set for a 429. A `200` reply with the wrong shape fails as `UNKNOWN`.
- The client never follows a redirect and never retries. A decision that you abort after the client sends it can still apply: read `approvals()` before you try again.

## AI transparency

The package marks what the assistant makes as AI-generated. This follows the idea of EU AI Act Article 50.

Each tool result and each finished run carries a `provenance` record: `generator: "ai"`, the model, the provider, the time, the assistant id, the person it acts for, and the tool, its risk, and the approver when someone approved the call. The approver has a `kind`: `human`, `agent`, `host` (a rule you set), or `unknown`. Say "a person approved" only for `human`. After a fallback, the record names the model that answered. A denied call has no record, because nothing ran.

```ts
import { provenanceLabel, provenanceMarker } from "agentic-assistant";

for await (const event of runAssistant(options)) {
  if (event.type === "tool_result" && event.provenance) {
    provenanceLabel(event.provenance); // "AI-generated by model-1 (acme), approved by ana"
    provenanceMarker(event.provenance); // JSON-LD with the IPTC trainedAlgorithmicMedia source type
  }
}
```

The record is in the SDK events, in the HTTP chat stream, in `--json` output of the CLI, and in the `assistant_chat` result of the MCP server. The MCP result also holds `label` and `marker`. The CLI prints the label after each run.

The host must still do these things:

- Store the marker with every document or file the assistant changes.
- Show the label to people where they read the content.
- Label chat text that the assistant makes, if you show it outside this package.
- Keep records as long as the law needs, and get legal advice. This package does not make a deployment compliant.

The record says who made the content. It does not say the content is true.

## Features

- **Model port.** `ModelProvider` has two adapters. `AnthropicProvider` needs a `baseUrl`, or `useDefaultEndpoint: true` to call `api.anthropic.com`, which is a US-hosted endpoint. There is no silent default. `OpenAICompatibleProvider` calls any server that speaks the chat-completions stream, so you can use an EU-hosted model. Both adapters need an `https` URL, except for `localhost`. If you pass your own `client` to `AnthropicProvider`, you own its endpoint. The OpenAI-compatible adapter needs an API key for any other host and cuts a response at a size limit.
- **Scoped tools.** Each tool names the scope it needs, for example `notes:write`. Scopes use the same `<resource>:<action>` format as `agentic-identity`. The model sees only the tools inside the scopes. The loop refuses a call to any other tool.
- **Tool sources.** Load tools from an MCP server over stdio or HTTP, or write typed SDK tools with `defineTool`. The loader skips a tool with a bad name, schema, or scope. It keeps text output and leaves images and other content out. It cuts long output, long descriptions, and long text inside schemas. It skips a duplicate name, a schema that is too large, and a schema with a regular expression (`pattern`). It stops at a page limit, a load time, and a size limit on each HTTP response.
- **Input validation.** The loop checks each call against the tool's JSON Schema before the handler runs. Nothing is coerced. A bad call returns an error to the model and never reaches the tool.
- **Tool output is data.** Each result is quoted in `<tool_output>` tags. Every `<` in the output is escaped. Every request carries a notice that tool output is never an instruction. This lowers the risk of prompt injection. It does not remove it: keep tools narrow and scopes small.
- **Approvals.** Every tool has a required `risk`: `safe`, `risky`, or `irreversible`. The loop asks the `ApprovalGate` before a risky or irreversible call. With no gate, those tools are not offered and are refused. The text a person writes when they decline goes to the event, not to the model.
- **React panel.** `agentic-assistant/react` has `AssistantPanel` and `useAssistant`. It is built to these WCAG 2.2 AA points: named controls, a live conversation log, keyboard use, focus that moves to an approval prompt and then to the message box, buttons that are at least 32 px, a visible focus ring, and a color palette checked for contrast.
- **CLI and MCP server.** `chat` and `mcp` take the host choices as flags and refuse to guess a scope.
- **Fixed principal.** The assistant always acts as `agent_of_human`. `createPrincipal` throws when the kind is missing or different.
- **Caps.** A max-turn cap, a total-token cap, and a cost cap. A cap that trips stops the run. No tool runs after that. A tool result is cut at `maxToolResultChars`. A request that is sure to pass the token cap is not sent. The cost cap also limits the output of each request. A turn with more than `maxToolCallsPerTurn` calls (default 16) runs none of them.
- **Stops that fail closed.** An expired or revoked principal stops the run. So does a revocation check that throws or returns anything but `false`. The loop checks the principal again at the start of each run. A provider error ends the run with `reason: "provider_error"` and keeps the transcript. Truncated or refused model output never runs its tool calls.
- **Machine-made labels.** Every tool call, result, and the end of each run carry an `actor` with `machineMade: true`.
- **Test provider.** `agentic-assistant/testing` exports `ScriptedProvider`. It replays a fixed script for E2E tests.

## Limits

- The hosted API keeps pending approvals in the memory of one Worker instance. A decision must reach the instance that holds the chat stream. Run it on one instance or behind sticky routing until a shared queue exists. It has no per-IP limit, only a cap of four chat turns at once per principal.
- The tests run the API under Node with a fake model. They do not run it under `wrangler dev`. The demo Worker was checked by hand under `wrangler dev` and on workers.dev.
- Workers refuse code generation, so there a tool schema is checked by a small built-in checker, not by Ajv. It supports type, properties, required, additionalProperties, enum, const, items, length and size bounds, and anyOf, oneOf, allOf. It accepts annotation keywords such as `description` and `format` but does not check `format`, as the Ajv setup does not. It refuses a tool whose schema has any other keyword, such as `$ref`.
- The CLI reads one message, or a short conversation on a terminal. It does not keep a conversation between runs.
- The panel is tested in a simulated browser (jsdom). Contrast is checked from the CSS values. Run a screen reader and a real browser before you ship it to people who need it.
- The panel shows plain text, not Markdown.
- The gate trusts the name that `decidedBy` carries. Your gate must check who the person is. `QueueApprovalGate` does not.
- An MCP server is trusted for its own output only. The assistant does not sandbox the server process. Run stdio servers you trust.
- Token and cost caps need the provider to report usage. The OpenAI-compatible adapter throws when the server sends none.
- A cost is an estimate from the `pricing` you give. Cache discounts are not applied. The built-in Anthropic prices were checked on 2026-10-29 (`PRICING_CHECKED_ON`). A test fails when that date is over 120 days old. Haiku has no built-in price, because its rate changes with the prompt size. Pass `pricing` for it. Check the prices before you rely on a cap.
- The token pre-check guesses three characters per token. It is an estimate.
- A tool error text goes to the `detail` field of the event. The model sees only `tool failed`.
- A model refusal stops the run, unless you set a fallback model. `FallbackProvider(primary, fallback)` or `--fallback-model <id>` asks the second model once when the first refuses or fails. Each `turn_end` event has `answeredBy` with the model that answered. The text of the first model is held until its turn ends, so a turn with a fallback does not stream word by word. A refusal from the fallback stops the run. The fallback gets only the output room that the first ask left, and the caps count the input of both asks, so a token or cost cap holds. A first ask that failed after it streamed is counted by an estimate. If the fallback itself fails after it streamed, the totals of that run leave out the first ask. Its error text is not kept.

## Develop

```sh
npm ci
npm run ci:local
```

The live smoke test calls the real Anthropic API. It costs a few cents, so it runs only when you ask:

```sh
AGENTIC_ASSISTANT_LIVE=1 ANTHROPIC_API_KEY=... npx vitest run src/live.smoke.test.ts
```

## License

MIT.
