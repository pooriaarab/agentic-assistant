# agentic-assistant

[![npm version](https://img.shields.io/npm/v/agentic-assistant)](https://www.npmjs.com/package/agentic-assistant)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-assistant) · [Source](https://github.com/pooriaarab/agentic-assistant) · [Support](https://github.com/pooriaarab/agentic-assistant/issues)

An AI assistant that acts inside your apps with the user's own permissions.

> Status: early. The core loop, the tool sources, approvals, and the React panel work. It is not on npm yet.
> The chat CLI is not built yet.

## Install

The package is not on npm yet. Build it from source:

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
import "agentic-assistant/react.css";

<AssistantPanel
  title="Notes assistant"
  // Run the assistant where your app wants: in the page, or behind your own HTTP stream.
  run={(messages, signal) => runAssistant({ provider, registry, principal, messages, approvals, signal })}
  // Pass a person's choice to your approval gate. Your app knows who the person is.
  decide={(id, approved, reason) => (approved ? approvals.approve(id, userId) : approvals.reject(id, userId, reason))}
/>;
```

The panel streams the answer, shows each tool call as a card, and shows an approval prompt with the exact arguments. Every message, card, and prompt that the assistant makes carries a visible "Machine-made" label. Tool output is shown as text and never as HTML. The panel does not hold a model, a key, or a gate. It needs `react` 18 or newer.

The look comes from plain CSS variables (`--aa-bg`, `--aa-fg`, `--aa-accent`, and others). Set them on `.aa-panel` or a parent. They will switch to the agentic-design tokens when those are published. The sheet loads no font, image, or file from another host.

## Features

- **Model port.** `ModelProvider` has two adapters. `AnthropicProvider` needs a `baseUrl`, or `useDefaultEndpoint: true` to call `api.anthropic.com`, which is a US-hosted endpoint. There is no silent default. `OpenAICompatibleProvider` calls any server that speaks the chat-completions stream, so you can use an EU-hosted model. Both adapters need an `https` URL, except for `localhost`. If you pass your own `client` to `AnthropicProvider`, you own its endpoint. The OpenAI-compatible adapter needs an API key for any other host and cuts a response at a size limit.
- **Scoped tools.** Each tool names the scope it needs, for example `notes:write`. Scopes use the same `<resource>:<action>` format as `agentic-identity`. The model sees only the tools inside the scopes. The loop refuses a call to any other tool.
- **Tool sources.** Load tools from an MCP server over stdio or HTTP, or write typed SDK tools with `defineTool`. The loader skips a tool with a bad name, schema, or scope. It keeps text output and leaves images and other content out. It cuts long output, long descriptions, and long text inside schemas. It skips a duplicate name, a schema that is too large, and a schema with a regular expression (`pattern`). It stops at a page limit, a load time, and a size limit on each HTTP response.
- **Input validation.** The loop checks each call against the tool's JSON Schema before the handler runs. Nothing is coerced. A bad call returns an error to the model and never reaches the tool.
- **Tool output is data.** Each result is quoted in `<tool_output>` tags. Every `<` in the output is escaped. Every request carries a notice that tool output is never an instruction. This lowers the risk of prompt injection. It does not remove it: keep tools narrow and scopes small.
- **Approvals.** Every tool has a required `risk`: `safe`, `risky`, or `irreversible`. The loop asks the `ApprovalGate` before a risky or irreversible call. With no gate, those tools are not offered and are refused. The text a person writes when they decline goes to the event, not to the model.
- **React panel.** `agentic-assistant/react` has `AssistantPanel` and `useAssistant`. It meets the WCAG 2.2 AA points that code can check: named controls, a live conversation log, keyboard use, focus that moves to an approval prompt and back, a 32 px minimum target size, a visible focus ring, and a color palette checked for contrast.
- **Fixed principal.** The assistant always acts as `agent_of_human`. `createPrincipal` throws when the kind is missing or different.
- **Caps.** A max-turn cap, a total-token cap, and a cost cap. A cap that trips stops the run. No tool runs after that. A tool result is cut at `maxToolResultChars`. A request that is sure to pass the token cap is not sent. The cost cap also limits the output of each request. A turn with more than `maxToolCallsPerTurn` calls (default 16) runs none of them.
- **Stops that fail closed.** An expired or revoked principal stops the run. So does a revocation check that throws or returns anything but `false`. The loop checks the principal again at the start of each run. A provider error ends the run with `reason: "provider_error"` and keeps the transcript. Truncated or refused model output never runs its tool calls.
- **Machine-made labels.** Every tool call, result, and the end of each run carry an `actor` with `machineMade: true`.
- **Test provider.** `agentic-assistant/testing` exports `ScriptedProvider`. It replays a fixed script for E2E tests.

## Limits

- The panel is tested in a simulated browser (jsdom). Contrast is checked from the CSS values. Run a screen reader and a real browser before you ship it to people who need it.
- The panel shows plain text, not Markdown.
- The gate trusts the name that `decidedBy` carries. Your gate must check who the person is. `QueueApprovalGate` does not.
- An MCP server is trusted for its own output only. The assistant does not sandbox the server process. Run stdio servers you trust.
- Token and cost caps need the provider to report usage. The OpenAI-compatible adapter throws when the server sends none.
- A cost is an estimate from the `pricing` you give. Cache discounts are not applied. The built-in Anthropic prices are from 2026-10-06. Check them.
- The token pre-check guesses three characters per token. It is an estimate.
- A tool error text goes to the `detail` field of the event. The model sees only `tool failed`.
- A model refusal stops the run. No automatic fallback model is set up.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
