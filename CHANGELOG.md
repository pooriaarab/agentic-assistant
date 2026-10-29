# Changelog

## 0.5.0

Added

- `routeScopes` option on `createAssistantApi` and `createWorker`: a scope that a caller must hold for `tools`, `chat`, or `approvals`. The default is no extra scope, so the public API does not change.
- CLI commands `tools`, `approvals`, `approve <id> --digest <d>`, and `deny <id>`. They call a running assistant API with `--api <url>` and `--api-token-env <NAME>`.
- With those flags, `agentic-assistant mcp` also serves `assistant_tools`, `assistant_approvals`, and `assistant_deny`. `--allow-approve` adds `assistant_approve`.

Changed

- `createStaticTokenAuth` now builds a `createStoreAuth` over a memory Store. The local `Authorization` header parser is gone, so `agentic-identity` reads the credential. A token now also signs in as a `session` cookie, and a write by cookie needs an origin in `origins`. A token map may not use one `id` twice.
- The demo Worker needs the scope `demo:read` on every `/api/v1` route. A token without it gets a 403. Migration: add `demo:read` to each scope list in `ASSISTANT_TOKENS`.
- `react.css` has no hex colors. Its `--aa-*` variables read the `agentic-design` tokens (`--ad-color-*`), so the panel follows the host theme, including dark mode. Load `agentic-design/tokens.css` on the page. Without it each variable falls back to a system color, and the panel loses its blue accent, tinted cards, amber approval box, and red danger color (the risk notice shows in link blue). The palette shifts a little (for example the accent is now `#2B4BC4`). `agentic-design` is an optional peer dependency (`^0.3.1`).
- The OpenAI-compatible provider and the MCP tool source have unit tests.

Migration from 0.4.0 (breaking: the auth path changed)

- Static tokens are read by `agentic-identity` now. A bad or odd credential is still a 401. Check each caller after the upgrade, because the new route scope check can refuse a caller that worked before.
- If you use the demo Worker, add `demo:read` to the scope list of each `ASSISTANT_TOKENS` entry. Without it every `/api/v1` route answers 403.
- If you use `createWorker` with `routeScopes`, give each caller the scope of every route group it calls. Without it the caller gets 403 on that route.
- If you use `createStaticTokenAuth`, give each token its own `id`. A map that uses one `id` twice throws when it is built.
- A token now also signs in as the `session` cookie. A write made with the cookie needs its `Origin` in the `origins` option, or it is a 403. Add the origins of your web app before you ship.

## 0.4.0

Added

- `origins` option on `createAssistantApi` and `createWorker`: origins that may send a write signed in with a session cookie.

Changed

- The HTTP API reads the credential with `requirePrincipal` from `agentic-identity/http` and checks the kind with `PRINCIPAL_KINDS`. The `agentic-identity` dependency is now `^0.6.0`.
- A bearer token must hold only `A-Za-z0-9_-` and at most 512 characters, or the call is a 401. `createStaticTokenAuth` refuses other tokens when it is built.
- An Auth that throws gives a 503, not a 401. A cookie write from an origin not in `origins` gives a 403.

## 0.3.0

Added

- `agentic-assistant/client`, a typed fetch-based client for the HTTP API: `health`, `tools`, `chat` (an async generator of events), `approvals`, `approve`, and `deny`. It has an injectable `fetch`, a base URL, and a typed `AssistantApiError`.
- A demo Worker entry (`dist/demo.js`, built from `src/demo.ts`), `wrangler.demo.jsonc`, and `npm run deploy:demo`. It serves a demo page, `/health`, and the `/api/v1` routes with bearer auth. With no model key, chat answers 503 `not_configured`.
- `createStaticTokenAuth`, an `agentic-identity` `Auth` for a fixed map of bearer tokens.
- Chat responses carry the header `x-ai-generated: true`.
- A small schema checker for hosts that refuse code generation, such as Workers. It fails closed on keywords it does not support.

Removed

- The default export of `agentic-assistant/worker` (a stub that answered `/health` only). Use `createWorker`.

Changed

- The package needs Node.js 22 or newer. `agentic-identity` needs Node 22, so `engines.node` is now `>=22`. It was `>=18`.
- The `agentic-identity` dependency is now `^0.4.0`. It was `^0.3.0`. The exported names did not change.

## 0.2.0

Added

- AI transparency. Each tool result whose tool ran, and each run that got a model answer, carries a `provenance` record with `generator: "ai"`, model, provider, time, assistant id, the person it acts for, the tool and its risk, and the approver with a `kind`. A denied call has no record.
- `createProvenance`, `provenanceMarker` (JSON-LD with the IPTC `trainedAlgorithmicMedia` source type) and `provenanceLabel`.
- The record is in SDK events, the HTTP chat stream, `--json` output of the CLI, and `assistant_chat` results of the MCP server. The MCP result also holds `label` and `marker`. The CLI prints the label after a run.
- Approval decisions may carry `approverKind` (`human`, `agent`, or `host`). A decision without it is recorded as `unknown`. `QueueApprovalGate.approve(id, decidedBy, approverKind)` takes it as a third argument: pass it, or every record shows `unknown`. The CLI sets `host` for a pre-approved call and `human` for a typed yes. The HTTP API sets `human` for a person and `agent` for any other caller.

Changed

- A provider that gives an empty model or provider name now ends the run with `provider_error` before any tool runs.

## 0.1.0

First release.
