# agentic-assistant

[![npm version](https://img.shields.io/npm/v/agentic-assistant)](https://www.npmjs.com/package/agentic-assistant)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-assistant) · [Source](https://github.com/pooriaarab/agentic-assistant) · [Support](https://github.com/pooriaarab/agentic-assistant/issues)

An AI assistant that acts inside your apps with the user's own permissions.

> Status: early. The core loop works. It is not on npm yet. Tool sources, approvals,
> the React panel, and the chat CLI are not built yet.

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

## Features

- **Model port.** `ModelProvider` has two adapters. `AnthropicProvider` needs a `baseUrl`, or `useDefaultEndpoint: true` to call `api.anthropic.com`, which is a US-hosted endpoint. There is no silent default. `OpenAICompatibleProvider` calls any server that speaks the chat-completions stream, so you can use an EU-hosted model. Both adapters need an `https` URL, except for `localhost`. The OpenAI-compatible adapter needs an API key for any other host and cuts a response at a size limit.
- **Scoped tools.** Each tool names the scope it needs, for example `notes:write`. Scopes use the same `<resource>:<action>` format as `agentic-identity`. The model sees only the tools inside the scopes. The loop refuses a call to any other tool.
- **Fixed principal.** The assistant always acts as `agent_of_human`. `createPrincipal` throws when the kind is missing or different.
- **Caps.** A max-turn cap, a total-token cap, and a cost cap. A cap that trips stops the run. No tool runs after that. A tool result is cut at `maxToolResultChars`. A request that is sure to pass the token cap is not sent.
- **Stops that fail closed.** An expired or revoked principal stops the run. So does a revocation check that throws or returns anything but `false`. The loop checks the principal again at the start of each run. A provider error ends the run with `reason: "provider_error"` and keeps the transcript. Truncated or refused model output never runs its tool calls.
- **Machine-made labels.** Every tool call, result, and the end of each run carry an `actor` with `machineMade: true`.
- **Test provider.** `agentic-assistant/testing` exports `ScriptedProvider`. It replays a fixed script for E2E tests.

## Limits

- No tool validation, MCP source, or approvals yet.
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
