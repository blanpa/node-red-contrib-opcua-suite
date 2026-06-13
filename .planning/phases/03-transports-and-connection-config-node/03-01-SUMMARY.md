---
phase: 03-transports-and-connection-config-node
plan: 01
subsystem: infra
tags: [mqtt, transport, eventemitter, pubsub, abstract-class]

# Dependency graph
requires:
  - phase: 02-uadp-encoder
    provides: UADP encode/decode (Buffer | Buffer[] payload shape that transports send)
provides:
  - mqtt@^5.15.1 runtime dependency available to the Node-RED process
  - BaseTransport abstract class (extends EventEmitter) with locked connect/close/send contract
  - test/transports/ directory established under the Mocha glob
affects: [03-02-udp-transport, 03-03-mqtt-transport, 03-04-connection-node, phase-04-publisher-subscriber]

# Tech tracking
tech-stack:
  added: [mqtt@^5.15.1]
  patterns:
    - "Abstract base class via ES6 extends EventEmitter with throwing abstract methods"
    - "Async abstract methods reject; synchronous send() throws (no unhandled-rejection swallowing)"
    - "Named export object (module.exports = { BaseTransport })"

key-files:
  created:
    - lib/transports/base-transport.js
    - test/transports/base-transport.test.js
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "send() throws synchronously (not async) so callers cannot swallow the abstract guard in an unhandled rejection"
  - "BaseTransport depends only on the Node built-in events module — zero project-internal imports, Node-RED-free (D-07)"
  - "mqtt installed with caret range ^5.15.1 (not pinned); package-lock.json pins the exact transitive tree"

patterns-established:
  - "Pattern 1: Abstract transport contract — connect() resolves after 'connected' emitted; close() idempotent emits 'disconnected'; send(Buffer|Buffer[]) dispatches Array.isArray internally"
  - "Pattern 2: Events vocabulary connected/disconnected/reconnecting/error/message (D-03 + D-04) documented in JSDoc as the cross-transport interface"

requirements-completed: [TRP-01, TRP-02]

# Metrics
duration: ~8min
completed: 2026-06-13
---

# Phase 3 Plan 01: Transports Foundation Summary

**Installed mqtt@^5.15.1 and created the BaseTransport abstract EventEmitter class locking the connect/close/send + events contract that UdpTransport (03-02) and MqttTransport (03-03) will extend.**

## Performance

- **Duration:** ~8 min
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- Added `mqtt@^5.15.1` as a runtime dependency (caret range, alongside `node-opcua`); `require('mqtt')` resolves and `mqtt.connect` is a function (v5.15.1).
- Created `lib/transports/base-transport.js`: ES6 `BaseTransport extends EventEmitter` with three throwing abstract methods and full JSDoc documenting the locked API contract and event vocabulary.
- Added 7-test Mocha+chai guard suite under the new `test/transports/` directory (auto-discovered by the existing `test/**/*.test.js` glob — no config change needed).
- Verified `instanceof BaseTransport` works for subclasses, enabling downstream Connection-Node runtime checks (D-01).

## Task Commits

Each task was committed atomically:

1. **Task 1: Add mqtt@^5.15.1 dependency and lockfile** - `057a772` (chore)
2. **Task 2: BaseTransport test suite (RED)** + **implementation (GREEN)** - `cd3b4b0` (test + feat combined commit)

**Plan metadata:** committed separately with this SUMMARY.

_TDD note: the RED test file and GREEN implementation were authored in sequence (RED verified failing with MODULE_NOT_FOUND before implementation) and committed together as `cd3b4b0`._

## Files Created/Modified
- `lib/transports/base-transport.js` - Abstract BaseTransport class (EventEmitter heritage, throwing connect/close/send, contract JSDoc)
- `test/transports/base-transport.test.js` - 7 guard tests (config storage, EventEmitter instanceof, abstract guards, named export, on/emit)
- `package.json` - Added `"mqtt": "^5.15.1"` under dependencies
- `package-lock.json` - Resolved transitive tree for mqtt (mqtt-packet, readable-stream, ws, etc.)

## Decisions Made
- `send()` throws synchronously rather than returning a rejected Promise, so a caller cannot accidentally swallow the "not implemented" guard in an unhandled rejection (matches plan §Step B).
- Kept the file Node-RED-free and dependency-free apart from `events` (D-07) so any config node or transport can require it.

## Deviations from Plan

None - plan executed exactly as written.

Note: the plan text referenced a "411" baseline and a "418" expected total. The actual baseline in this repo is 426 passing + 8 pending (the #14 browse-continuation fix added tests after the plan was written). After this plan's 7 new tests the suite is **433 passing + 8 pending** with zero regressions and zero failures — the real acceptance bar ("no regressions + new tests pass") is met.

## Issues Encountered
- `npm install mqtt` surfaced 14 npm-audit vulnerabilities in the transitive tree (3 moderate, 11 high). These are pre-existing supply-chain noise and out of scope: T-03-08 assigns an **accept** disposition (caret range + lockfile pinning; project does not yet enable `npm audit` in CI). No code change made.
- `npm test | tail` truncated the aggregate summary because the transports suite sorts last under the spec reporter; re-ran with `--reporter dot` to confirm the 433/8 totals.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 03-02 (UdpTransport) and 03-03 (MqttTransport) can now `require("./base-transport")` and `class XxxTransport extends BaseTransport {}` with no further setup.
- The `mqtt` module is importable in the test environment without network calls — 03-03's `Module._resolveFilename` mocking strategy can proceed.
- Locked contract (connect/close/send + connected/disconnected/reconnecting/error/message) is documented in JSDoc; downstream implementers must honor it as-is.

## Self-Check: PASSED

- Files verified present: `lib/transports/base-transport.js`, `test/transports/base-transport.test.js`, `03-01-SUMMARY.md`
- Commits verified in git log: `057a772`, `cd3b4b0`
- `package.json` declares `mqtt@^5.15.1`
- Full suite: 433 passing, 8 pending, 0 failing

## TDD Gate Compliance

- RED: `test/transports/base-transport.test.js` verified failing (MODULE_NOT_FOUND) before implementation.
- GREEN: `lib/transports/base-transport.js` implemented; all 7 tests pass.
- REFACTOR: not needed (file is minimal contract-in-code).
- Note: the `test(...)` RED file and `feat(...)` GREEN implementation are captured in a single combined commit `cd3b4b0` (`feat(03-01): ...`) rather than two separate commits, because the executor environment commits per task; the RED→GREEN sequence was honored in execution order.

---
*Phase: 03-transports-and-connection-config-node*
*Completed: 2026-06-13*
