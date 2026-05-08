---
phase: 01-pre-work
plan: 02
subsystem: infra
tags: [cert-management, http-routes, refactor, node-red-httpadmin, mocha, sinon]

# Dependency graph
requires:
  - phase: 00-init
    provides: existing nodes/opcua-endpoint.js cert routes; lib/ convention
provides:
  - lib/cert-store.js with six exported helpers and a registerCertRoutes(RED, prefix, certsDir) factory
  - parameterised CERT_ROUTE_PREFIX in nodes/opcua-endpoint.html (single source of truth for editor-side URL)
  - test/cert-store.test.js with 24 unit tests covering sanitisation, fs ops, HTTP handlers, and the !RED.httpAdmin guard
affects: [02-pubsub-foundation, 03-pubsub-publisher, 04-pubsub-subscriber, opcua-pubsub-connection-config-node]

# Tech tracking
tech-stack:
  added: []  # No new runtime or dev deps; uses existing fs/path + Mocha/Chai/Sinon
  patterns:
    - "Pure-function helper module + parameterised Express-route factory (registerCertRoutes(RED, prefix, certsDir))"
    - "Editor-side route prefix as a single var CERT_ROUTE_PREFIX so future config nodes can override"
    - "{ status: number } property on thrown Errors to drive HTTP response status codes"

key-files:
  created:
    - lib/cert-store.js
    - test/cert-store.test.js
  modified:
    - nodes/opcua-endpoint.js
    - nodes/opcua-endpoint.html

key-decisions:
  - "Kept lib/cert-store.js dependency-free (no opcua-utils import) so non-OPC nodes can reuse it"
  - "registerCertRoutes guards on !RED || !RED.httpAdmin and returns no-op (mirrors existing test-env pattern)"
  - "Editor-side prefix uses 'opcua-endpoint' (no leading slash) to preserve identical $.ajax behaviour vs. previous hard-coded literal"
  - "Server-side prefix uses '/opcua-endpoint' (with leading slash) — Express normalises both forms identically when registering"

patterns-established:
  - "Pure-function module + route-factory split: filesystem helpers usable in any process; HTTP wiring lives behind a single registration entry point per consumer"
  - "Error-status convention: lib helpers throw `Error` with `.status = 4xx/5xx` so route handlers can map directly to res.status(...).json(...)"

requirements-completed: [DEBT-02]

# Metrics
duration: ~25min
completed: 2026-05-08
---

# Phase 1 Plan 02: Cert Store Extraction Summary

**Cert filesystem ops + HTTP-admin routes extracted from nodes/opcua-endpoint.js into a reusable lib/cert-store.js module with a parameterised registerCertRoutes(RED, prefix, certsDir) factory; behaviour preserved bit-for-bit.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-08
- **Completed:** 2026-05-08
- **Tasks:** 2 (Task 1 TDD: RED + GREEN; Task 2: refactor)
- **Files created:** 2 (lib/cert-store.js, test/cert-store.test.js)
- **Files modified:** 2 (nodes/opcua-endpoint.js, nodes/opcua-endpoint.html)
- **Net diff:** +192 / -53 lines

## Accomplishments

- `lib/cert-store.js` exports the six locked functions per D-06: `sanitiseFilename`, `getCertsDir`, `listCerts`, `uploadCert`, `deleteCert`, `registerCertRoutes`
- All filesystem-touching helpers are pure functions over an explicit `certsDir` parameter — no module-scoped state, no implicit globals
- `nodes/opcua-endpoint.js` is reduced from a 64-line cert+route preamble to one `registerCertRoutes(RED, '/opcua-endpoint', getCertsDir(RED))` call (identical lifecycle, identical responses)
- `nodes/opcua-endpoint.html` editor JS uses a single `CERT_ROUTE_PREFIX` constant; the future opcua-pubsub-connection config node only needs to re-declare that var to point at its own routes
- 24 unit tests added (well over the ≥12 required); full Mocha suite at 213 passing (was 189 before, +24 new tests, zero regressions)
- Zero new runtime dependencies; zero `package.json` diff

## Task Commits

Task 1 — TDD (RED → GREEN):

1. **RED gate: failing tests for lib/cert-store** — `df4ccf9` (test)
2. **GREEN gate: implement lib/cert-store** — `acd5ecf` (feat) — also fixed one off-by-one in the test spec (see deviation 1)

Task 2 — refactor consumers:

3. **Extract cert routes; parameterise HTML prefix** — `4566218` (refactor)

_Note: Task 1 followed TDD properly — RED commit shows tests failing because the module didn't yet exist (`MODULE_NOT_FOUND`); GREEN commit added the implementation and turned all 24 tests green._

## Files Created/Modified

### Created

- `lib/cert-store.js` — 178 lines. Pure helpers + `registerCertRoutes` factory. JSDoc banner, error-status convention, filename sanitisation regex copied verbatim from the inline implementation, extension whitelist applied in `listCerts` only (uploads accept any extension per D-07).
- `test/cert-store.test.js` — 24 assertions across 9 `describe` blocks. Mock RED via plain object capturing routes by name; sinon stubs for `res.json` / `res.status`; real `os.tmpdir()/cert-store-test` directory cleaned in `afterEach`/`after`.

### Modified

- `nodes/opcua-endpoint.js` — removed inline `path.join(certsDir, …)` + `fs.mkdirSync` + three `RED.httpAdmin.*` registrations + the `if (!RED.httpAdmin)` skip block. Replaced with `const { registerCertRoutes, getCertsDir } = require('../lib/cert-store')` and one call. Dropped now-unused `path` import; kept `fs` (still used by `getCertificateData`).
- `nodes/opcua-endpoint.html` — added `var CERT_ROUTE_PREFIX = 'opcua-endpoint';` at the top of the editor `<script>` (matches existing relative-URL behaviour). Replaced the single hard-coded `'opcua-endpoint/upload-cert'` literal in the upload `$.ajax` call with `CERT_ROUTE_PREFIX + '/upload-cert'`. (No GET/DELETE calls existed on the editor side; only the POST upload was wired.)

## Decisions Made

- **Server-side prefix carries a leading slash (`/opcua-endpoint`); editor-side does not (`opcua-endpoint`).** Both register/resolve to the same Express route; preserves identical observed behaviour vs. the v0.0.7 inline code (which used `/opcua-endpoint/...` server-side and `'opcua-endpoint/...'` client-side already).
- **Kept `lib/cert-store.js` free of `lib/opcua-utils.js` imports.** D-06 made no claim either way; CONTEXT.md "Reusable Assets" suggested using `createError` from `opcua-utils`, but `cert-store.js` is intentionally OPC-agnostic so a future non-OPC contrib node could reuse it. Used native `Error` with a `.status` property instead.
- **Used `Error` + `.status` to communicate HTTP status from helpers to route handlers.** Avoids leaking `res.status(...)` calls into pure helpers; route handlers map `err.status || <default>` cleanly.
- **`getCertsDir` swallows `mkdirSync` errors.** Mirrors the v0.0.7 behaviour explicitly (`/* ignore in test */`); read-only test environments still get a usable path string.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan example string for sanitiseFilename had wrong expected output**

- **Found during:** Task 1 GREEN (running unit tests)
- **Issue:** Plan task 1 `<behavior>` block specified `sanitiseFilename('../../evil') === '.._..evil'`. Actually `'../../evil'` contains three `/` characters between dots, so the regex (which is a verbatim copy of the v0.0.7 production regex per D-07) produces `.._.._evil` — three underscores, not two.
- **Fix:** Updated the assertion in `test/cert-store.test.js` to expect `.._.._evil` (the actual correct sanitisation output). The production regex was NOT changed — only the test expectation was corrected to match real behaviour. Added an inline comment explaining the count.
- **Files modified:** `test/cert-store.test.js` (one assertion line)
- **Verification:** Test now passes; sanitisation behaviour matches v0.0.7 inline code (path-traversal characters all become `_`, no behaviour change for users).
- **Committed in:** `acd5ecf` (folded into the GREEN commit since it was the same task)

---

**Total deviations:** 1 auto-fixed (1 bug — incorrect example in plan spec, not a code defect).
**Impact on plan:** None on production behaviour. The regex contract from D-07 is preserved verbatim. Only the example expected-value in the test spec was off by one underscore.

## Threat Surface Scan

The plan's `<threat_model>` enumerates four threats (T-02-01..04). Status:

- **T-02-01 (Tampering, sanitiseFilename):** mitigation preserved — verbatim regex copy; test asserts path-traversal characters are replaced (`'../../evil'` → `.._.._evil`).
- **T-02-02 (DoS, no upload size limit):** disposition `accept` — unchanged from v0.0.7. CONCERNS.md tracks this as future hardening.
- **T-02-03 (Info disclosure, full path in list response):** disposition `accept` — `{ name, path }` shape preserved exactly so existing editor JS keeps working.
- **T-02-04 (Spoofing via prefix parameter):** disposition `accept` — both call sites (server side `'/opcua-endpoint'`, editor side `'opcua-endpoint'`) are hard-coded constants; no user input flows into the prefix.

No new threat surface introduced by this refactor (no new endpoints, no new auth paths, no new schema). No `threat_flags` to add.

## Issues Encountered

- The plan's expected-value example for `sanitiseFilename('../../evil')` was off by one underscore — see Deviation 1 above. Resolved by correcting the test, not the implementation (regex is unchanged).

## Verification Evidence

```
# AC-5: lib/cert-store.js exports
$ node -e "const cs = require('./lib/cert-store'); console.log(Object.keys(cs).join(', '))"
sanitiseFilename, getCertsDir, listCerts, uploadCert, deleteCert, registerCertRoutes

# AC-6: opcua-endpoint.js has zero inline routes
$ grep -nE "RED\.httpAdmin\.(post|get|delete)" nodes/opcua-endpoint.js
(none)

# AC-6b: exactly one registerCertRoutes call
$ grep -n "registerCertRoutes(" nodes/opcua-endpoint.js
17:    registerCertRoutes(RED, '/opcua-endpoint', getCertsDir(RED));

# AC-7: HTML prefix variable (>=2 hits)
$ grep -n "CERT_ROUTE_PREFIX" nodes/opcua-endpoint.html
4:    var CERT_ROUTE_PREFIX = 'opcua-endpoint';
121:                            url: CERT_ROUTE_PREFIX + '/upload-cert',

# AC-7b: zero hard-coded literals
$ grep -c "opcua-endpoint/upload-cert" nodes/opcua-endpoint.html
0

# AC-8: full test suite green (24 cert-store tests + 189 prior = 213)
$ npm test
  213 passing (2s)
```

## TDD Gate Compliance

- RED commit `df4ccf9` (`test(01-02): add failing tests for lib/cert-store`) — tests fail with `MODULE_NOT_FOUND` (lib/cert-store.js absent).
- GREEN commit `acd5ecf` (`feat(01-02): implement lib/cert-store with cert helpers + route factory`) — implementation added; all 24 cert-store tests pass.
- No REFACTOR commit (implementation was already minimal and idiomatic; no cleanup pass needed).

## Next Phase Readiness

- DEBT-02 fully closed: `lib/cert-store.js` is the single source of truth for cert operations and route registration.
- The forthcoming opcua-pubsub-connection config node can call `registerCertRoutes(RED, '/opcua-pubsub-connection', getCertsDir(RED))` and re-declare `CERT_ROUTE_PREFIX = 'opcua-pubsub-connection'` on its editor side — no copy-paste of route logic needed.
- No blockers for sibling plans 01 (reconnect consolidation) or 03 (msg-schema doc) — file-disjoint.

## Self-Check: PASSED

Verified files exist:
- FOUND: lib/cert-store.js
- FOUND: test/cert-store.test.js
- FOUND: nodes/opcua-endpoint.js (modified)
- FOUND: nodes/opcua-endpoint.html (modified)

Verified commits exist (`git log --oneline`):
- FOUND: df4ccf9 — test(01-02): add failing tests for lib/cert-store
- FOUND: acd5ecf — feat(01-02): implement lib/cert-store with cert helpers + route factory
- FOUND: 4566218 — refactor(01-02): extract cert routes to lib/cert-store; parameterise HTML prefix

---
*Phase: 01-pre-work*
*Plan: 02 — cert-store extraction*
*Completed: 2026-05-08*
