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
  // run_start, text_delta, tool_call, tool_result, turn_end, done
}
```

## Load tools from an MCP server

```ts
const mcp = await connectMcpTools({ transport: { type: "stdio", command: "node", args: ["server.js"] }, scope: "notes:read" });
registry.registerAll(mcp.tools);
```

## Test without a model

Use `ScriptedProvider` from `agentic-assistant/testing`. Give it one scripted turn per model call.

## Rules

- Pass only the scopes the person granted.
- A denied call stays denied.
- Read `done.reason` to learn why a run stopped.
