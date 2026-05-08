# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-08)

**Core value:** A Node-RED user can wire any OPC UA interaction — Client/Server (today) and Publisher/Subscriber (this milestone) — into a flow without writing function nodes, without losing connections silently, and with structured types preserved end-to-end.
**Current focus:** Phase 1 — Pre-Work (planned, ready to execute)

## Current Position

Phase: 1 of 4 (Pre-Work)
Plan: 0 of 3 in current phase
Status: Ready to execute
Last activity: 2026-05-08 — Phase 1 plans created (3 plans, wave 1 all parallel)

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: -
- Trend: -

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Init: AMQP transport deferred to v2 (TRP-03/PUB-04/SUB-04); UDP + MQTT cover v1 scope
- Init: Single `opcua-pubsub-connection` config node with `transportType` dropdown (not one node per transport)
- Init: Pre-work (Phase 1) chosen over carrying debt into PubSub — aligns with PITFALLS Option A
- Init: Milestone ships as v0.1.0 (first minor bump; major feature addition on a pre-1.0 base)
- Phase 1 planning: OpcUaClientManager.reconnect(opts) API shape locked (D-01..D-05)
- Phase 1 planning: lib/cert-store.js export surface locked (D-06..D-11)
- Phase 1 planning: docs/MSG-SCHEMA.md structure locked (D-12..D-15)
- Phase 1 planning: test strategy locked (D-16..D-19); LIVE_TESTS env-guard for multi-consumer integration test

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 2: UADP flag-cascade spec reading against Part 14 §7.2.4 + open62541 source recommended before writing encoder (research flag from SUMMARY.md)
- Phase 3: Confirm Mosquitto ≥2.0 version in docker-compose.yml before MQTT transport work
- Phase 3: Multi-NIC UDP multicast behaviour on Linux/Docker requires hands-on acceptance test

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Transport | TRP-03 AMQP 1.0 transport (rhea) | v2 | Init |
| Publisher | PUB-04 AMQP Publisher | v2 | Init |
| Subscriber | SUB-04 AMQP Subscriber | v2 | Init |

## Session Continuity

Last session: 2026-05-08
Stopped at: Phase 1 plans created (3 PLAN.md files); STATE.md updated to Plan 0 of 3
Resume file: None
