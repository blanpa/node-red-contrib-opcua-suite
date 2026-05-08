# Phase 1: Pre-Work — Specification

**Created:** 2026-05-08
**Ambiguity score:** 0.17 (gate: ≤ 0.20)
**Requirements:** 3 locked

## Goal

The codebase is ready for additive PubSub work — reconnect logic is owned by `OpcUaClientManager`, certificate handling is reusable as a standalone module, and the existing eight nodes' `msg.*` schema is documented in one place — without changing any user-observable behaviour of the v0.0.7 nodes.

## Background

Three `[PubSub-impacted]` items in `.planning/codebase/CONCERNS.md` would, if ignored, force the upcoming PubSub Subscriber to clone the existing reconnect retry loop, force the new `opcua-pubsub-connection` config node to copy-paste the cert HTTP routes from `nodes/opcua-endpoint.js`, and let new `msg.*` field names collide silently with the eight existing nodes. The PITFALLS research recommends resolving them first (Option A) and the user has confirmed this path. Today:

- `nodes/opcua-client.js:167–210` mutates `clientManager.isConnected` and `clientManager.reconnectAttempts` from outside the manager and runs its own `forceReconnect()` retry loop in parallel with `OpcUaClientManager.scheduleReconnect()` (`lib/opcua-client-manager.js:243–259`). Other consumer nodes (`opcua-event`, `opcua-method`, `opcua-browser`, `opcua-browse-client`) inherit none of this and fail on first session loss.
- `nodes/opcua-endpoint.js:23–62` registers `POST/GET/DELETE /opcua-endpoint/upload-cert(s)` inline in the module body. `nodes/opcua-endpoint.html` ships ~120 lines of drag-drop JS that call those routes. Both pieces are tightly bound to the `'opcua-endpoint'` URL prefix and cannot be reused by another config node without copy-paste.
- The eight nodes use `msg.payload`, `msg.topic`, `msg.statusCode`, `msg.sourceTimestamp`, `msg.serverTimestamp`, `msg.nodeId`, `msg.operation`, `msg.error`, `msg.items`, `msg.datatype`, `msg.dataTypeNodeId`, `msg.recursiveResult`, `msg.command`, plus several others scattered across handler functions. There is no single document a contributor can consult before adding a new field.

## Requirements

1. **DEBT-01 — Reconnect logic consolidated into `OpcUaClientManager`**: All reconnect state and retry loop logic lives inside the manager; consumer nodes do not mutate manager internals.
   - Current: `forceReconnect()` / `_doForceReconnect()` / `isConnectionLostError()` exist in `nodes/opcua-client.js:155–210`; this code reads and writes `clientManager.isConnected`, `clientManager.reconnectAttempts`, and `clientManager.reconnectPromise` directly. Other consumer nodes do not have any retry handling.
   - Target: `OpcUaClientManager.reconnect(opts)` is a public method that owns the retry loop, exponential backoff (2s–30s), single-flight lock (`reconnectPromise`), and `isConnectionLostError()` classification. Existing `forceReconnect()` in `nodes/opcua-client.js` is kept as a thin **delegating wrapper** that calls `this.clientManager.reconnect()` — no own retry loop, no direct mutation of manager fields. Other consumer nodes (`opcua-event`, `opcua-method`, `opcua-browser`, `opcua-browse-client`) gain the same retry semantics by virtue of catching session-loss errors and calling `clientManager.reconnect()`.
   - Acceptance: a `grep -nE "clientManager\.(isConnected|reconnectAttempts|reconnectPromise)\s*=" nodes/` returns zero hits; `nodes/opcua-client.js::forceReconnect` body is a single `return this.clientManager.reconnect(...)` line plus optional verbose logging; new unit test asserts `clientManager.reconnect()` returns the same promise when called concurrently (single-flight); a multi-consumer integration test (one `opcua-client` plus one `opcua-event` against the same endpoint) survives a forced session drop without the event node failing permanently.

2. **DEBT-02 — Pure-function cert helper module + Express-routes factory**: certificate management is a standalone library module that any config node can register HTTP routes for under any prefix.
   - Current: `nodes/opcua-endpoint.js:23–62` contains the cert directory creation, filename sanitisation, and `RED.httpAdmin.post/get/delete` registration inline; `nodes/opcua-endpoint.html` JS calls `/opcua-endpoint/upload-cert(s)` URLs hard-coded.
   - Target: a new `lib/cert-store.js` module exports pure functions `{ uploadCert, listCerts, deleteCert, sanitiseFilename, getCertsDir }` (no side effects beyond filesystem operations on the passed path) and a route factory `registerCertRoutes(RED, prefix, certsDir)` that registers the three HTTP-admin endpoints under the given prefix (e.g. `/opcua-endpoint/upload-cert`, `/opcua-pubsub-connection/upload-cert`). `nodes/opcua-endpoint.js` is refactored to call `registerCertRoutes(RED, '/opcua-endpoint', getCertsDir(RED))` exactly once at module load. `nodes/opcua-endpoint.html` JS gains a small helper that builds the URL from the config-node-type prefix so it can be reused by the future PubSub config node's editor side.
   - Acceptance: `lib/cert-store.js` exists and is required from `nodes/opcua-endpoint.js`; calling `registerCertRoutes(mockRED, '/test-prefix', tmpDir)` in a unit test successfully registers three routes against a mock `RED.httpAdmin` and a subsequent simulated POST to `/test-prefix/upload-cert` writes a file into `tmpDir`; existing `test/` suite passes (no regression in cert upload behaviour); editor-side cert dropzone in `opcua-endpoint.html` builds its URL from a single prefix variable and continues to work in a manual smoke test.

3. **DEBT-03 — `msg.*` schema documented and frozen as v1.0 contract**: a single `docs/MSG-SCHEMA.md` lists every `msg.*` field the existing eight nodes accept or emit, with type and source.
   - Current: no central documentation of `msg.*` fields exists. README has scattered references but is not authoritative.
   - Target: `docs/MSG-SCHEMA.md` exists at repo root containing one table per node (or per logical operation group) listing field name, JS type, direction (in / out), required / optional, description, and source file:line where it is read or written. The document includes a **"v1.0 Stable Fields"** section that explicitly lists every field the existing eight nodes use today; an upcoming **"Added in v0.1.0 (PubSub)"** section is reserved (empty in this phase) for: `msg.dataSet`, `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber`, `msg.encoding`, `msg.transport`. `README.md` gains a single "Message schema" line that links to `docs/MSG-SCHEMA.md`. No code changes; this requirement is documentation-only.
   - Acceptance: `docs/MSG-SCHEMA.md` exists; every `msg.<field>` reference found via `grep -rnE "msg\.[a-zA-Z_]+" nodes/ lib/` (excluding obvious local variables and `msg.error`-like forwarding) appears at least once in the document's tables; the document is referenced from `README.md`; the document explicitly states "Added in v0.1.0 (PubSub):" with the seven reserved field names.

## Boundaries

**In scope:**

- Refactor `OpcUaClientManager` to expose a public `reconnect()` method owning the retry loop and single-flight lock
- Reduce `nodes/opcua-client.js::forceReconnect()` to a delegating wrapper
- Make `clientManager.reconnect()` work when called from any consumer node (not only `opcua-client`)
- Extract cert filesystem + HTTP-route logic from `nodes/opcua-endpoint.js` into `lib/cert-store.js`
- Refactor `nodes/opcua-endpoint.js` and `nodes/opcua-endpoint.html` to consume the new helper without behavior change
- Author `docs/MSG-SCHEMA.md` with one table per node-or-operation-group covering existing `msg.*` fields
- Add a README link to the new schema doc
- Add unit tests proving single-flight reconnect, route factory parameterisation, and multi-consumer reconnect behaviour
- Run the existing Mocha suite to prove zero regression

**Out of scope:**

- Any PubSub code (encoders, transports, config nodes, worker nodes) — that starts in Phase 2
- Other CONCERNS.md tech-debt items (subscription handling consolidation, browse-cache LRU, silent-catch cleanup, etc.) — they are not `[PubSub-impacted]` and stay deferred
- Behavioural changes to the existing eight nodes — refactor must be observably identical from a flow author's perspective
- Changes to `nodes/opcua-server.js` — no PubSub-impacted concern there
- Promotion of `_toOpcUaNodeId` to public API — separate refactor (mentioned in CONCERNS.md but not in DEBT-01..03 scope)
- Rewriting subscription/`monitorItem` duplication — Phase 4 PubSub may reference but this phase does not address it
- Removing `forceReconnect()` entirely — explicit user decision: keep as delegating wrapper for migration-friendliness; deletion is a future cleanup
- Deprecation warnings or `console.warn()` on legacy entry points — explicit user decision against
- Any build-step additions (typedoc, jsdoc-md, etc.) — schema doc is hand-authored Markdown
- Adding cert encryption or key rotation — `cert-store.js` only moves existing functionality

## Constraints

- **Backward compatibility (hard)**: zero user-observable behaviour change for any of the eight existing nodes. Existing flows must continue to work without modification. PROJECT.md constraint.
- **Test guard (hard)**: the full `npm test` Mocha suite must pass after every commit in this phase, including the existing reconnect tests in `test/integration-session-retry.test.js` and `test/opcua-client-retry.test.js`.
- **API surface (soft)**: `OpcUaClientManager.reconnect()` is a NEW public method. Existing internal helpers (`scheduleReconnect`, `_ensureConnected`, etc.) may stay private. The manager's existing public API is not removed or renamed.
- **No new runtime deps**: refactor only — no `package.json` changes in this phase.
- **File location convention**: new helper goes in `lib/` (existing convention for shared modules). New schema doc goes in `docs/` at repo root (new directory, but consistent with industry practice for OSS Node-RED contribs).

## Acceptance Criteria

- [ ] `grep -nE "clientManager\.(isConnected|reconnectAttempts|reconnectPromise)\s*=" nodes/` returns zero matches.
- [ ] `OpcUaClientManager.reconnect()` exists, is documented with a JSDoc comment, and returns the same `Promise` instance when called multiple times concurrently (single-flight test asserts this).
- [ ] `nodes/opcua-client.js::forceReconnect()` body is a one-liner that delegates to `clientManager.reconnect()` (and optional verbose-log call).
- [ ] A new integration test pairs `opcua-client` and `opcua-event` against the same endpoint and asserts both nodes recover from a forced session drop without manual restart.
- [ ] `lib/cert-store.js` exists and exports `{ uploadCert, listCerts, deleteCert, sanitiseFilename, getCertsDir, registerCertRoutes }`.
- [ ] `nodes/opcua-endpoint.js` no longer contains inline cert HTTP-route registration; it calls `registerCertRoutes(RED, '/opcua-endpoint', getCertsDir(RED))` instead.
- [ ] `nodes/opcua-endpoint.html` builds upload URLs from a single configurable prefix variable.
- [ ] A unit test calls `registerCertRoutes(mockRED, '/test-prefix', tmpDir)` and asserts three routes register against a mock `RED.httpAdmin`.
- [ ] `docs/MSG-SCHEMA.md` exists; every distinct `msg.<field>` reference grep-found in `nodes/*.js` and `lib/*.js` appears in its tables (manual cross-check, documented in PR).
- [ ] `docs/MSG-SCHEMA.md` contains an explicit "v1.0 Stable Fields" section AND an "Added in v0.1.0 (PubSub)" section listing seven reserved field names: `msg.dataSet`, `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber`, `msg.encoding`, `msg.transport`.
- [ ] `README.md` contains a link to `docs/MSG-SCHEMA.md`.
- [ ] `npm test` passes (full Mocha suite, including existing reconnect and integration tests).
- [ ] No diffs in `package.json` `dependencies` (refactor only, no new runtime deps).

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                                       |
|--------------------|-------|------|--------|-------------------------------------------------------------|
| Goal Clarity       | 0.85  | 0.75 | ✓      | Three concrete deliverables with file:line current-state    |
| Boundary Clarity   | 0.85  | 0.70 | ✓      | Long explicit out-of-scope list incl. user-locked decisions |
| Constraint Clarity | 0.80  | 0.65 | ✓      | Zero-breaking-change + test-guard explicit                  |
| Acceptance Criteria| 0.82  | 0.70 | ✓      | 12 falsifiable pass/fail checks (grep / file existence / test pass) |
| **Ambiguity**      | 0.17  | ≤0.20| ✓      |                                                             |

## Interview Log

| Round | Perspective    | Question summary                                          | Decision locked                                       |
|-------|----------------|-----------------------------------------------------------|-------------------------------------------------------|
| 0     | Researcher     | (skipped — codebase mapped earlier in same session, CONCERNS.md provides current-state file:lines) | Initial scoring: ambiguity 0.27, AC below min |
| 1     | Boundary Keeper| DEBT-01: delete `forceReconnect()`, wrap, or deprecate?   | Keep as delegating wrapper (no own loop, no mutations) |
| 1     | Boundary Keeper| DEBT-02: function module + factory, class, or mixin?      | Pure-function module + `registerCertRoutes` factory   |
| 1     | Boundary Keeper| DEBT-03: where does the schema doc live?                  | `docs/MSG-SCHEMA.md` referenced from README           |

---

*Phase: 01-pre-work*
*Spec created: 2026-05-08*
*Next step: /gsd-discuss-phase 1 — implementation decisions (e.g. exact `OpcUaClientManager.reconnect()` API shape, cert-store.js function signatures, MSG-SCHEMA.md table structure)*
