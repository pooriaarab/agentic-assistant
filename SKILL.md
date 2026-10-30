---
name: agentic-assistant
description: An AI assistant that acts inside your apps with the user's own permissions. Use it to embed a scoped, capped, streaming agent loop with a model port. Keywords: assistant,ai,agent,tools,mcp,sdk,side-panel,approvals,eu,model-port.
---

# agentic-assistant

## Use the SDK

```ts
import { runAssistant, ToolRegistry, createPrincipal, AnthropicProvider } from "agentic-assistant";

const principal = createPrincipal({ id: "agent-1", kind: "agent_of_human", parentId: "user-42", scopes: ["notes:read"] });
for await (const event of runAssistant({ provider: new AnthropicProvider({ useDefaultEndpoint: true }), registry, principal, messages })) {
  // run_start, turn_start, text_delta, tool_call, approval_request, approval_decision, tool_result, turn_end, done
}
```

## Load tools from an MCP server

```ts
const mcp = await connectMcpTools({ transport: { type: "stdio", command: "node", args: ["server.js"] }, scope: "notes:read", risk: "safe" });
registry.registerAll(mcp.tools);
```

## Ask a person first

Give each tool a `risk`. Pass `approvals: new QueueApprovalGate()` to `runAssistant`. On an `approval_request` event, show the exact arguments. Then call `approve(id, personId)` or `reject(id, personId)`.

## Serve the HTTP API

```ts
import { createWorker } from "agentic-assistant/worker";
const worker = createWorker({ auth, registry, provider: () => model });
```

Routes: `GET /api/v1/tools`, `POST /api/v1/chat` (server-sent events), `GET /api/v1/approvals`, `POST /api/v1/approvals/:id/approve` with the digest, and `/deny`. The caller that asked for a turn never decides on it, if it is an agent.

## Use the CLI

```sh
agentic-assistant chat --tools <mcp-url> --scope notes:read --tool-scope notes:read --tool-risk safe --json "message"
```

Set the key in the environment. Approve one exact risky call with `--approve-call`. Read the exit code: 0 normal, 1 stopped or failed, 2 usage.
To list tools and decide on pending calls on a running API, use `agentic-assistant tools|approvals|approve <id> --digest <d>|deny <id> --api <url> --api-token-env <NAME>`. Never approve a call you proposed. Wait for the person.

## Show a panel

```tsx
<AssistantPanel run={(messages, signal) => runAssistant({ ...options, messages, signal })} decide={(id, ok) => (ok ? gate.approve(id, userId) : gate.reject(id, userId))} />
```

Import `agentic-design/tokens.css` and `agentic-assistant/react.css` too (the panel colors are design tokens). Label every assistant part as machine-made.

## Account export and erase

- Account contributor: `import { assistantAccount } from "agentic-assistant/account"`; register it with `createAccountRegistry()` from `agentic-identity/account`. It holds no persistent account data.

## Test without a model

Use `ScriptedProvider` from `agentic-assistant/testing`. Give it one scripted turn per model call.

## Rules

- Pass only the scopes the person granted.
- A denied call stays denied.
- Never approve your own action.
- Read `done.reason` to learn why a run stopped.
