---
phase: 02-encoders-and-config-objects
plan: "04"
subsystem: pubsub-config
tags:
  - opcua
  - pubsub
  - config
  - validation
dependency_graph:
  requires:
    - lib/opcua-utils.js (createError)
  provides:
    - lib/pubsub-config.js (validateWriterGroup, WriterGroup, validateDataSetWriter, DataSetWriter, validatePublishedDataSet, PublishedDataSet, validateDataSetReader, DataSetReader)
  affects:
    - Phase 3 config UI (validate* functions for inline feedback)
    - Phase 4 Publisher/Subscriber lifecycle (factory functions for non-bypassable config construction)
tech_stack:
  added: []
  patterns:
    - validate+factory hybrid (D-13) — novel in this codebase
    - Object.freeze on factory return (D-16)
    - Structured Issue shape {path, code, message} (D-14)
key_files:
  created:
    - lib/pubsub-config.js
    - test/pubsub-config.test.js
  modified: []
decisions:
  - "D-15 locked rules implemented exactly: keepAliveTime>=publishingInterval, FILTER_REQUIRED, RawData cross-validation with abstract type and maxStringLength checks"
  - "D-16 Object.freeze applied to all factory returns including nested fields array and configurationVersion"
  - "PITFALLS #3 mitigated: keyFrameCount defaults to 1, messageReceiveTimeout defaults to max(3xkeepAlive,5000)"
  - "PITFALLS #6 mitigated: maxNetworkMessageSize defaults to 1400 (IPv4 UDP MTU-safe)"
  - "PITFALLS #2 mitigated: RawData (bit 5 of dataSetFieldContentMask) enforces concrete types and maxStringLength on String fields"
  - "T-02-16 through T-02-19 threat mitigations fully implemented and tested"
metrics:
  duration: "~15 minutes"
  completed: "2026-05-13"
  tasks_completed: 2
  files_created: 2
  tests_added: 68
  tests_total_before: 231
  tests_total_after: 299
---

# Phase 2 Plan 04: pubsub-config Validators + Frozen Factories Summary

**One-liner:** Pure validate+factory hybrid for WriterGroup/DataSetWriter/PublishedDataSet/DataSetReader with D-15 locked rules, Object.freeze, and RawData cross-validation.

## What Was Built

### lib/pubsub-config.js (354 lines)

A CommonJS module implementing the D-13 hybrid pattern for four OPC UA PubSub config types:

- `validateWriterGroup(cfg)` / `WriterGroup(cfg)` — enforces publishingInterval > 0, keepAliveTime >= publishingInterval, writerGroupId 1..65535, priority 0..255
- `validatePublishedDataSet(cfg)` / `PublishedDataSet(cfg)` — enforces non-empty name, non-empty fields array, optional configurationVersion shape
- `validateDataSetWriter(cfg)` / `DataSetWriter(cfg)` — enforces dataSetWriterId 1..65535, RawData cross-validation against publishedDataSet fields (abstract type rejection, String maxStringLength enforcement)
- `validateDataSetReader(cfg)` / `DataSetReader(cfg)` — enforces at least one filter (publisherId | writerGroupId | dataSetWriterId), defaults messageReceiveTimeout = max(3 x keepAliveTime, 5000)

All factories: call validate*() first (non-bypassable), apply nullish-coalescing defaults, return Object.freeze(result).

### test/pubsub-config.test.js (488 lines, 68 tests)

Mocha + Chai test suite covering:
- All D-15 validation rules (positive/negative cases for each rule)
- All factory defaults (keepAliveTime, maxNetworkMessageSize=1400, priority=128, keyFrameCount=1, messageReceiveTimeout formula)
- Factory non-bypassability (6 explicit throw tests across all 4 factories)
- Object.freeze assertions (8 assertions across all factories including nested arrays)
- RawData cross-validation (NodeId abstract type rejection, ExpandedNodeId, String without maxStringLength)
- ROADMAP success criteria #3 and #4 explicitly named and covered

## Test Count Delta

| Metric | Value |
|--------|-------|
| Tests before | 231 |
| Tests added | 68 |
| Tests after | 299 |
| Regressions | 0 |

## D-15 Rules — Confirmed Implemented and Tested

| Rule | Code | Default | Tested |
|------|------|---------|--------|
| WriterGroup.publishingInterval > 0 | MUST_BE_POSITIVE_NUMBER | — | Yes |
| WriterGroup.keepAliveTime >= publishingInterval | MUST_BE_GTE_PUBLISHING_INTERVAL | = publishingInterval | Yes |
| WriterGroup.maxNetworkMessageSize > 0 | MUST_BE_POSITIVE_NUMBER | 1400 | Yes |
| WriterGroup.priority 0..255 | MUST_BE_BYTE_RANGE | 128 | Yes |
| WriterGroup.writerGroupId 1..65535 | MUST_BE_NONZERO_UINT16 / MUST_BE_UINT16 | — | Yes |
| DataSetWriter.dataSetWriterId 1..65535 | MUST_BE_NONZERO_UINT16 | — | Yes |
| DataSetWriter.keyFrameCount >= 0 | MUST_BE_NONNEGATIVE_INTEGER | 1 | Yes |
| DataSetWriter RawData abstract types | RAW_DATA_REQUIRES_CONCRETE_TYPES | — | Yes |
| DataSetWriter RawData String maxStringLength | RAW_DATA_STRING_MISSING_MAX_LENGTH | — | Yes |
| PublishedDataSet.configurationVersion | MUST_BE_VERSION_PAIR | {major:1,minor:0} | Yes |
| DataSetReader filter required | FILTER_REQUIRED | — | Yes |
| DataSetReader.messageReceiveTimeout | MUST_BE_POSITIVE_NUMBER | max(3x,5000) | Yes (both branches) |

## Factory Non-Bypassability (T-02-16)

Each factory enforces validation internally. There is no code path to construct an invalid config. Tested via 6 explicit `expect(fn).to.throw()` tests across all 4 factories. The `createError()` throw includes `.code` and `.errors` properties for programmatic inspection.

## Frozen Config Immutability (T-02-17)

All 4 factories call `Object.freeze(result)`. `PublishedDataSet` additionally freezes the `fields` array and each field object, and `configurationVersion`. `DataSetWriter` embeds a frozen `PublishedDataSet` sub-object. Tested with 8 `Object.isFrozen()` assertions.

## Deviations from Plan

None — plan executed exactly as written. The provided action code in the plan was used as the basis with minor adjustments:

1. **[Rule 2 - Enhancement] Error object enrichment**: Added `.code` and `.errors` properties to the thrown error object from each factory (beyond what the plan's action snippet showed) to match the PATTERNS.md `createError` extension pattern. This makes errors programmatically inspectable without string parsing.

2. **[Rule 2 - Enhancement] Additional test coverage**: Added 18 tests beyond the 50 shown in the plan action (total 68 vs ~50 in plan sketch), covering edge cases like: priority=0 accepted, writerGroupId=65535 accepted, explicit configurationVersion accepted, DataSetWriter dataSetName type validation, DataSetReader writerGroupId/dataSetWriterId filter alternatives, DataSetReader messageReceiveTimeout=5000 when no keepAliveTime, DataSetWriter embeds frozen PublishedDataSet. All additions are positive quality improvements with no behavior changes.

## Threat Flags

None — all surfaces are internal pure functions with no network endpoints, auth paths, file access, or schema changes.

## Known Stubs

None — all factory return values are fully populated with either explicit or default values. No placeholder data flows to callers.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| lib/pubsub-config.js exists | FOUND |
| test/pubsub-config.test.js exists | FOUND |
| 02-04-SUMMARY.md exists | FOUND |
| Commit 593bc80 (Task 1) | FOUND |
| Commit d381922 (Task 2) | FOUND |
