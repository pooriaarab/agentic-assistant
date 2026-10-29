# Changelog

## 0.2.0

Added

- AI transparency. Each tool result and each finished run carries a `provenance` record: `generator: "ai"`, model, provider, time, assistant id, the person it acts for, the tool and its risk, and the approver with a `kind`.
- `createProvenance`, `provenanceMarker` (JSON-LD with the IPTC `trainedAlgorithmicMedia` source type) and `provenanceLabel`.
- The record is in SDK events, the HTTP chat stream, `--json` output of the CLI, and `assistant_chat` results of the MCP server. The MCP result also holds `label` and `marker`. The CLI prints the label after a run.
- Approval decisions may carry `approverKind` (`human`, `agent`, or `host`). A decision without it is recorded as `unknown`.

Changed

- A provider that gives an empty model or provider name now ends the run with `provider_error` before any tool runs.

## 0.1.0

First release.
