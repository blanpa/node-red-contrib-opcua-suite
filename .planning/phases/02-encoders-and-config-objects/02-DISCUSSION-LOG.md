# Phase 2: Encoders and Config Objects — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `02-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-05-10
**Phase:** 02-encoders-and-config-objects
**Areas discussed:** UADP Encoder API, JSON Encoder Strategy, NetworkMessage Data Model, Config Validation + Test Vectors

---

## Pre-locked context (carried in, not discussed)

From REQUIREMENTS.md, ROADMAP.md, PROJECT.md, PITFALLS.md, prior CONTEXT.md (Phase 1):

- Code in `lib/`, CommonJS, 2-space indent, double quotes, no TypeScript
- `MaxNetworkMessageSize` default = 1400 bytes (PITFALLS #6)
- `KeyFrameCount` default = 1 (PITFALLS #3)
- `KeepAliveTime >= PublishingInterval` validated (Part 14 §6.2.5, PITFALLS #3)
- `MessageReceiveTimeout` default = `max(3 × KeepAliveTime, 5000ms)` (PITFALLS #3)
- Variant encoding default; RawData explicit opt-in only (PITFALLS #2)
- ExtendedFlags1/2 must be suppressed when all bits zero (PITFALLS #1)
- Reuse `lib/opcua-utils.js` NodeId helpers (PROJECT.md Key Decision)
- No new runtime deps for encoders (PROJECT.md Constraint)
- `msg.publisherId`, `msg.writerGroupId`, `msg.dataSetWriterId`, `msg.sequenceNumber`, `msg.encoding`, `msg.transport` reserved per `docs/MSG-SCHEMA.md` (Phase 1 DEBT-03)

---

## Gray Area selection

User invoked discuss-phase, was presented 4 candidate gray areas, replied "was schlägst du vor?" (asking Claude to pick). Claude proposed a recommendation set covering all four areas; user confirmed "Ja, alles wie vorgeschlagen".

Recorded as: user delegated decision-making to Claude under prior trust signal ("ok mach was du denkst"), reviewed Claude's reasoning, and accepted in one round.

---

## UADP Encoder API & Buffer Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Pure-function symmetric API + private internal `BinaryStream` | `encode/decodeNetworkMessage` as exported pure functions; conditional serializer hidden inside; no Buffer reuse in Phase 2 | ✓ |
| Class-based `UadpEncoder` with state | Reusable buffer pool as instance state; `new UadpEncoder().encode(nm)` API | |
| Streaming API exposed publicly | Caller drives a `BinaryStream` writer they create themselves | |

**User's choice:** Option 1 (pure-function symmetric API).
**Rationale captured in D-01..D-04.** Buffer reuse explicitly deferred to Phase 4 because it's a Publisher-WriterGroup-lifecycle concern that conflicts with "stateless" Phase 2 boundary.

---

## JSON Encoder Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Imperative string-building + per-field `JSON.stringify` | Hard-coded field emission order per Part 14 schema; deterministic output | ✓ |
| Pure `JSON.stringify` over the model | Simpler but produces wrong format (no UaType wrapper) and wrong key order | |
| `fast-json-stringify` with pre-compiled per-WriterGroup schemas | Fastest; new dev-dep; schema compilation per WriterGroup | |

**User's choice:** Option 1 (imperative).
**Rationale captured in D-05..D-08.** YAGNI on `fast-json-stringify` until Phase 4 benchmarks justify; PROJECT.md "minimize new deps" wins.

---

## NetworkMessage / DataSetMessage Data Model

| Option | Description | Selected |
|--------|-------------|----------|
| Domain-friendly model; flags derived at encode time | `UADPFlags`/`ExtendedFlags1`/`ExtendedFlags2` are NOT model fields; encoder derives them from field presence | ✓ |
| Spec-mirror model | Every Part-14 field including flag bytes explicit at object level | |
| Hybrid: domain-friendly with explicit override hooks | Allows callers to force flag bits when needed | |

**User's choice:** Option 1 (domain-friendly).
**Rationale captured in D-09..D-12.** Mitigates PITFALLS #1 structurally — callers cannot accidentally desync flags from data. Mirrors open62541 reference implementation's approach.

---

## Config Validation Philosophy + Test Vector Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid: pure `validate*()` (collect-all) + factory wrapper that throws | Phase 3 UI uses validators for inline feedback; Phase 4 workers use factories for fail-fast | ✓ |
| Throw-only at construction | Matches existing CONVENTIONS.md style; no editor-time UX hooks | |
| Result-shape only, no throwing factory | All callers must handle the validation result explicitly; consistent but verbose | |

**Validation choice:** Hybrid (Option 1).

| Test vector option | Description | Selected |
|--------------------|-------------|----------|
| Hand-crafted hex literals + runnable open62541 capture script | `test/fixtures/uadp-vectors.js` with hex strings + comments; live-capture script for refresh | ✓ |
| Commit binary fixture files from open62541 | Authoritative but git-fragile and unreviewable in PRs | |
| Runtime golden-master generation | Self-modifying tests; no spec authority | |

**Test vector choice:** Hand-crafted hex + runnable capture script (Option 1).
**Rationale captured in D-13..D-19.** Hex literals are PR-reviewable; capture script provides reproducibility backup. Issue shape `{path, code, message}` gives Phase 3 UI a stable i18n-friendly contract.

---

## Sub-Decisions auto-locked (not menu'd, no objection raised)

- File layout: flat in `lib/` (D-20)
- Code style: 2-space, double quotes, JSDoc on every export (D-21)
- DataSetMessage type default: `keyframe` (folded into D-10)
- ConfigurationVersion default: `{major: 1, minor: 0}` (folded into D-15)
- `Object.freeze()` on returned config objects (D-16)

---

## Claude's Discretion

The following were explicitly handed off to Claude (researcher / planner / executor) without locked answers:

- Exact JSDoc wording per exported function
- Internal helper naming inside `lib/uadp-encoder.js`
- Whether to inline Part 14 spec section numbers in code comments (recommended where non-obvious)
- Hex-literal formatting style in fixture files (reviewer-friendly is the bar)

---

## Deferred Ideas

Captured in `02-CONTEXT.md` `<deferred>` section:

- Buffer-pool / pre-allocated encode buffer → Phase 4 (Publisher lifecycle)
- `fast-json-stringify` adoption → Phase 4 contingent
- DataSetMetaData publishing (META-01) → v2 milestone
- MetaData auto-version-bump on field-list change → Phase 4 Publisher
- `lib/pubsub/` subdir consolidation → Phase 3 (when transports land)
- Security headers (Sign / Sign+Encrypt) → v2/v3 milestones
- Sequence-number gap detection on subscriber (GAP-01) → v2 milestone

---

*Discussion log generated: 2026-05-10*
*Phase: 02-encoders-and-config-objects*
