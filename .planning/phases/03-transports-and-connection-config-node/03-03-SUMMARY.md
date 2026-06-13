---
phase: 03-transports-and-connection-config-node
plan: 03
subsystem: transport
tags: [mqtt, mqtt5, pubsub, transport, retain, topic-injection, tls]

# Dependency graph
requires:
  - phase: 03-transports-and-connection-config-node
    plan: 01
    provides: BaseTransport abstract class (connect/close/send contract + events vocabulary)
provides:
  - MqttTransport — mqtt.js MQTT 5.0/3.1.1 adapter (extends BaseTransport)
  - Data-topic builder ${topicPrefix}/${publisherId}/${writerGroupId}/${dataSetWriterId} with injection guard
  - retain=false structural guarantee on all data-topic publishes (Part 14 §7.3.4)
affects: [03-04-connection-node, phase-04-publisher-subscriber]

# Tech tracking
tech-stack:
  added: []   # mqtt@^5.15.1 was already installed by an earlier plan
  patterns:
    - "MQTT 5.0 → 3.1.1 fallback: try protocolVersion 5, on protocol-rejection error before first connect retry once with 4; _protocolFallbackDone caps at one v5 + one v4 per connect()"
    - "retain:false as a fresh-object literal in publishOpts — caller opts.retain never read/copied/spread (structural, not advisory)"
    - "Module-level TOPIC_FORBIDDEN regex validates each user-controlled topic component before string concat; throws a real Error synchronously"
    - "mqtt npm module mocked via require.cache overwrite (resolve real path, replace .exports with { connect: stub }) before requiring the transport"
    - "client.end(false, {}, cb) three-arg graceful form, zero-arg callback (Pitfall 4); _client nulled before end() for idempotent close"

key-files:
  created:
    - lib/transports/mqtt-transport.js
    - test/transports/mqtt-transport.test.js
  modified: []

key-decisions:
  - "5→4 fallback trigger (Open Question 1 resolved): regex /unsupported protocol|unacceptable protocol version|protocol version not supported/i, fired only when !_protocolFallbackDone && protocolVersion===5 && before first successful connect — covers Mosquitto/HiveMQ/EMQX wording"
  - "Topic-guard throws a real Error (not createError's plain object) so chai .to.throw and caller try/catch observe a thrown Error; emitted error EVENTS still use createError to match the UdpTransport convention"
  - "rejectUnauthorized is never referenced in code outside comments — even reading config.rejectUnauthorized is avoided (T-03-02), verified by grep + test #5"

requirements-completed: [TRP-02]

# Metrics
duration: ~10min
completed: 2026-06-13
---

# Phase 3 Plan 03: MQTT-UADP/JSON Transport Summary

**Implemented `MqttTransport` (extends BaseTransport): an mqtt.js adapter that connects with MQTT 5.0 and falls back exactly once to 3.1.1 on a broker protocol-rejection error, maps all five native client events onto the transport contract, builds the data-topic `${topicPrefix}/${publisherId}/${writerGroupId}/${dataSetWriterId}` with an injection guard on every user-controlled component, and publishes with `retain: false` HARDCODED so a caller's `opts.retain = true` is structurally ignored. 28 Mocha tests (no real network calls) pass; full suite 477/8 with zero regressions against the 449/8 baseline.**

## Performance
- **Duration:** ~10 min
- **Tasks:** 2 (both TDD: RED test file then GREEN implementation)
- **Files modified:** 2 (both created)

## Accomplishments
- `lib/transports/mqtt-transport.js`: `connect()` calls `mqtt.connect(brokerUrl, { protocolVersion: 5, reconnectPeriod, connectTimeout, clean, username?, password? })`; on a protocol-rejection `error` before the first `connect`, it tears the client down (`client.end(true,{},cb)`) and retries once with `protocolVersion: 4`. `_protocolFallbackDone` is set on either first success or first fallback so the maximum is one v5 + one v4 call per `connect()`.
- Native event mapping: `connect→connected` (once + on each reconnect), `close→disconnected`, `reconnect→reconnecting`, `error→error` (after the fallback decision), `message→message(payload, { topic, packet })` per D-04.
- `close()`: `client.end(false, {}, done)` graceful three-arg form (Pitfall 4), `_client` nulled first for idempotency, and `_protocolFallbackDone` reset so a later `connect()` may fall back again (W-3).
- `send()`: hardcoded `retain: false`, qos resolution `opts.qos > config.qos > 1`, `Buffer | Buffer[]` dispatch via `Array.isArray`, not-connected → `MQTT_SEND_NOT_CONNECTED` error event (no throw), broker publish failure → `MQTT_PUBLISH_ERROR` error event.
- `_buildTopic()` validates `topicPrefix`, `publisherId`, `writerGroupId`, `dataSetWriterId` against `TOPIC_FORBIDDEN` and required-non-empty BEFORE concat; any violation throws `TOPIC_INVALID_CHARACTER` synchronously and nothing is published.
- 28 Mocha tests, all green; mqtt mocked via require.cache injection, every test uses `reconnectPeriod: 0`.

## Task Commits
1. **Task 1: connect/close + event mapping + 5→4 fallback + TLS guard** — `d82151f` (feat)
2. **Task 2: send() with hardcoded retain=false + topic-injection guard** — `35afa75` (feat)

_TDD note: the full test file was authored first and verified RED (MODULE_NOT_FOUND, then 11 send tests red against the Task 2 stub) before each implementation step. Each task is one combined `feat(...)` commit because the executor commits per task._

## mqtt-mock injection mechanism (per output spec)
The `mqtt` npm module is replaced **before** the transport is required:
```js
const mqttPath = require.resolve("mqtt");
const mockMqtt = { connect: sinon.stub() };
require.cache[mqttPath] = { id: mqttPath, filename: mqttPath, loaded: true, exports: mockMqtt };
MqttTransport = require("../../lib/transports/mqtt-transport").MqttTransport; // binds to the stub
```
`mockMqtt.connect` returns a `MockMqttClient extends EventEmitter` whose `publish`/`subscribe` are sinon stubs and whose `end(force, opts, cb)` invokes `cb()` with zero args on the next tick. This is the same cache-injection approach used in `test/connection-sharing.test.js` (Module-level require interception); cache is restored in `after()`. **No real network calls are made.**

## Open Question 1 resolved — 5→4 fallback trigger condition
The fallback fires when **all** hold: `!_protocolFallbackDone` (no fallback or success yet) **AND** the attempt is `protocolVersion === 5` **AND** the native `error` message matches
`/unsupported protocol|unacceptable protocol version|protocol version not supported/i`.
Test #11b parameterizes the three known broker variants ("Unacceptable protocol version" — MQTT 3.1.1 spec language; "Protocol version not supported"; "unsupported protocol") so the regex is proven against Mosquitto/HiveMQ/EMQX wording rather than self-confirming. A protocol-rejection error AFTER a successful connect is **not** a fallback trigger — it is relayed as a normal `error` event.

## Forbidden topic characters enforced (T-03-04)
`TOPIC_FORBIDDEN = /[/+#\x00-\x1F\x7F]/` applied to `topicPrefix`, `publisherId`, `writerGroupId` (after String coercion), and `dataSetWriterId` (after String coercion):
- `/` — MQTT level separator
- `+` — single-level wildcard
- `#` — multi-level wildcard
- `\x00`–`\x1F` — C0 control characters
- `\x7F` — DEL
Plus: `undefined`, `null`, and empty-string components are rejected (required-non-empty). Verified by tests #20–#24.

## Deviations from Plan
None of substance. One intentional clarification applied as deviation Rule 1 (correctness):
- **Topic guard throws a real `Error`, not `createError()`'s plain object.** `createError` in `lib/opcua-utils.js` returns `{ message, error, stack }` — a plain object, not an `Error` instance. `throw`-ing a plain object would make chai's `.to.throw(/.../)` and any caller `instanceof Error` / `err.message` handling brittle. The synchronous topic-injection guard therefore throws `new Error("TOPIC_INVALID_CHARACTER: ...")`. Emitted **error events** (`MQTT_SEND_NOT_CONNECTED`, `MQTT_PUBLISH_ERROR`) still use `createError(...)` to match the established `UdpTransport` convention. Net effect matches the plan's behavior contract exactly (synchronous throw whose message contains `TOPIC_INVALID_CHARACTER`).

## Threat Surface
- **T-03-02 (TLS bypass, CWE-295/319):** mitigated — `rejectUnauthorized` is never assigned in `mqtt.connect` opts (grep shows comment-only matches); Node default TLS validation applies for `mqtts://`. Verified by test #5 (sets `config.rejectUnauthorized=false`, asserts opts arg is `undefined`).
- **T-03-04 (topic injection, CWE-74):** mitigated — `TOPIC_FORBIDDEN` regex on every user-controlled component before concat; throw + no-publish on violation. Verified by tests #20–#24.
- **T-03-06 (retain bypass / insecure default, CWE-732):** mitigated — `retain: false` is a fresh-object literal; `opts.retain` is never read. Verified by test #17 (sets `opts.retain=true`, asserts publish opts `.retain===false`).
- **T-03-07 (socket/client leak, CWE-404):** mitigated — `client.end(false,{},done)` + null-first idempotent close. Verified by tests #13–#15.
- No new security-relevant surface beyond the plan's threat model.

## Known Stubs
None — `connect`, `close`, and `send` are all fully implemented and exercised end-to-end against the mock client.

## User Setup Required
None.

## Next Phase Readiness
- Plan 03-04 (Connection-Node) can `new MqttTransport({ brokerUrl, qos, topicPrefix, username, password, reconnectPeriod, publisherId })` and wrap close in `node.on('close', async (removed, done) => { await transport.close(); done(); })`. Credential redaction in logs (T-03-03) remains 03-04's responsibility — this layer relays raw errors.
- Phase 4 Publisher feeds encoder output (`Buffer | Buffer[]`) to `transport.send(payload, { writerGroupId, dataSetWriterId, qos? })`; Subscriber listens on `transport.on('message', (buf, { topic, packet }) => ...)`.

## Self-Check: PASSED
- Files verified present: `lib/transports/mqtt-transport.js`, `test/transports/mqtt-transport.test.js`, `03-03-SUMMARY.md`
- Commits verified in git log: `d82151f`, `35afa75`
- `mqtt-transport.js` exports `MqttTransport extends BaseTransport`; `instanceof` smoke check prints `true`
- Suite: `npx mocha test/transports/mqtt-transport.test.js` → 28 passing; full suite → 477 passing, 8 pending, 0 failing (baseline 449/8 + 28 new, zero regressions)

## TDD Gate Compliance
- RED: test file verified failing (MODULE_NOT_FOUND for Task 1; 11 send tests red against the Task 2 stub) before each implementation.
- GREEN: implementation added per task; all 28 tests pass.
- REFACTOR: not needed.
- Note: each task is a single combined `feat(...)` commit (executor commits per task); RED→GREEN order was honored during execution.

---
*Phase: 03-transports-and-connection-config-node*
*Completed: 2026-06-13*
