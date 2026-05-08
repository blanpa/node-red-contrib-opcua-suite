# Phase 1: Pre-Work — Context

**Gathered:** 2026-05-08
**Status:** Ready for planning
**Mode:** auto (Claude selected recommended defaults — review before executing)

## Phase Boundary

Refactor the existing eight Client/Server nodes so the upcoming PubSub work does not clone known-bad patterns. Three concrete deliverables, locked by `01-SPEC.md`:

- DEBT-01 — Reconnect logic consolidated into `OpcUaClientManager.reconnect()`
- DEBT-02 — Cert handling extracted into `lib/cert-store.js` with `registerCertRoutes(RED, prefix, certsDir)` factory
- DEBT-03 — `msg.*` schema documented in `docs/MSG-SCHEMA.md`

Zero user-observable behaviour change. No new runtime deps. Existing Mocha suite must pass.

## Implementation Decisions

### DEBT-01 — Reconnect API shape

- **D-01:** `OpcUaClientManager.reconnect(opts = {})` is the single public reconnect entry point. `opts` shape:
  ```js
  {
    maxAttempts,    // default: this._reconnectMaxAttempts (0 = infinite)
    initialDelay,   // default: 2000 ms
    maxDelay,       // default: 30000 ms
    signal,         // optional AbortSignal for clean cancellation on node close
    reason          // optional string for logging ('connection-lost', 'session-invalid', ...)
  }
  ```
- **D-02:** Single-flight via a private `_reconnectPromise` field. First call creates the promise; concurrent calls return the same promise. The promise nulls the field in `.finally()` so a fresh attempt is allowed afterwards.
- **D-03:** Existing `nodes/opcua-client.js::forceReconnect` reduces to:
  ```js
  function forceReconnect(reason) {
    return clientManager.reconnect({ reason }).catch(err => {
      if (verboseLog) node.warn('reconnect failed: ' + err.message);
    });
  }
  ```
  No own retry loop; no direct mutation of `clientManager.isConnected` / `clientManager.reconnectAttempts` / `clientManager.reconnectPromise`.
- **D-04:** `isConnectionLostError` moves from `nodes/opcua-client.js` to `lib/opcua-client-manager.js` as a private method `_isConnectionLostError(err)` and is invoked inside `reconnect()` to decide whether the trigger error is reconnect-eligible.
- **D-05:** Other consumer nodes (`opcua-event`, `opcua-method`, `opcua-browser`, `opcua-browse-client`) gain a small `try { ... } catch { if (manager._isConnectionLostError(e)) await manager.reconnect(...); }` pattern in their input handlers. Keep it minimal — full retry logic stays in the manager.

### DEBT-02 — `lib/cert-store.js` API shape

- **D-06:** Module exports:
  ```js
  module.exports = {
    sanitiseFilename,                 // (string) → string
    getCertsDir,                      // (RED) → string  (idempotent mkdir)
    listCerts,                        // (certsDir) → Promise<string[]>
    uploadCert,                       // (certsDir, filename, base64Content) → Promise<{path, bytes}>
    deleteCert,                       // (certsDir, filename) → Promise<void>
    registerCertRoutes,               // (RED, prefix, certsDir) → void
  };
  ```
- **D-07:** Filename sanitisation regex stays identical: `replace(/[^a-zA-Z0-9._\-]/g, '_')`. Extension whitelist stays `/\.(pem|der|crt|key|pfx|p12)$/i` — applied in `listCerts` only (uploads accept any extension since users may legitimately need other formats).
- **D-08:** `registerCertRoutes` sets up three routes against `RED.httpAdmin`:
  ```
  POST   <prefix>/upload-cert        body: { filename, content (base64) }
  GET    <prefix>/certs              → ['cert1.pem', 'cert2.pem', ...]
  DELETE <prefix>/upload-cert/:name  (URL-encoded filename)
  ```
- **D-09:** Error response shape `{ error: <string> }` with status codes:
  - 400 — missing fields, invalid filename
  - 404 — file not found (delete only)
  - 500 — filesystem error
  Body is JSON in all error paths.
- **D-10:** `nodes/opcua-endpoint.js` replaces its inline route block with a single `registerCertRoutes(RED, '/opcua-endpoint', getCertsDir(RED))` call.
- **D-11:** `nodes/opcua-endpoint.html` exposes a single `const CERT_ROUTE_PREFIX = '/opcua-endpoint';` near the top of the editor script. All `fetch()` URLs in the drag-drop handlers are built as ``${CERT_ROUTE_PREFIX}/upload-cert`` etc. — no new helper module on the editor side; just one variable so the future PubSub config node can set its own.

### DEBT-03 — `docs/MSG-SCHEMA.md` structure

- **D-12:** One Markdown table **per node** (8 sections: opcua-endpoint config, opcua-client, opcua-server, opcua-item, opcua-event, opcua-method, opcua-browser, opcua-browse-client). Columns: `Field | Direction (in/out/both) | Type | Required | Description | Source`. `Source` is `nodes/<file>:<line>` for the canonical read/write site.
- **D-13:** A trailing **"Reserved for v0.1.0 (PubSub)"** section lists the seven future fields explicitly:
  ```
  msg.dataSet              (out) Object        — Subscriber: decoded DataSetMessage field map
  msg.publisherId          (in/out) String|UInt — Pub: target / Sub: source
  msg.writerGroupId        (in/out) UInt16     — WriterGroup identifier
  msg.dataSetWriterId      (in/out) UInt16     — DataSetWriter identifier
  msg.sequenceNumber       (out) UInt32        — Subscriber: per-DataSetReader sequence
  msg.encoding             (out) String        — 'uadp' | 'json'
  msg.transport            (out) String        — 'udp' | 'mqtt' | 'amqp'
  ```
  These are reserved — no PubSub code in this phase.
- **D-14:** Document includes a top-level **"v1.0 Stability Statement"** stating the listed fields are the v1.0 contract; field renames in v0.x are still possible but called out in CHANGELOG.
- **D-15:** README.md gets a single line under "Documentation" or near the top of "Nodes": `See [docs/MSG-SCHEMA.md](docs/MSG-SCHEMA.md) for the full message field reference.` No further README changes in this phase.

### Testing strategy

- **D-16:** New unit test `test/opcua-client-manager-reconnect.test.js`: asserts (a) `reconnect()` is single-flight (two concurrent calls share the same promise), (b) reconnect respects `maxAttempts` option, (c) `_isConnectionLostError` returns true for known message strings.
- **D-17:** New unit test `test/cert-store.test.js`: stubs `RED.httpAdmin` with `sinon.stub` (matching the existing `test/nodes-registration.test.js` pattern), calls `registerCertRoutes(stubRED, '/test-prefix', tmpDir)`, asserts three handlers registered. Calls each handler with mock req/res, asserts file written / listed / deleted using a real `os.tmpdir()/cert-store-test` directory cleaned via `afterEach`.
- **D-18:** New integration test `test/multi-consumer-reconnect.test.js`: spawns the local `test-server`, attaches one `opcua-client` and one `opcua-event` to the same endpoint, forces a session drop (kills/restarts the test server), asserts both nodes recover within 10s without manual restart. Skip via `if (!process.env.LIVE_TESTS)` to keep CI green when test-server isn't available.
- **D-19:** No regression in `test/integration-session-retry.test.js` or `test/opcua-client-retry.test.js` — both must continue to pass unchanged.

### Claude's Discretion

- Exact JSDoc wording for `reconnect()` and `cert-store.js` exports
- Whether to use async/await or `.then()` chains (match surrounding style of each file)
- Whether `_isConnectionLostError` becomes static or instance method (instance is fine; `static` only if no instance state needed — currently none)
- Internal organization of `cert-store.js` (single file vs split into `cert-store/index.js` + helpers — single file is simpler, prefer it)

## Specific Ideas

- Reconnect promise pattern mirrors what `lib/opcua-client-manager.js:243-259` already does for `scheduleReconnect()` — extend that, don't invent a new mechanism
- Cert-route prefix as a single editor-side constant matches the way Node-RED's own admin API URLs are typically composed (e.g. `/${node.type}/<endpoint>`); kept explicit as a const for clarity
- MSG-SCHEMA.md per-node tables match the structure README.md already uses for the eight nodes — same mental model, just deeper

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope
- `.planning/phases/01-pre-work/01-SPEC.md` — locked requirements, boundaries, acceptance criteria

### Existing code being refactored
- `lib/opcua-client-manager.js` (913 lines) — target of DEBT-01 reconnect consolidation
- `lib/opcua-client-manager.js:118-122` — current `connectionStrategy` config
- `lib/opcua-client-manager.js:154-204` — current connect/disconnect lifecycle
- `lib/opcua-client-manager.js:243-259` — current `scheduleReconnect()` to extend
- `lib/opcua-client-manager.js:393-406` — `_ensureConnected` health check
- `nodes/opcua-client.js:155-210` — `forceReconnect` / `_doForceReconnect` / `isConnectionLostError` to be moved
- `nodes/opcua-endpoint.js:14-62` — cert dir + HTTP routes to extract
- `nodes/opcua-endpoint.html` — drag-drop editor JS to parameterise

### Project context
- `.planning/PROJECT.md` — Core Value, Constraints (zero breaking changes), Key Decisions
- `.planning/REQUIREMENTS.md` — DEBT-01..03 v1 requirements
- `.planning/codebase/CONCERNS.md` §"Reconnect logic is split between two layers" — origin of DEBT-01
- `.planning/codebase/CONCERNS.md` §"Cert dropzone duplication" — origin of DEBT-02
- `.planning/codebase/CONVENTIONS.md` — code style, error handling patterns to mirror
- `.planning/codebase/TESTING.md` — Mocha + sinon patterns to follow
- `.planning/research/PITFALLS.md` §"CONCERNS.md has 8 explicitly PubSub-impacted items" — rationale for this phase

## Existing Code Insights

### Reusable Assets

- **`lib/opcua-utils.js::createError(message, error)`** — already used for error construction; reuse for any new error messages from `cert-store.js` HTTP routes.
- **`sinon` is already a dev dep (^17.0.1)** — `cert-store.test.js` should follow the existing stub pattern (`test/nodes-registration.test.js`, `test/opcua-client-retry.test.js`).
- **`test-server/server.js`** — existing local OPC UA server harness for integration tests. The new `multi-consumer-reconnect.test.js` should reuse it.

### Established Patterns

- **EventEmitter on managers** — `OpcUaClientManager` already extends `EventEmitter`; `reconnect()` should emit `reconnecting`, `reconnected`, `reconnect_failed` events consistent with the existing pattern (`connected`, `disconnected`, `error`, `backoff`).
- **`_withTimeout()` wrapping** — every node-opcua call is timeout-wrapped (`lib/opcua-client-manager.js`); the reconnect logic must NOT re-wrap calls that go through `_withTimeout` already.
- **Conditional `if (RED.httpAdmin)` route registration** — existing pattern in `nodes/opcua-endpoint.js:23` and `nodes/opcua-browse-client.js:174`. `registerCertRoutes` must follow the same conditional (skip-if-no-httpAdmin for unit-test environments).
- **Filename sanitisation regex** — verbatim copy from `nodes/opcua-endpoint.js:30,51`.

### Integration Points

- **`nodes/opcua-endpoint.js` module-level code** — currently registers HTTP routes on require(). Replacing with `registerCertRoutes` keeps the same lifecycle (one-time at module load).
- **`nodes/opcua-endpoint.html` editor script** — uses `RED.notify` for user feedback. Keep the same UX after refactor.
- **`OpcUaClientManager._ensureConnected`** — already detects `session.hasBeenClosed()` and `isReconnecting` (per recent v0.0.6 fix). The new `reconnect()` must integrate with this without breaking the v0.0.6 race-fix behaviour.

## Deferred Ideas

(Things that came up during context-gathering but are explicitly out of this phase.)

- **Promote `_toOpcUaNodeId` to public API** — flagged in CONCERNS.md but not in DEBT-01..03; defer to a future cleanup phase
- **Subscription handling consolidation** (CONCERNS.md tech-debt §3) — Phase 4 PubSub will compound this, but addressing it now expands Phase 1 scope beyond the user-locked DEBT-01..03; revisit during Phase 4 planning
- **Browse-cache LRU + per-endpoint cleanup hook** (CONCERNS.md §"Browse connection cache is module-scoped global state") — not PubSub-impacted; defer to v1.x cleanup
- **Silent `catch { /* ignore */ }` cleanup** (CONCERNS.md §"Pervasive silent catch") — broad scope; defer to dedicated phase
- **Sterfive node-opcua@2.163.1 vs declared `^2.115.0`** — version range mismatch noted in STACK.md; not PubSub-blocking; revisit when bumping minimum
- **Empty `locales/` directory + i18n** — out of scope; revisit when adding new strings (PubSub will, but Phase 4 deferral is fine)

---

*Phase: 01-pre-work*
*Context gathered: 2026-05-08*
*Mode: auto (review the 19 D-XX decisions before executing — they were selected by Claude as recommended defaults given the SPEC.md lock)*
