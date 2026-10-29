# Changelog

## Unreleased

Added

- CLI commands `tools`, `approvals`, `approve <id> --digest <d>`, and `deny <id>`. They call a running assistant API with `--api <url>` and `--api-token-env <NAME>`.
- With those flags, `agentic-assistant mcp` also serves `assistant_tools`, `assistant_approvals`, and `assistant_deny`. `--allow-approve` adds `assistant_approve`.

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
