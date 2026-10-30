# Changelog

## 0.7.4

- Add `agentic-assistant/account` with a typed, stateless account contributor.
- Match the account registry contract in `agentic-identity` 0.10.
- Document the host boundary for transcripts, shared data, and agent outputs.

## 0.7.3

- Support agentic-design 0.8 and 0.9 and agentic-identity 0.9 and 0.10.

## 0.7.2

Patch. No change to the SDK, CLI, React panel, or HTTP shape.

Fixed

- The optional peer `agentic-design` range is `>=0.5.0 <0.9.0` (was `>=0.5.0 <0.8.0`). A fresh `npm install agentic-assistant agentic-design@latest` no longer fails with ERESOLVE, because `agentic-design` 0.8.0 is in range. The `--agd-*` tokens the panel reads are the same 67 names and values in 0.7.1 and 0.8.0, so the panel needs no change.

Changed

- The dev dependency `agentic-design` is `^0.8.0`. The lockfile follows.

## 0.7.1

Patch. No change to the SDK, CLI, React panel, or HTTP shape.

Fixed

- The optional peer `agentic-design` range is `>=0.5.0 <0.8.0` (was `^0.5.0`). A fresh `npm install agentic-assistant agentic-design@latest` no longer fails with ERESOLVE, because `agentic-design` 0.7.1 is in range. The panel reads only `--agd-color-*`, space, radius, type, control-size, and shadow tokens. Every one it uses exists in both 0.5.0 and 0.7.1.

Changed

- The dev dependency `agentic-design` is `^0.7.1`. The lockfile follows.

## 0.7.0

Changed

- The chat panel has the agentic-design 0.5 calm look. Cards and messages have soft borders. The text field, buttons, approval prompt, and warnings keep a strong edge. The panel reads the `--agd-*` space, radius, type, control-size, and shadow tokens, each with a fallback. The focus ring is 2px (was 3px). A disabled button has a dashed edge.
- BREAKING: panel class names use the `agd-` prefix. Your `.aa-*` overrides stop applying without an error. Migration: `.aa-panel` is now `.agd-assistant`, and each part is `.agd-assistant__<part>` (`.aa-button` is `.agd-assistant__button`, `.aa-primary` is `.agd-assistant__primary`). Rename any override in your own CSS. The `--aa-*` variables keep their names. New variables: `--aa-edge` sets the strong edge, `--aa-border` is now the soft border, and `--aa-hover-bg`, `--aa-accent-hover`, and `--aa-shadow` set the hover and shadow. If you override `--aa-bg` or `--aa-accent`, also set `--aa-hover-bg` and `--aa-accent-hover`, so hover text stays readable.
- The label on every part the assistant makes reads "AI-generated" (it read "Machine-made"). It stays visible and is real text, so a screen reader reads it. The `data-machine-made` attribute does not change.

## 0.6.1

Patch. No change to the SDK, CLI or HTTP shape.

Changed

- `agentic-identity` is `^0.8.0`. The lockfile follows. The 0.8.0 additions (`tokens create`, `delegations create`) are not used here.
- `agentic-design` dev and peer dependency is `^0.5.0`. Version 0.5.0 changes token values only (colors, sizes, radii, shadows). Token names and the `agd-` prefix do not change. This package reads only `--agd-color-*` tokens.

## 0.6.0

Changed

- BREAKING: design class prefix is now agd-. The panel and demo page read the `--agd-color-*` tokens from `agentic-design` 0.4.0. The old prefix matches EasyList cosmetic rules, so ad blockers hid design-styled controls. Migration: set the `--agd-color-*` tokens in place of the old names, and load `agentic-design/tokens.css` from `agentic-design` ^0.4.0.
- `agentic-design` peer dependency and dev dependency raised to `^0.4.0`.

## 0.5.2 - 2026-10-29

No breaking changes. This is a patch release.

Changed

- The demo page sets `color-scheme: light dark`, so its system-color fallbacks follow the user's dark mode.
- A test fails if a hard-coded hex color returns to the demo page style. This does not change the package.
- An end-to-end test covers `mcp` with no model key, and the README documents that behavior. This does not change the package.

Security

- An npm `overrides` entry sets `zod` to `^4.6.7`, for GHSA-mrhx-c7xc-m3w5 (memory exhaustion while validating oversized constrained collections, fixed in 4.6.6 and later). The entry applies only to this repo. An install of `agentic-assistant` gets the zod that each dependency allows. The optional peer `agentic-design` 0.3.x can bring zod 3 into your project, so run `npm audit` after you upgrade.

## 0.5.1

Changed

- The demo page reads its colors from agentic-design tokens, with system-color fallbacks. It has no hard-coded hex colors.
- `agentic-assistant mcp` without `--tools` exits 2 and names `mcp` and `--tools` in its message.

## 0.5.0

Added

- `routeScopes` option on `createAssistantApi` and `createWorker`: a scope that a caller must hold for `tools`, `chat`, or `approvals`. The default is no extra scope, so the public API does not change.
- CLI commands `tools`, `approvals`, `approve <id> --digest <d>`, and `deny <id>`. They call a running assistant API with `--api <url>` and `--api-token-env <NAME>`.
- With those flags, `agentic-assistant mcp` also serves `assistant_tools`, `assistant_approvals`, and `assistant_deny`. `--allow-approve` adds `assistant_approve`.

Changed

- `createStaticTokenAuth` now builds a `createStoreAuth` over a memory Store. The local `Authorization` header parser is gone, so `agentic-identity` reads the credential. A token now also signs in as a `session` cookie, and a write by cookie needs an origin in `origins`. A token map may not use one `id` twice.
- The demo Worker needs the scope `demo:read` on every `/api/v1` route. A token without it gets a 403. Migration: add `demo:read` to each scope list in `ASSISTANT_TOKENS`.
- `react.css` has no hex colors. Its `--aa-*` variables read the color tokens of `agentic-design` 0.3, so the panel follows the host theme, including dark mode. Load `agentic-design/tokens.css` on the page. Without it each variable falls back to a system color, and the panel loses its blue accent, tinted cards, amber approval box, and red danger color (the risk notice shows in link blue). The palette shifts a little (for example the accent is now `#2B4BC4`). `agentic-design` is an optional peer dependency (`^0.3.1`).
- The OpenAI-compatible provider skips a chunk or tool-call part that is not an object, so a JSON `null` no longer throws. It gives a tool-call part with no `index` its own call when it has an `id`, and continues the last call when it has none. It cancels the body of a failed response.
- The MCP tool source has unit tests.

Migration from 0.4.0 (breaking: the auth path changed)

- Static tokens are read by `agentic-identity` now. A bad or odd credential is still a 401. A scope must match `<resource>:<action>` and hold at most 64 characters. A longer scope fails the sign-in.
- If you use the demo Worker, add `demo:read` to the scope list of each `ASSISTANT_TOKENS` entry. Without it every `/api/v1` route answers 403.
- If you use `createStaticTokenAuth`, give each token its own `id`. A map that uses one `id` twice throws when it is built. The `id` is the principal id, and it owns the pending approvals. When you rotate a key, remove the old token. Do not keep both under one `id`.
- A token now also signs in as the `session` cookie. A write made with the cookie needs its `Origin` in the `origins` option, or it is a 403. Add the origins of your web app before you ship.
- If you use the React panel, load `agentic-design/tokens.css` as described in the `react.css` entry above. Without it the panel loses its colors.
- Your own Worker needs no change for the route scopes. `routeScopes` is new in 0.5.0 and is optional. If you pass it to `createWorker`, give each caller the scope of every route group it calls.

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
