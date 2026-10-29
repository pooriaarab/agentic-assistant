# Changelog

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
