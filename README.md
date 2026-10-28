# agentic-assistant

[![npm version](https://img.shields.io/npm/v/agentic-assistant)](https://www.npmjs.com/package/agentic-assistant)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-assistant) · [Source](https://github.com/pooriaarab/agentic-assistant) · [Support](https://github.com/pooriaarab/agentic-assistant/issues)

An AI assistant panel that acts inside your apps with the user's own permissions.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- An agent loop that calls app tools through their SDK or MCP server.
- Acts as an agent of the signed-in person, with scopes that only narrow.
- Asks for approval before risky or irreversible actions.
- A model port: use Anthropic by default or an EU-hosted model instead.
- A React side panel built on the shared design system.
- Every action it takes is labeled as machine-made.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-assistant"`.
- **CLI**: `npx agentic-assistant --help`.
- **MCP server**: `npx agentic-assistant mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
