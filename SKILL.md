---
name: agentic-assistant
description: An AI assistant panel that acts inside your apps with the user's own permissions. Keywords: assistant,ai,agent,tools,mcp,sdk,side-panel,approvals,eu,model-port.
---

# agentic-assistant

An AI assistant panel that acts inside your apps with the user's own permissions.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-assistant";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-assistant summary --text "some text"
agentic-assistant dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-assistant mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
