---
phase: 01-pre-work
plan: 03
subsystem: docs
tags: [msg-schema, opc-ua, documentation, debt-03, pubsub-prep]

# Dependency graph
requires:
  - phase: init
    provides: SPEC.md DEBT-03 acceptance criteria; CONTEXT.md D-12..D-15 structure decisions
provides:
  - Authoritative docs/MSG-SCHEMA.md covering all 40+ msg.* fields across the 8 nodes
  - v1.0 stability statement freezing the existing message contract
  - Reserved field-name registry for the seven v0.1.0 PubSub fields (collision prevention)
  - README link from "## Reference" section to the new schema document
affects: [02-pubsub-encoding, 03-pubsub-transports, pubsub-publisher, pubsub-subscriber, future-debt-cleanups]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-node Markdown schema table: Field | Direction | Type | Required | Description | Source"
    - "Reserved-fields section pattern for forward-looking name registries"

key-files:
  created:
    - docs/MSG-SCHEMA.md
  modified:
    - README.md

key-decisions:
  - "Documented msg.func DANGER (eval'd via new Function) with explicit trust note — accepts existing T-03-01 disposition"
  - "Cited canonical read/write site for each field rather than every occurrence (single representative line per direction)"
  - "Surfaced msg.serverTimestamp / msg.sourceTimestamp despite not appearing in nodes/*.js grep (they originate from lib/opcua-client-manager.js DataValue mappings) — already in SPEC.md acceptance"
  - "Listed msg.message and msg.severity as top-level fields on opcua-event because they are surfaced as message properties for downstream debug nodes (per source reading), even though the SPEC interface notes flagged them as 'sub-field of payload'"

patterns-established:
  - "Schema doc location: docs/MSG-SCHEMA.md at repo root (new docs/ directory created)"
  - "Stability convention: 'v1.0 Stability Statement' top-level section at the start of any contract document"
  - "Reserved-fields trailing section pattern for upcoming-version namespace announcements"

requirements-completed: [DEBT-03]

# Metrics
duration: 3min 17s
completed: 2026-05-08
---

# Phase 1 Plan 03: msg.* Schema Documentation Summary

**Authoritative `docs/MSG-SCHEMA.md` documenting all 40+ msg.* fields across the eight existing nodes, with v1.0 stability lock and reserved-name registry for the seven upcoming PubSub fields.**

## Performance

- **Duration:** 3 min 17 s
- **Started:** 2026-05-08T10:55:59Z
- **Completed:** 2026-05-08T10:59:16Z
- **Tasks:** 2
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments

- Authored `docs/MSG-SCHEMA.md` (~325 lines) with one section per node (8 nodes), each with a six-column table (`Field | Direction | Type | Required | Description | Source`) citing canonical read/write line numbers in `nodes/*.js` and `lib/opcua-client-manager.js`.
- Added top-level **"v1.0 Stability Statement"** locking the existing message contract (no field renames at v1.0; v0.x renames must be called out in `CHANGELOG.md`).
- Added trailing **"Reserved for v0.1.0 (PubSub)"** section listing the seven reserved field names (`msg.dataSet`, `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber`, `msg.encoding`, `msg.transport`) with type and direction — gives the upcoming Pub/Sub work a clean namespace and prevents silent collisions with v1.0 fields.
- Added an explicit **trust note** for `msg.func` (`opcua-server.addMethod` evaluates it via `new Function(...)`) — captures the T-03-01 STRIDE disposition (`accept` with documented danger).
- Coverage cross-check appendix lists every distinct grep-found field name so contributors can re-verify after future edits.
- Added a single-line link from `README.md`'s `## Reference` section to the new schema document — exactly per D-15.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create docs/ directory and author docs/MSG-SCHEMA.md** — `aaf0747` (docs)
2. **Task 2: Add MSG-SCHEMA.md link to README.md** — `aea9e9e` (docs)

_Note: this plan is documentation-only; no test or refactor commits._

## Files Created/Modified

- `docs/MSG-SCHEMA.md` — **created** — authoritative msg.* field reference for all 8 nodes; v1.0 stability statement; PubSub reserved-fields registry; trust note for msg.func.
- `README.md` — **modified** — added one line under `## Reference` linking to `docs/MSG-SCHEMA.md` (no other content changed; verified via `git diff`).

## Decisions Made

- **Cite canonical source site, not every occurrence.** Several fields (e.g. `msg.nodeId`, `msg.payload`, `msg.topic`) are read in many places. The Source column lists one representative read-site (for `in`) or write-site (for `out`) per direction — exhaustive line-by-line citation would be unmaintainable as line numbers drift across patch releases.
- **Surface `msg.serverTimestamp` / `msg.sourceTimestamp` despite the `nodes/*.js` grep not catching them.** They originate from DataValue mappings in `lib/opcua-client-manager.js:440–441, 506–507, 558–559, 740–741` and reach `msg` via `Object.assign(msg, result)` at `nodes/opcua-client.js:244`. SPEC.md AC-10 calls them out explicitly; included them in the opcua-client and opcua-browse-client tables.
- **Treat `msg.message` and `msg.severity` as top-level fields on `opcua-event`.** The CONTEXT.md interface notes flagged them as sub-fields of the event payload object, but reading `nodes/opcua-event.js` shows the event-delivery payload is an object whose keys become first-class msg properties for downstream debug nodes. Documented as top-level outputs with a note clarifying their origin.
- **Followed CONTEXT.md D-12..D-15 structure exactly.** No format deviation: column set, reserved-section heading, stability-section heading, README insertion point all match the locked decisions.

## Deviations from Plan

None - plan executed exactly as written.

The interface block in the PLAN.md noted a small discrepancy between the SPEC.md acceptance criterion (which mentions `msg.serverTimestamp` / `msg.sourceTimestamp`) and the `nodes/*.js`-only grep (which does not surface them). Cross-checking `lib/opcua-client-manager.js` confirmed they are real output fields — documenting them is the SPEC-required behaviour, not a deviation.

## Issues Encountered

None.

## Verification Performed

- `test -f docs/MSG-SCHEMA.md` → `OK` (file exists)
- `grep -c "v1.0 Stab" docs/MSG-SCHEMA.md` → `1` (stability section present)
- `grep -c "Added in v0.1.0 (PubSub)" docs/MSG-SCHEMA.md` → `1` (reserved-fields heading present)
- Reserved table row count under `## Reserved for v0.1.0` → `7` (all seven fields listed)
- All seven reserved field names appear in the document body → `FOUND` for each of `dataSet`, `publisherId`, `writerGroupId`, `dataSetWriterId`, `sequenceNumber`, `encoding`, `transport`
- `grep -c "docs/MSG-SCHEMA.md" README.md` → `1` (exactly one link, no duplicates)
- All 40 distinct `msg.*` names from `grep -rhnE "msg\.[a-zA-Z_]+" nodes/*.js lib/*.js | grep -oE "msg\.[a-zA-Z_]+" | sort -u` are present in the document → `FOUND` for every field
- `git diff f46fedc..HEAD --name-only | grep -E "^(nodes/|lib/|test/)" | wc -l` → `0` (no code-file changes; refactor isolation respected)
- `git diff README.md` post-commit shows only the two-line addition (one new content line + one blank line); no other README content was reformatted.

`npm test` was **not** run from this plan because:
- This plan is documentation-only — no code paths exercised.
- This worktree runs in parallel with Plans 01 (reconnect refactor) and 02 (cert-store extraction); their merge is the orchestrator's responsibility.
- The orchestrator runs the full Mocha suite once after all wave-1 worktrees merge — the SPEC.md test-guard constraint is enforced there.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **DEBT-03 closed.** PubSub Publisher / Subscriber planners can reference `docs/MSG-SCHEMA.md` directly when defining new msg.* fields and use the `## Reserved for v0.1.0 (PubSub)` table as the single source of truth for the seven reserved names.
- **No blockers introduced.** Documentation-only delivery; zero impact on runtime behaviour, dependencies, or test surface.
- **Follow-up suggestion (deferred, not a blocker):** when Phase 2 (PubSub encoding) lands, move the seven reserved fields out of the "Reserved for v0.1.0 (PubSub)" section and into per-PubSub-node sections in the same document, preserving the structure established here.

## Self-Check: PASSED

- `docs/MSG-SCHEMA.md` — FOUND
- `README.md` — FOUND (with `docs/MSG-SCHEMA.md` link, exactly 1 occurrence)
- Commit `aaf0747` — FOUND in `git log --oneline --all`
- Commit `aea9e9e` — FOUND in `git log --oneline --all`
- All 7 reserved fields listed under `## Reserved for v0.1.0 (PubSub)` — FOUND
- All 40 grep-found `msg.*` field names appear in the document — FOUND
- Zero code-file changes (`nodes/`, `lib/`, `test/`) — VERIFIED via `git diff` since base

---
*Phase: 01-pre-work*
*Plan: 03*
*Completed: 2026-05-08*
