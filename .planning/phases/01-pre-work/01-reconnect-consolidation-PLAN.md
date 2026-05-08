---
phase: 01-pre-work
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - lib/opcua-client-manager.js
  - nodes/opcua-client.js
  - nodes/opcua-event.js
  - nodes/opcua-method.js
  - nodes/opcua-browser.js
  - nodes/opcua-browse-client.js
  - test/opcua-client-manager-reconnect.test.js
  - test/multi-consumer-reconnect.test.js
autonomous: true
requirements:
  - DEBT-01

must_haves:
  truths:
    - "grep -nE 'clientManager\\.(isConnected|reconnectAttempts|reconnectPromise)\\s*=' nodes/ returns zero matches"
    - "OpcUaClientManager.reconnect() owns the retry loop; forceReconnect() in opcua-client.js delegates to it with one line"
    - "Two concurrent calls to clientManager.reconnect() return the same Promise instance (single-flight)"
    - "opcua-event, opcua-method, opcua-browser, and opcua-browse-client catch session-loss errors and call clientManager.reconnect() instead of failing permanently"
    - "Full Mocha suite passes (npm test) after all commits in this plan"
  artifacts:
    - path: "lib/opcua-client-manager.js"
      provides: "Public reconnect() method with single-flight lock, retry loop, exponential backoff, isConnectionLostError classifier, and reconnecting/reconnected/reconnect_failed event emissions"
      contains: "reconnect(opts"
    - path: "nodes/opcua-client.js"
      provides: "Delegating forceReconnect() wrapper"
      contains: "clientManager.reconnect("
    - path: "test/opcua-client-manager-reconnect.test.js"
      provides: "Unit tests: single-flight assertion, maxAttempts option, _isConnectionLostError known strings"
    - path: "test/multi-consumer-reconnect.test.js"
      provides: "Integration test: opcua-client + opcua-event both recover after forced session drop"
  key_links:
    - from: "nodes/opcua-client.js::forceReconnect"
      to: "lib/opcua-client-manager.js::reconnect"
      via: "clientManager.reconnect({ reason, ... })"
      pattern: "clientManager\\.reconnect\\("
    - from: "nodes/opcua-event.js input handler"
      to: "lib/opcua-client-manager.js::reconnect"
      via: "_isConnectionLostError guard + await manager.reconnect()"
      pattern: "_isConnectionLostError"
---

<objective>
Move the reconnect retry loop, single-flight lock, and connection-lost error classifier into OpcUaClientManager so every consumer node benefits from the same semantics.

Purpose: DEBT-01 — prevents the upcoming PubSub Subscriber from becoming a third copy of the retry loop; ensures opcua-event, opcua-method, opcua-browser, and opcua-browse-client survive session loss without manual restart.
Output: Updated lib/opcua-client-manager.js with a public reconnect() method; thinned nodes/opcua-client.js::forceReconnect(); minimal catch additions in four consumer nodes; two new test files.
</objective>

<execution_context>
@/home/la/private/node-red-contrib-opcua-suite/.planning/phases/01-pre-work/01-CONTEXT.md
</execution_context>

<context>
@/home/la/private/node-red-contrib-opcua-suite/.planning/PROJECT.md
@/home/la/private/node-red-contrib-opcua-suite/.planning/ROADMAP.md
@/home/la/private/node-red-contrib-opcua-suite/.planning/phases/01-pre-work/01-SPEC.md

<interfaces>
<!-- Key signatures the executor needs. Extracted from the source before editing. -->

From lib/opcua-client-manager.js (constructor fields — lines 44-57):
```js
class OpcUaClientManager extends EventEmitter {
  constructor(config) {
    super();
    this.isConnected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 10;
    this.reconnectDelay = config.reconnectDelay || 5000;
    // ...
  }
  scheduleReconnect()          // lines 243-259 — extend, do not duplicate
  async connect()              // lines 84-204
  async disconnect()           // lines 206-241
}
```

From nodes/opcua-client.js (lines 155-210 — code to be moved/replaced):
```js
function isConnectionLostError(error) { ... }   // move to manager as _isConnectionLostError
async function forceReconnect() { ... }          // reduce to one-liner delegating to clientManager.reconnect()
async function _doForceReconnect() { ... }       // delete (logic moves into manager.reconnect())
const RECONNECT_BASE_DELAY_MS = 2000;            // keep as constants in manager
const RECONNECT_MAX_DELAY_MS  = 30000;
let reconnectPromise = null;                     // becomes this._reconnectPromise in manager
```

Locked API shape (D-01):
```js
// New public method on OpcUaClientManager
async reconnect(opts = {}) {
  // opts: { maxAttempts, initialDelay, maxDelay, signal, reason }
  // default maxAttempts: this.maxReconnectAttempts (0 = infinite)
  // default initialDelay: 2000, maxDelay: 30000
}
```

Locked single-flight pattern (D-02):
```js
// Private field: this._reconnectPromise = null
// First call creates the promise; concurrent calls return the same promise.
// .finally() nulls the field so a fresh attempt is allowed afterwards.
```

Locked delegating wrapper (D-03):
```js
// nodes/opcua-client.js::forceReconnect becomes:
function forceReconnect(reason) {
  return clientManager.reconnect({ reason }).catch(err => {
    if (verboseLog) node.warn("reconnect failed: " + err.message);
  });
}
```

Locked consumer pattern for other nodes (D-05):
```js
// In input handler catch block, before general error path:
if (clientManager._isConnectionLostError && clientManager._isConnectionLostError(error)) {
  try { await clientManager.reconnect({ reason: "session-lost" }); } catch (e) { /* handled by reconnect */ }
}
```

Events to emit from reconnect() (per CONTEXT.md reusable assets):
- "reconnecting"  — before first attempt
- "reconnected"   — on success
- "reconnect_failed" — after all attempts exhausted
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add reconnect() and _isConnectionLostError() to OpcUaClientManager</name>
  <files>lib/opcua-client-manager.js, test/opcua-client-manager-reconnect.test.js</files>
  <behavior>
    - reconnect() single-flight: two concurrent calls share the exact same Promise instance
    - reconnect() respects maxAttempts=1: throws after one failed attempt
    - reconnect() with maxAttempts=0 (infinite): loops until connect() succeeds
    - _isConnectionLostError() returns true for: "Session is no longer valid", "Not connected", strings containing "premature disconnection", "Secure Channel Closed", "connection may have been rejected", "Server end point", "socket has been disconnected"
    - _isConnectionLostError() returns false for non-connection errors ("timeout reading", "Invalid NodeId")
    - reconnect() emits "reconnecting" before first attempt, "reconnected" on success, "reconnect_failed" when maxAttempts exceeded
    - reconnect() nulls _reconnectPromise in .finally() so a second sequential call gets a fresh promise
  </behavior>
  <action>
    Write tests first (RED), then implement (GREEN).

    In test/opcua-client-manager-reconnect.test.js:
    - Use "use strict"; Chai expect; sinon. Follow 2-space indentation, double-quote style (match lib/ convention).
    - Create a minimal OpcUaClientManager with config { maxReconnectAttempts: 2, reconnectDelay: 100 } and a sinon-stubbed connect() that either resolves or rejects.
    - Section dividers: // ─── single-flight ─── // ─── maxAttempts ─── // ─── _isConnectionLostError ───

    In lib/opcua-client-manager.js:
    1. Add private field initialisation in constructor: `this._reconnectPromise = null;`
    2. Add constants near the top of the class (or as module-level constants, matching existing RECONNECT_BASE_DELAY_MS/MAX style already in nodes/opcua-client.js):
       ```js
       const RECONNECT_BASE_DELAY_MS = 2000;
       const RECONNECT_MAX_DELAY_MS = 30000;
       ```
    3. Add `_isConnectionLostError(err)` instance method — verbatim copy of the logic currently in nodes/opcua-client.js:155-165. Instance method (not static) per D-04.
    4. Add `async reconnect(opts = {})` public method:
       - If this._reconnectPromise exists, return it (single-flight).
       - Build the promise: run the retry loop (exponential backoff: Math.min(initialDelay * attempt, maxDelay)), calling this.connect() each iteration.
       - Emit "reconnecting" before the loop.
       - On success: emit "reconnected", return.
       - On exhaustion: emit "reconnect_failed", throw the last error.
       - Wrap in .finally(() => { this._reconnectPromise = null; }).
       - Store promise as this._reconnectPromise = <the-promise>; return this._reconnectPromise.
       - Honour opts.signal (AbortSignal): check signal.aborted at the top of each iteration; if aborted, throw new Error("reconnect aborted").
       - Default maxAttempts = this.maxReconnectAttempts; 0 = infinite.
    5. Run npm test — must pass before continuing.
  </action>
  <verify>
    <automated>cd /home/la/private/node-red-contrib-opcua-suite && npm test 2>&1 | tail -20</automated>
  </verify>
  <done>npm test passes; test/opcua-client-manager-reconnect.test.js exists with ≥7 assertions covering single-flight, maxAttempts, and _isConnectionLostError; grep -n "reconnect(opts" lib/opcua-client-manager.js returns a hit; grep -n "_reconnectPromise" lib/opcua-client-manager.js returns ≥3 hits.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Reduce forceReconnect() in opcua-client.js; add reconnect guards to four consumer nodes</name>
  <files>nodes/opcua-client.js, nodes/opcua-event.js, nodes/opcua-method.js, nodes/opcua-browser.js, nodes/opcua-browse-client.js</files>
  <behavior>
    - nodes/opcua-client.js: forceReconnect() body is exactly the one-liner from D-03; _doForceReconnect is deleted; reconnectPromise local var is deleted; RECONNECT_BASE_DELAY_MS/MAX constants removed (they live in the manager now); ensureConnected() no longer writes clientManager.reconnectAttempts; no direct mutation of clientManager.isConnected or clientManager.reconnectAttempts
    - opcua-event.js input handler: if error caught and clientManager._isConnectionLostError(error) is true, call await clientManager.reconnect({ reason: "session-lost" }) before the general error path
    - opcua-method.js input handler: same guard as opcua-event
    - opcua-browser.js input handler: same guard
    - opcua-browse-client.js runtime input handler: same guard (the editor-side browse path is separate and unchanged)
    - All four consumer nodes: no own retry loops, no direct mutation of manager fields
    - Existing test/opcua-client-retry.test.js must pass unchanged (the external interface of forceReconnect has not changed — it still swallows errors via .catch)
  </behavior>
  <action>
    In nodes/opcua-client.js (lines 155-210):
    - Delete `_doForceReconnect` function entirely.
    - Delete `const RECONNECT_BASE_DELAY_MS`, `const RECONNECT_MAX_DELAY_MS`, `let reconnectPromise = null`.
    - Reduce `forceReconnect` to the D-03 one-liner. Keep verboseLog-gated .catch warn.
    - Delete `isConnectionLostError` local function (now lives in manager as `_isConnectionLostError`).
    - Update the input handler's catch block to use `clientManager._isConnectionLostError(error)` instead of the local `isConnectionLostError(error)`.
    - Update `ensureConnected()`: remove the `clientManager.reconnectAttempts = 0` mutation; keep only the `if (!clientManager.isConnected) await clientManager.connect()` pattern — the manager now owns the state.

    In nodes/opcua-event.js, nodes/opcua-method.js, nodes/opcua-browser.js:
    - In the input handler's catch block, before `node.error(...)` / `done(error)`, add (per D-05):
      ```js
      if (clientManager._isConnectionLostError && clientManager._isConnectionLostError(error)) {
        try { await clientManager.reconnect({ reason: "session-lost" }); } catch (e) { /* handled by reconnect */ }
      }
      ```
    - Do NOT add a retry-on-reconnect attempt for the operation itself in these nodes — just reconnect and let the user re-trigger. Full retry stays in opcua-client.

    In nodes/opcua-browse-client.js:
    - Add the same guard in the runtime `node.on("input", ...)` handler. The editor-side browse cache (`getBrowseConnection`) is NOT modified.

    Run npm test after each file to catch regressions early. Final state: npm test passes with zero modifications to test/opcua-client-retry.test.js or test/integration-session-retry.test.js.

    Commit message pattern for this task: `refactor(DEBT-01): delegate forceReconnect to manager; add reconnect guard to consumer nodes`
  </action>
  <verify>
    <automated>cd /home/la/private/node-red-contrib-opcua-suite && grep -nE "clientManager\.(isConnected|reconnectAttempts|reconnectPromise)\s*=" nodes/ && echo "FAIL: direct mutations found" || echo "OK: no direct mutations"; npm test 2>&1 | tail -20</automated>
  </verify>
  <done>grep for direct mutations returns zero hits; npm test passes; nodes/opcua-client.js forceReconnect() contains exactly one clientManager.reconnect() call and nothing else (beyond the optional warn).</done>
</task>

<task type="auto">
  <name>Task 3: Multi-consumer reconnect integration test (opcua-client + opcua-event)</name>
  <files>test/multi-consumer-reconnect.test.js</files>
  <action>
    Create test/multi-consumer-reconnect.test.js following the pattern of test/integration-session-retry.test.js (boot a real OPCUAServer, drive the nodes, force a session drop, assert recovery).

    Per D-18:
    - Skip entirely if !process.env.LIVE_TESTS (`before(() => { if (!process.env.LIVE_TESTS) return this.skip(); }`).
    - Use a random port in the 49400-49500 range to avoid collision with integration-session-retry.test.js (48400-49400).
    - Spin up an OPCUAServer with the same minimal settings as integration-session-retry.test.js (anonymous, None/None security). Add one integer variable `ns=1;s=MultiConsumerVar`.
    - Create an OpcUaClientManager and drive it directly (same pattern as integration-session-retry). Create a second independent manager for the event node role.
    - Force a session drop by calling `await mgr1.session.close()` (same technique already proven in integration-session-retry.test.js:151-158).
    - Assert both managers re-establish isConnected === true within 10s (poll with a small setTimeout loop or listen for the "connected" event).
    - Assert a read on mgr1 after reconnect succeeds (status Good).
    - Test name: "Multi-consumer reconnect: both managers recover after forced session drop".
    - File starts with `"use strict";`, uses Chai expect, section dividers, 2-space indent / double quotes.
    - this.timeout(30000) on the describe block (not 60000 — the test has a hard 10s recovery window).

    Note: Because the LIVE_TESTS guard means this test is skipped in normal CI, it must NOT be the only coverage for the single-flight behaviour — that is handled by test/opcua-client-manager-reconnect.test.js (Task 1). The integration test proves the end-to-end wiring is correct when run manually.

    Run npm test to confirm the suite still passes (the new file's tests will be skipped absent LIVE_TESTS).
  </action>
  <verify>
    <automated>cd /home/la/private/node-red-contrib-opcua-suite && npm test 2>&1 | grep -E "passing|failing|pending"</automated>
  </verify>
  <done>npm test passes; test/multi-consumer-reconnect.test.js exists; running `npm test` without LIVE_TESTS set shows the new suite as "pending" or "skipped" (0 failing); running with LIVE_TESTS=1 would exercise the full scenario.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| node code → OpcUaClientManager | Consumer nodes call public reconnect(); they must not mutate manager internals. |
| OpcUaClientManager → node-opcua client | Reconnect calls this.connect(); connection-lost detection relies on error message strings from node-opcua (fragile, noted in CONCERNS.md). |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-01-01 | Denial of Service | reconnect() infinite loop (maxAttempts=0) | accept | Default 0=infinite is the existing user-configurable behaviour (retryAttempts in config). AbortSignal support in reconnect(opts.signal) allows clean cancellation on node close. |
| T-01-02 | Tampering | reconnectAttempts / isConnected mutations from node code | mitigate | Acceptance criterion: grep for direct mutations returns zero. No new public mutators added. |
| T-01-03 | Information Disclosure | error messages logged via node.warn (verboseLog) | accept | Existing verboseLog toggle already gates all reconnect warnings; behaviour unchanged. |
</threat_model>

<verification>
After all tasks in this plan are committed:

```bash
cd /home/la/private/node-red-contrib-opcua-suite

# AC-1: no direct mutations of manager internals from node files
grep -nE "clientManager\.(isConnected|reconnectAttempts|reconnectPromise)\s*=" nodes/
# Expected: zero output

# AC-2: forceReconnect() is a one-liner
grep -A3 "function forceReconnect" nodes/opcua-client.js
# Expected: body contains exactly one statement referencing clientManager.reconnect(

# AC-3: reconnect() single-flight documented and tested
grep -n "reconnect(opts" lib/opcua-client-manager.js
node -e "const m = require('./lib/opcua-client-manager'); console.log(typeof m.prototype.reconnect)"
# Expected: "function"

# AC-4: full suite passes
npm test
```
</verification>

<success_criteria>
- `grep -nE "clientManager\.(isConnected|reconnectAttempts|reconnectPromise)\s*=" nodes/` returns zero hits.
- `OpcUaClientManager.prototype.reconnect` exists and has a JSDoc comment.
- `nodes/opcua-client.js::forceReconnect()` contains a single `clientManager.reconnect(...)` call.
- `test/opcua-client-manager-reconnect.test.js` has ≥7 passing assertions covering single-flight, maxAttempts, and known error strings.
- `test/multi-consumer-reconnect.test.js` exists and is skipped (not failing) under `npm test` without LIVE_TESTS.
- `npm test` passes (no regressions in opcua-client-retry.test.js or integration-session-retry.test.js).
- Commits produced: ≥4 (one per file group: manager tests + manager impl, client.js, consumer nodes, integration test).
</success_criteria>

<output>
After completion, create `.planning/phases/01-pre-work/01-01-SUMMARY.md` using the template at `@$HOME/.claude/get-shit-done/templates/summary.md`.
</output>
