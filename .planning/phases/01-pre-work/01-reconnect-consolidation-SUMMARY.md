---
phase: 01-pre-work
plan: 01
subsystem: infra
tags: [opcua, reconnect, retry, single-flight, refactor, debt-01]

# Dependency graph
requires:
  - phase: 00-init
    provides: existing OpcUaClientManager with scheduleReconnect() / connect() / disconnect() lifecycle
provides:
  - Public OpcUaClientManager.reconnect(opts) — owns retry loop, exponential backoff, single-flight lock, AbortSignal cancellation, reconnecting/reconnected/reconnect_failed events
  - Public OpcUaClientManager._isConnectionLostError(err) — connection-lost classifier on seven known node-opcua message strings
  - Thin forceReconnect() wrapper in nodes/opcua-client.js delegating to manager
  - Reconnect-on-session-loss guard pattern in opcua-event, opcua-method, opcua-browser, opcua-browse-client (D-05)
  - Multi-consumer integration test (LIVE_TESTS-gated) proving two managers recover from simultaneous session drops
affects: [02-cert-store, 03-msg-schema, phase-2-pubsub-publisher, phase-3-pubsub-subscriber]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-flight via private _reconnectPromise field nulled in .finally()"
    - "AbortSignal-aware retry loop (Node 18+ AbortController)"
    - "Reconnect events: reconnecting / reconnected / reconnect_failed (matches existing connected/disconnected/error/backoff)"
    - "Consumer-node guard: try/catch + clientManager._isConnectionLostError(e) + clientManager.reconnect()"

key-files:
  created:
    - test/opcua-client-manager-reconnect.test.js
    - test/multi-consumer-reconnect.test.js
  modified:
    - lib/opcua-client-manager.js
    - nodes/opcua-client.js
    - nodes/opcua-event.js
    - nodes/opcua-method.js
    - nodes/opcua-browser.js
    - nodes/opcua-browse-client.js
    - test/opcua-client-retry.test.js

key-decisions:
  - "Input handler in opcua-client.js calls clientManager.reconnect() directly (not via the .catch-swallowing forceReconnect wrapper) so reconnect failures propagate to node.error — preserves existing retry-test contract"
  - "forceReconnect() retained per D-03 as migration-friendly wrapper with .catch warn — fire-and-forget callers keep working"
  - "Mock manager in test/opcua-client-retry.test.js gained _isConnectionLostError + reconnect stand-ins (mirroring the live API) so all 14 existing retry assertions pass without changes"
  - "Multi-consumer test uses reconnectDelay >= initialDelay (5000 vs default 1000) to satisfy node-opcua backoff strategy invariant"

patterns-established:
  - "DEBT consolidation: move retry logic into the manager; consumer nodes only classify and delegate"
  - "Sub-package failure-mode coverage: known error strings live in one classifier, owned by the manager"
  - "LIVE_TESTS env-gate for tests that boot a real OPCUAServer (avoids CI flakiness; D-18)"

requirements-completed: [DEBT-01]

# Metrics
duration: ~30min
completed: 2026-05-08
---

# Phase 1 Plan 1: Reconnect Consolidation Summary

**Public `OpcUaClientManager.reconnect(opts)` owns retry/backoff/single-flight; consumer nodes (opcua-client + four others) delegate via thin wrapper or D-05 guard pattern; 18 new manager tests + 1 LIVE-gated multi-consumer integration test added; zero regressions in 189 existing tests.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-05-08T10:55:30Z (approx)
- **Completed:** 2026-05-08T11:01:38Z
- **Tasks:** 3 (Task 1 split into RED + GREEN per TDD)
- **Files modified:** 7 (1 lib, 5 nodes, 1 test)
- **Files created:** 2 tests

## Accomplishments

- `OpcUaClientManager.reconnect(opts)` is the single public reconnect entry point with documented JSDoc, AbortSignal support, exponential backoff (`initialDelay * attempt`, capped at `maxDelay`), and event emissions (`reconnecting`, `reconnected`, `reconnect_failed`).
- Single-flight lock via `this._reconnectPromise`: two concurrent `reconnect()` calls share the exact same Promise instance; the field is nulled in `.finally()` so a fresh sequential call gets a new promise.
- `_isConnectionLostError(err)` migrated from `nodes/opcua-client.js` and exposed as an instance method on the manager, recognising seven known node-opcua message strings (`Session is no longer valid`, `Not connected`, plus five `includes` substrings) and rejecting unrelated errors.
- `nodes/opcua-client.js::forceReconnect` reduced to the locked D-03 one-liner; `_doForceReconnect`, `RECONNECT_BASE_DELAY_MS/MAX`, `reconnectPromise`, and the local `isConnectionLostError` function deleted; no direct mutations of `clientManager.isConnected` / `reconnectAttempts` / `reconnectPromise` remain in `nodes/`.
- Four consumer nodes (`opcua-event`, `opcua-method`, `opcua-browser`, `opcua-browse-client`) gained the D-05 guard pattern in their input handlers: when the caught error is a known connection-lost error, the manager's `reconnect({ reason: "session-lost" })` is called before the general error path so the next message gets a fresh session.
- 18 new unit assertions in `test/opcua-client-manager-reconnect.test.js` cover single-flight, sequential reset, three `maxAttempts` cases (1 / 3 / 0=infinite), three event sequences, AbortSignal cancellation, and 10 `_isConnectionLostError` cases.
- 1 LIVE-gated integration test in `test/multi-consumer-reconnect.test.js` proves two independent managers (simulating opcua-client + opcua-event) both recover from forced session drops within 10s, with a post-recovery read returning the expected value. Verified manually with `LIVE_TESTS=1` (~480ms).
- `npm test` reports `207 passing, 1 pending` (189 baseline + 18 new manager tests; 1 LIVE-gated test is correctly pending without the env var).

## Task Commits

Each task committed atomically:

1. **Task 1 RED: Failing tests for reconnect / _isConnectionLostError** — `dc521c5` (test)
2. **Task 1 GREEN: Add reconnect() and _isConnectionLostError() to OpcUaClientManager** — `cd7fdd9` (feat)
3. **Task 2: Reduce forceReconnect; add reconnect guard to four consumer nodes** — `1b77bac` (refactor)
4. **Task 3: Multi-consumer reconnect integration test** — `eb0036c` (test)

_Note: Task 1 followed the TDD cycle (test commit, then feat commit). Task 2 also touched `test/opcua-client-retry.test.js` mocks (not assertions) so the existing 14-test retry suite continues to pass._

## Files Created/Modified

- `lib/opcua-client-manager.js` — Added module-level `RECONNECT_BASE_DELAY_MS / RECONNECT_MAX_DELAY_MS` constants, constructor field `this._reconnectPromise = null`, instance method `_isConnectionLostError(err)`, and public method `reconnect(opts = {})` with full retry loop + AbortSignal handling.
- `nodes/opcua-client.js` — Deleted `_doForceReconnect`, `isConnectionLostError`, `RECONNECT_*` constants, and `reconnectPromise` local var. Reduced `forceReconnect` to the D-03 one-liner. Input handler retry path now calls `clientManager.reconnect({ reason: "session-lost", maxAttempts: retryAttempts })` directly so failures propagate. `ensureConnected()` no longer writes `clientManager.reconnectAttempts`.
- `nodes/opcua-event.js`, `nodes/opcua-method.js`, `nodes/opcua-browser.js`, `nodes/opcua-browse-client.js` — Added D-05 `try { reconnect } catch {}` guard before `node.error(...)` in the input handler's catch block.
- `test/opcua-client-retry.test.js` — Mock manager gained `_isConnectionLostError` (verbatim copy of the classifier) and `reconnect` (delegates to `mgr.connect()`); no assertions changed.
- `test/opcua-client-manager-reconnect.test.js` — New file. 18 assertions across three describe blocks (single-flight, maxAttempts, _isConnectionLostError).
- `test/multi-consumer-reconnect.test.js` — New file. LIVE_TESTS-gated end-to-end recovery test on a real OPCUAServer at port 49400-49500.

## Decisions Made

- **Input-handler bypass of forceReconnect wrapper.** The locked D-03 wrapper has `.catch(err => ... warn)` to make it safe for fire-and-forget callers. But the existing test `should fail after retry if reconnect also fails` asserts that reconnect failure surfaces via `node.error("Operation error: Connection refused")`. To satisfy both contracts, the input handler calls `clientManager.reconnect()` directly (so the error propagates), and the `forceReconnect` wrapper is retained for any external migration callers.
- **Mock manager parity.** Updating `test/opcua-client-retry.test.js`'s mock manager to include `_isConnectionLostError` and `reconnect` is a Rule 3 fix — the mock pretends to be `OpcUaClientManager`, so it must reflect the new interface. No test assertions changed.
- **`reconnectDelay` floor in multi-consumer test.** The existing `connectionStrategy` in `lib/opcua-client-manager.js:118-122` passes `reconnectDelay` straight through to node-opcua's backoff strategy, which requires `maxDelay > initialDelay`. Set the test's `reconnectDelay` to 5000 (above node-opcua's hard-coded `initialDelay: 1000`) to avoid `BackoffStrategy` constructor errors. Pre-existing constraint, not introduced by this plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Mock manager missing new public API**
- **Found during:** Task 2 (refactor opcua-client.js)
- **Issue:** `test/opcua-client-retry.test.js` defines a plain-object mock manager that the test file expected to behave like `OpcUaClientManager`. After moving `_isConnectionLostError` and `reconnect()` onto the live class, the mock had neither, causing 12 of the 14 retry tests to fail (the input handler's guard `clientManager._isConnectionLostError && ...` short-circuited because the property was undefined, so reconnect was never attempted).
- **Fix:** Added `_isConnectionLostError` (verbatim copy of the live classifier) and `reconnect` (delegates to `mgr.connect()` and resets `mgr.reconnectAttempts`) to the mock manager in `beforeEach`. No test assertions changed.
- **Files modified:** `test/opcua-client-retry.test.js`
- **Verification:** All 14 existing retry tests pass; full suite at 207 passing, 1 pending.
- **Committed in:** `1b77bac` (Task 2 commit)

**2. [Rule 3 - Blocking] Input handler retry path swallowed reconnect failure**
- **Found during:** Task 2 (refactor opcua-client.js)
- **Issue:** The locked D-03 `forceReconnect` wrapper has `.catch(err => warn)`, which is correct for fire-and-forget callers but wrong for the input handler's `await forceReconnect(); await executeOperation(...)` flow — when reconnect fails, `executeOperation` would still run (and crash on undefined mock state), masking the real `Connection refused` error from `node.error`.
- **Fix:** In the input handler, call `clientManager.reconnect({ reason: "session-lost", maxAttempts: retryAttempts })` directly so the error propagates to the outer try/catch. The `forceReconnect` wrapper is retained for migration-friendliness per D-03.
- **Files modified:** `nodes/opcua-client.js`
- **Verification:** Test `should fail after retry if reconnect also fails` passes with `node.error.firstCall.args[0]` containing `"Connection refused"`.
- **Committed in:** `1b77bac` (Task 2 commit)

**3. [Rule 1 - Bug] Multi-consumer test failed with `maxDelay > initialDelay` invariant**
- **Found during:** Task 3 (verifying live test with `LIVE_TESTS=1`)
- **Issue:** Initial test config used `reconnectDelay: 500`, which is forwarded to node-opcua's `connectionStrategy.maxDelay`. node-opcua's `BackoffStrategy` constructor throws `The maximal backoff delay must be greater than the initial backoff delay` because the hard-coded `initialDelay: 1000` is larger.
- **Fix:** Raised `reconnectDelay` to 5000 in the test setup. Pre-existing constraint in `lib/opcua-client-manager.js:118-122`, not introduced by this plan.
- **Files modified:** `test/multi-consumer-reconnect.test.js`
- **Verification:** Live test passes in ~480ms with `LIVE_TESTS=1`.
- **Committed in:** `eb0036c` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 bug)
**Impact on plan:** All three were necessary to keep the existing test contract green and to make the new live test runnable. None expanded scope. The locked D-01..D-05 / D-18 decisions remain intact: the manager owns retry, the wrapper stays one-line, consumer nodes use the D-05 guard, and the live test is LIVE_TESTS-gated.

## Issues Encountered

- The integration with node-opcua's hard-coded `connectionStrategy.initialDelay: 1000` (in `lib/opcua-client-manager.js:118-122`) is fragile — passing a smaller `reconnectDelay` causes a runtime error inside node-opcua. Not in scope to fix here, but worth flagging for Phase 2/3 PubSub work where transports may want different backoff defaults. Already noted in CONCERNS.md / PITFALLS.md.

## Next Phase Readiness

- DEBT-01 acceptance criteria met: zero direct mutations in `nodes/`, `forceReconnect()` is one-liner, `OpcUaClientManager.reconnect()` documented + tested for single-flight, multi-consumer integration test exists.
- DEBT-02 (cert-store extraction) and DEBT-03 (MSG-SCHEMA.md) remain — both wave-1 plans run in parallel with this one.
- The new public `manager.reconnect()` API is the foundation the future PubSub subscriber will build on (Phase 3) — no need to clone the retry loop in PubSub code.

## Self-Check: PASSED

Verified each commit hash exists in `git log --oneline`:
- `dc521c5` test(01-01): add failing tests — FOUND
- `cd7fdd9` feat(01-01): add reconnect / _isConnectionLostError — FOUND
- `1b77bac` refactor(01-01): delegate forceReconnect, D-05 guard — FOUND
- `eb0036c` test(01-01): multi-consumer integration — FOUND

Verified each file claimed in this summary exists on disk:
- `lib/opcua-client-manager.js` — FOUND (modified)
- `nodes/opcua-client.js` — FOUND (modified)
- `nodes/opcua-event.js` — FOUND (modified)
- `nodes/opcua-method.js` — FOUND (modified)
- `nodes/opcua-browser.js` — FOUND (modified)
- `nodes/opcua-browse-client.js` — FOUND (modified)
- `test/opcua-client-retry.test.js` — FOUND (modified)
- `test/opcua-client-manager-reconnect.test.js` — FOUND (created)
- `test/multi-consumer-reconnect.test.js` — FOUND (created)

Verified npm test passes: 207 passing, 1 pending.

---
*Phase: 01-pre-work*
*Plan: 01 (reconnect consolidation)*
*Completed: 2026-05-08*
