# OPC UA PubSub — Skeptical Code Review

**Reviewed:** 2026-06-13
**Scope:** PubSub layer (publisher, subscriber, connection, transports, encoders, pubsub-config)
**Method:** Full read + executed round-trip probes (UADP single/multi/chunk, JSON) outside the mock harness.
**Reviewer:** Claude (code review only — no source files modified)

Two dead paths were already fixed before this review (publisher send-opts; MQTT subscribe).
This review found **two further critical correctness bugs that mock-based unit tests
structurally cannot catch** (both involve the real encode→transport→decode byte path),
plus several high/medium issues.

---

## Critical

### CR-01 — Chunked UADP messages are undeliverable (reassembly produces a non-NetworkMessage buffer) — FIXED

> **FIXED:** `encodeNetworkMessage` now chunks the full encoded NetworkMessage (header + body) instead of `Buffer.concat(dsmBuffers)`, so UDP reassembly reconstructs it byte-for-byte and the subscriber decodes it directly (forced-chunking round-trip test added).


**Files:** `lib/transports/udp-transport.js:208-212`, `lib/uadp-encoder.js:872-905`, `nodes/opcua-subscriber.js:215-220`

**Scenario (verified by execution):** Any NetworkMessage whose encoded size exceeds the
MTU is split by `encodeNetworkMessage` into chunk NetworkMessages. Each chunk's `chunkData`
is a slice of `Buffer.concat(dsmBuffers)` — i.e. **raw concatenated DataSetMessage bodies**,
with NO NetworkMessage flag header. On receive, `udp-transport._onDatagram` reassembles those
slices and emits the concatenated buffer as `'message'`. The subscriber then calls
`decoder.decodeNetworkMessage(reassembled)`. That buffer starts with a DataSetMessage
`DataSetFlags1` byte, not a `UADPFlags` byte, so decode fails:

```
chunks: 4
assembled 5024 total 5024 COMPLETE
RE-DECODE FAILED: UADP_DECODE_UNSUPPORTED_VERSION: expected 1, got 9
```

The reassembled payload is the *inner* DSM stream; it can never be decoded as a top-level
NetworkMessage. Result: **every message large enough to chunk is silently dropped** at the
subscriber (it surfaces only as a "PubSub decode error" log). Mock unit tests that stub the
transport or test the encoder/decoder in isolation never exercise reassembly →
re-decode, so this slipped through.

**Fix (choose one, the layer mismatch must be resolved):**
- Make the chunk `chunkData` be slices of the *full encoded NetworkMessage* (header + body)
  instead of `Buffer.concat(dsmBuffers)`, so that reassembly yields a complete NetworkMessage
  the subscriber can decode directly; OR
- Have the UDP transport, after reassembly, wrap/decode the inner payload using a metadata-aware
  path that reconstructs the NetworkMessage from the first chunk's already-decoded header
  (the chunk decode at `udp-transport.js:158` already has `partial.publisherId`,
  `partial.groupHeader`, `partial.payloadHeader`) and the reassembled DSM bytes, then emit a
  domain object rather than a raw buffer. Whichever path is chosen, add a round-trip test that
  forces chunking (payload > mtu) and asserts the subscriber emits the original field values.

---

### CR-02 — JSON (MQTT-JSON) never encodes `writerGroupId`; subscribers filtering by writerGroupId drop every message — FIXED

> **FIXED:** `encodeNetworkMessage` now emits NM-level `WriterGroupId` and `SequenceNumber` from `groupHeader`, and `decodeNetworkMessage` reconstructs `nm.groupHeader = { writerGroupId, sequenceNumber }`, so a writerGroupId-filtered MQTT-JSON subscriber is delivered the message (round-trip test strengthened to filter on writerGroupId and assert delivery).

**Files:** `lib/json-encoder.js:211-229` (encode), `lib/json-encoder.js:262-267` (decode),
`nodes/opcua-subscriber.js:153-158` (filter)

**Scenario (verified by execution):** The publisher always builds
`groupHeader.writerGroupId` (`opcua-publisher.js:171-174`), but `encodeNetworkMessage` in the
JSON encoder emits only `MessageId / MessageType / PublisherId / Messages` — there is **no
group header and no `WriterGroupName`/group id** on the wire. On decode, `nm.groupHeader` is
`undefined`, so in the subscriber `writerGroupId = nm.groupHeader && ...` is `undefined`.
A DataSetReader that filters on `writerGroupId` (a normal, often-required filter) then hits:

```
reader.writerGroupId !== undefined && reader.writerGroupId !== undefined  → true → continue
```

so **every JSON DataSetMessage is filtered out** and nothing is delivered. The only JSON
subscribers that work today are those filtering solely on `publisherId` and/or
`dataSetWriterId`.

```
decoded groupHeader: undefined   (writerGroupId lost)
```

**Fix:** Carry the writer-group identity in the JSON form. Per Part 14 §7.2.5 the group id is
conveyed via `WriterGroupId`/`WriterGroupName` (group-header network message header). Emit
`writerGroupId` (and optionally the NM `SequenceNumber`) in `encodeNetworkMessage`, and
reconstruct `nm.groupHeader = { writerGroupId, sequenceNumber }` in `decodeNetworkMessage`.
Add a JSON round-trip test that filters by `writerGroupId` and asserts delivery.

---

## High

### HI-01 — NetworkMessage `timestamp` is lost over JSON; `msg.timestamp` is fabricated at decode time — FIXED

> **FIXED:** `encodeNetworkMessage` now emits the NM-level `Timestamp` (ISO-8601, Part 14 §7.2.5) and `decodeNetworkMessage` restores it into `nm.timestamp`, so the subscriber (which already prefers `dsm.timestamp`/`nm.timestamp` before `new Date()`) emits publish time on JSON, matching UADP.

**Files:** `lib/json-encoder.js:211-229`, `nodes/opcua-subscriber.js:199-200`

**Scenario:** The publisher sets `timestamp: new Date()` at the NetworkMessage level for both
UADP and JSON, but the JSON encoder only serializes a *per-DataSetMessage* `Timestamp`
(`_encodeDataSetMessage`, line 147), and the publisher never sets `dsm.timestamp`. So over JSON
neither `dsm.timestamp` nor `nm.timestamp` survives, and the subscriber falls through to
`new Date()` (decode wall-clock). `msg.timestamp` therefore reflects *receipt* time, not
*publish* time — silently wrong, and inconsistent with the UADP path (which does carry
`nm.timestamp`). Any downstream latency/ordering logic is corrupted.

**Fix:** Emit the NetworkMessage timestamp in the JSON form and decode it back into
`nm.timestamp`, or have the publisher set `dsm.timestamp` so the existing per-DSM JSON path
carries it. Pick one and make UADP and JSON agree.

### HI-02 — Cross-transport type inconsistency for `publisherId` and `sequenceNumber` — FIXED

> **FIXED:** The JSON encoder no longer `String()`-coerces `PublisherId`; it preserves the source JS type (number → JSON number, string → string, BigInt → decimal string), and decode returns the native type — so `msg.publisherId` is the same type on UADP and JSON. `msg.sequenceNumber` is now the NM `groupHeader.sequenceNumber` on both transports (the subscriber already prefers the NM seq, now present on JSON via the CR-02 fix).

**Files:** `lib/json-encoder.js:220` (`String(publisherId)`), `nodes/opcua-subscriber.js:199`

**Scenario:** JSON encodes `PublisherId` as `String(...)`, so a numeric publisherId `5`
decodes (and is emitted in `msg.publisherId`) as the **string** `"5"`; the UADP path emits the
**number** `5`. Likewise `msg.sequenceNumber` is the NM sequence over UADP but the DSM sequence
over JSON (CR-02 side effect). A flow that does `msg.publisherId === 5` works on UADP and breaks
on MQTT-JSON. The reader *filter* itself is safe (it `String()`-coerces both sides), but the
*emitted* msg shape is transport-dependent, violating the "exact D4-09 shape" contract.

**Fix:** Normalize `msg.publisherId` to a single documented type regardless of transport
(e.g. preserve the original publisherIdType, or always string), and document
`msg.sequenceNumber` semantics; align JSON and UADP.

### HI-03 — Cyclic "no change" detection is a one-shot dirty flag, not value comparison; KeepAlive can be emitted while values are unchanged-but-present, and a single input永久 marks dirty — FIXED

> **FIXED:** Replaced the one-shot `_dirty` flag with real change detection. The publisher now keeps `_publishedSnapshot` (the field values of the last emitted keyframe); each cyclic tick deep-compares the accumulated `_latestValues` to that snapshot — unchanged → KeepAlive, changed (or nothing published yet) → keyframe + snapshot refresh. A value re-sent equal to the last published one no longer forces a keyframe. `_latestValues` semantics documented inline (accumulates latest value per field from inbound msgs).

**File:** `nodes/opcua-publisher.js:108-110, 236-251, 261-267`

**Scenario:** The cyclic path sets `node._dirty = true` on *every* inbound msg
(`Object.assign(node._latestValues, sourceValues); node._dirty = true;`) and clears it after one
keyframe. There is **no deep compare** of field values (the prompt's KeepAlive concern):
- If the same value arrives repeatedly, each still flips `_dirty` and forces a keyframe — the
  KeepAlive path is only taken when *no* input arrived in an interval, not when values are
  *unchanged*. That is arguably acceptable, but it is NOT "no field value changed" detection as
  documented.
- More importantly, `_latestValues` is **never reset**, so once any field is seen it is
  re-published in every subsequent keyframe even if the producer stopped sending it. Combined
  with the partial-merge semantics, a field can never be "removed", and a stale value is
  re-emitted indefinitely.

**Fix:** If real change detection is intended, keep a snapshot of last-published values and
deep-compare to decide keyframe vs keepalive. At minimum, document that `_dirty` is
"input-arrived-since-last-interval", not "value changed", and decide whether `_latestValues`
should be cleared per publish.

### HI-04 — UInt16 sequence-number wrap throws and (in cyclic mode) silently stops publishing — FIXED

> **FIXED:** `_nmSeq` and each `_dsmSeq[id]` now wrap modulo `0x10000` at increment (`(n + 1) & 0xFFFF`) in both the keyframe and KeepAlive builders, so a long-running publisher rolls 65535 → 0 (spec-correct UInt16 wraparound) instead of overflowing `writeUInt16LE`.

**Files:** `nodes/opcua-publisher.js:105-106, 151, 187, 190`, `lib/uadp-encoder.js:559, 704`

**Scenario:** `_nmSeq` and `_dsmSeq[id]` increment without bound. The UADP encoder writes them
with `writeUInt16LE`, which throws a `RangeError` once a counter exceeds 65535 (verified). In
**acyclic** mode the input-handler catch logs and red-statuses (degraded but visible). In
**cyclic** mode the `setInterval` callback catch logs every tick but the interval keeps firing
and **every subsequent publish throws** — the node is wedged red and emits nothing, with a log
line per interval, until redeploy. Sequence numbers are explicitly UInt16 in UADP and WILL wrap
in any long-running publisher (65536 messages at 100 ms = ~1.8 h).

**Fix:** Wrap the counters modulo 0x10000 at increment (`node._nmSeq = (node._nmSeq + 1) &
0xFFFF`), and same for `_dsmSeq`. UInt16 wraparound is the spec-correct behavior for PubSub
sequence numbers.

### HI-05 — Publisher acquires the transport with no paired release on the status-callback / setup error window, and the input handler can throw before `node.transport` exists — FIXED

> **FIXED:** Sections 7-9 (the post-acquire setup window) are now wrapped in a try/catch that, on any throw, releases the transport and unregisters the status callback before red-statusing — so a setup failure no longer leaks a transport ref. Pre-connect sends are gated on a `_connected` flag set from the status fan-out: an inbound publish before 'connected' is queued (most-recent NetworkMessage only) and flushed on 'connected', so the first inject is not silently lost. Chosen behavior: **queue-and-flush** (most-recent pending publish), preferable for acyclic so the first inject survives. Behavior documented inline.

**File:** `nodes/opcua-publisher.js:140-143, 226-232, 285-297`

**Scenario:** `acquireTransport()` (line 143) runs *after* all the early-return guards
(connection, encoding, config), so the guard returns themselves are safe (no acquire yet — good).
However, between `acquireTransport()` (143) and registration of the `close` handler (285) there
is no try/catch; if anything in section 7-9 threw synchronously during construction (e.g. a
malformed `node.writers[0]` — guarded, but future edits), the transport would be acquired with
the `close` handler never registered, leaking one ref permanently (the grace timer never starts
because refCount never returns to 0). The acquire is currently safe *given* the present code, but
it is **fragile**: any throw added after line 143 and before the `close` registration leaks a ref.

Separately, `_emit` (230) calls `node.transport.send(...)`. If `acquireTransport` returned the
shared transport but `connect()` is still pending (it is kicked off async and not awaited,
`connection.js:199-203`), an early input/interval `send` on UDP hits
`UDP_SEND_NOT_CONNECTED` (emitted as 'error', surfaced red) — tolerable — but on MQTT a
pre-connect `send` hits `MQTT_SEND_NOT_CONNECTED` and the message is **dropped** with only an
error event. There is no buffering or readiness gate.

**Fix:** Wrap sections 5-9 in try/catch that, on error, releases the transport and unregisters
the status callback before red-statusing — mirror the section-4 pattern. Gate `_emit` on a
"connected" flag (set from the status callback) and either drop-with-warn or queue until
connected; at minimum document the pre-connect drop.

---

## Medium

### ME-01 — `createError()` returns a plain object, not an `Error`; thrown as exceptions in several places

**Files:** `lib/opcua-utils.js:155-161`; thrown via `throw createError(...)` in
`lib/uadp-encoder.js` (many), `lib/json-encoder.js` (many), `lib/pubsub-config.js`

**Scenario:** `createError` returns `{ message, error, stack }` — not an `Error` instance.
Code that does `throw createError(...)` throws a non-Error. Consumers that rely on
`err instanceof Error`, `Error.captureStackTrace`, or proper stack traces (Node-RED's logger,
`done(err)` in the publisher input handler at line 278) get a degraded object. `e.message`
access happens to work everywhere it is used, so this is not currently a crash — but it is a
latent trap: `done(e)` with a non-Error, and any future `instanceof Error` check, will misbehave.
The config factories also attach `err.code`/`err.errors` to this plain object, which is fine but
non-standard.

**Fix:** Have `createError` return a real `Error` (e.g. `const e = new Error(message); e.cause =
error; return e;`) or introduce a dedicated `class PubSubError extends Error`. Keeps `.message`
working and fixes `instanceof`/stack/`done(err)` semantics.

### ME-02 — Publisher `groupHeader` omits `groupVersion`/`networkMessageNumber`; encoder writes `undefined` as 0 silently

**Files:** `nodes/opcua-publisher.js:171-174, 199-203`, `lib/uadp-encoder.js:554-560`

**Scenario:** The publisher's `groupHeader` is `{ writerGroupId, sequenceNumber }`. The encoder
unconditionally writes `gh.groupVersion` and `gh.networkMessageNumber` with `writeUInt32LE` /
`writeUInt16LE`. `writeUInt32LE(undefined)` does **not** throw — it writes `0` (verified). So
`groupVersion` is silently 0 on the wire. That is benign for the loopback round-trip but means
the publisher cannot ever convey a real GroupVersion, and the "flags derived from field presence"
contract is violated (a missing field is written as a present zero rather than suppressed).

**Fix:** Either have the publisher populate these fields explicitly, or make the encoder default
them (`gh.groupVersion || 0`) intentionally and document that they are always emitted. Relying on
`writeUInt32LE(undefined) === 0` is accidental behavior.

### ME-03 — Subscriber `statusCode` default of `0` conflates "no status" with "Good", and UADP status is UInt16 while StatusCode is UInt32

**Files:** `nodes/opcua-subscriber.js:201`, `lib/uadp-encoder.js:705, 766`

**Scenario:** `statusCode: dsm.status !== undefined ? dsm.status : 0`. In OPC UA, StatusCode is a
UInt32 where 0 = Good, so defaulting absent status to 0 is defensible but means a consumer cannot
distinguish "publisher omitted status" from "explicitly Good". Separately, the UADP
DataSetMessage `status` field is encoded/decoded as **UInt16** (`writeUInt16LE`/`readUInt16LE`),
which truncates a real 32-bit StatusCode — only the low 16 bits survive. (The Variant/DataValue
StatusCode codecs correctly use UInt32; the DSM header `Status` field does not.)

**Fix:** Confirm the Part 14 DSM `Status` field width; if it is the 16-bit "Good/Bad/Uncertain"
summary, document that `msg.statusCode` is a 16-bit summary, not a full StatusCode. Do not silently
present a truncated value as a 32-bit StatusCode.

### ME-04 — UDP multicast input is untrusted but decoded fields are used to build map keys / sizes without validation beyond bounds — FIXED

> **FIXED:** Reassembly now rejects `totalSize` beyond `mtu * MAX_CHUNKS` (256), rejects any chunk whose `offset+length` exceeds `totalSize`, and verifies the sorted chunks tile `[0, totalSize)` exactly (no gap/overlap) before concatenating; failures drop the entry and emit `'warn'`.


**File:** `lib/transports/udp-transport.js:176, 195-206`, `lib/uadp-encoder.js:991-996,
1008-1011`

**Scenario:** Decode is bounds-checked (good — truncation throws), and the reassembly map is
bounded/swept (good). But a malicious datagram can still steer reassembly: `totalSize` is taken
from the *attacker's* chunk (`partial.chunk.totalSize`) and a key is formed from attacker
`publisherId|writerGroupId|messageSequenceNumber`. An attacker can (a) declare a small `totalSize`
and a `chunkOffset`/`chunkData` that, after sort+concat, yields an arbitrary buffer that is then
re-decoded (see CR-01 — currently this just fails, but once CR-01 is fixed the reassembled buffer
is fed to a full decode), and (b) spray distinct keys to churn the 1000-entry map (rate-limited by
the overflow guard, acceptable). The `assembled >= totalSize` completeness check sums lengths but
does not verify offsets are contiguous/non-overlapping, so overlapping or gapped chunks can
complete with a mis-sized/mis-ordered buffer. Low exploitability today, but worth hardening before
CR-01 is fixed (after which decoded bytes flow into a second decode pass).

**Fix:** When fixing CR-01, validate `totalSize` against a sane max (e.g. `mtu * MAX_CHUNKS`),
verify chunk offsets are non-overlapping and cover `[0, totalSize)` exactly before concatenating,
and reject `chunkData.length` that would exceed `totalSize`. The subscriber decode is already
try/caught, which contains the blast radius.

### ME-05 — Grace-timer close races a concurrent `send`/`message` on the same transport instance

**Files:** `nodes/opcua-pubsub-connection.js:165-228`, `udp-transport.js:126-137`,
`mqtt-transport.js:228-260`

**Scenario:** On `releaseTransport()` reaching refCount 0, a 500 ms timer fires and calls
`_sharedTransport.close()`. `acquireTransport()` cancels a *pending* timer, but it does not cancel
a close that is **already in flight** (the timer callback nulls `_graceTimer` first, then awaits
`close()`). If a re-acquire lands after the timer fired but before/while `close()` resolves,
`_sharedTransport` is set to `null` inside the callback *after* close completes, but a new
`acquireTransport` in that window sees `_sharedTransport` still non-null (close hasn't nulled it
yet) and returns the **closing** transport. A subsequent `send` then hits
`*_SEND_NOT_CONNECTED` (handled as 'error', not a crash) and inbound `message` may arrive on a
socket about to close. Not a crash, but messages can be lost in the redeploy window the grace
timer was meant to protect.

**Fix:** In the grace timer callback, re-check refCount before closing
(`if (node._refCount === 0 && node._sharedTransport)`), and null `_sharedTransport` *before*
awaiting `close()` so a concurrent acquire creates a fresh instance rather than reusing a closing
one. Guard `acquireTransport` against returning a transport whose `close()` has begun.

### ME-06 — Config validation surfaces only the FIRST error; `publishingInterval` NaN path and non-array `writers` JSON — FIXED

> **FIXED:** After `JSON.parse`, the publisher asserts `Array.isArray(rawWriters)` and throws a clear "writers must be a JSON array" error for non-array JSON (e.g. `"{}"`) instead of the cryptic `rawWriters.map is not a function`. The config catch block now surfaces the full collected `err.errors` list (joined messages) rather than only `errors[0].message`.

**Files:** `nodes/opcua-publisher.js:56-95`, `lib/pubsub-config.js:104-110`

**Scenario:** `Number(config.publishingInterval)` of an empty/garbage field yields `NaN`;
`validateWriterGroup` correctly rejects (`MUST_BE_POSITIVE_NUMBER`) and the publisher catches →
red status (good). But: if `config.writers` is a JSON string that parses to a **non-array**
(e.g. `"{}"`), `rawWriters.map` throws `TypeError: rawWriters.map is not a function`, which is
caught by the same try/catch and surfaced as a generic "config error" — acceptable, though the
message is unhelpful (`...map is not a function`). Malformed JSON (`JSON.parse` throw) is likewise
caught. So construct-time invalid input does **not** crash the node — it red-statuses, which
satisfies the requirement. The gap is only message quality and the missing "writers must be an
array" explicit check.

**Fix:** After `JSON.parse`, assert `Array.isArray(rawWriters)` with a clear error; surface the
collected `err.errors` list rather than only `errors[0].message` for better operator feedback.

---

## Low

### LO-01 — Publisher `done(e)` receives a non-Error (see ME-01)
`nodes/opcua-publisher.js:278` — `done(e)` where `e` may be a `createError` plain object.
Node-RED expects an Error. Cosmetic until ME-01 is fixed.

### LO-02 — Dead/confusing encoding default expression — FIXED

> **FIXED:** Simplified the no-op ternary to `config.messageEncoding || "uadp"` in both `opcua-publisher.js` and `opcua-subscriber.js` (UADP is the intentional default for every transport; JSON must be explicitly chosen and is MQTT-only).

`nodes/opcua-publisher.js:36-37` and `opcua-subscriber.js:37-38`:
`config.messageEncoding || (conn.transportType === "udp" ? "uadp" : "uadp")` — both branches of
the ternary are `"uadp"`, so the conditional is a no-op. Either intentional (MQTT also defaults to
UADP) — in which case simplify to `config.messageEncoding || "uadp"` — or a latent bug if MQTT was
meant to default to `"json"`. Clarify intent.

### LO-03 — `unwrap` mis-handles a legitimate field whose value is itself an object containing a `value` key
`nodes/opcua-subscriber.js:118-127`: a Variant carrying a struct value `{ value: 1, other: 2 }`
matches the DataValue branch (`w.value && "value" in w.value`) and is unwrapped to the inner
`value`, losing data. Phase-1 scope is scalars, so low risk, but the heuristic is ambiguous.
Prefer explicit shape tagging (e.g. check for `dataType` to detect Variant) over duck-typing.

### LO-04 — `setMulticastLoopback(true)` means a co-located publisher's own datagrams loop back
`lib/transports/udp-transport.js:87`: with loopback on, a publisher+subscriber sharing one
connection node will receive their own frames. Combined with no source filtering, a node can
consume its own publications. May be intended for the round-trip test; confirm for production.

### LO-05 — MQTT subscribes to `${prefix}/#` — every publisher on the prefix is received and filtered in software
`lib/transports/mqtt-transport.js:135`: correct for the shared-transport design, but means QoS and
bandwidth scale with *all* traffic under the prefix, and software filtering is the only access
control. Acceptable; note it.

---

## What was checked and found SAFE (no change needed)

- **Subscriber decode errors do not escape the EventEmitter callback** — `onMessage`
  (`opcua-subscriber.js:215-226`) wraps decode + handle in try/catch; a malformed datagram logs
  and returns, keeping the shared transport and siblings alive. UDP `_onDatagram` independently
  try/catches decode. Verified.
- **Subscriber close ordering** — `removeListener('message')` runs before `releaseTransport()`,
  each in its own try/catch, so an early throw cannot skip listener removal
  (`opcua-subscriber.js:232-249`). Verified.
- **Publisher interval is cleared on close** including after node error (the interval is only
  created after successful setup, and `close` clears it unconditionally). The cyclic interval's
  own try/catch prevents an unhandled throw from killing the interval.
- **MQTT topic-injection guard** (`mqtt-transport.js:50, 65-74, 196-209`) validates every
  user-controlled component (prefix, publisherId, writerGroupId, dataSetWriterId) against
  `/ + # \x00-\x1F \x7F` before concat, and rejects empty/undefined. `retain:false` is a fresh
  literal never sourced from caller opts — not overridable. `rejectUnauthorized` is never copied
  from config. Verified by reading.
- **Credentials never logged** — `_redactConfig` strips `password`/`userName` (top-level and
  `credentials.*`) before the only diagnostic that includes config
  (`opcua-pubsub-connection.js:47-57, 146-152`). MQTT opts set username/password but never log
  them.
- **UADP positional dataSetWriterId mapping** — decode leaves per-DSM `dataSetWriterId` undefined
  and the subscriber falls back to positional `payloadHeader.dataSetWriterIds[i]`; verified the
  multi-writer size-array path preserves order and ids.
- **UADP bounds checking** — `_ensureRead` guards every read; array/string length-prefixed reads
  are bounded by remaining buffer; truncated input throws a structured error rather than
  over-reading.
- **Reassembly DoS guards** — 1000-entry cap (drop-oldest + 'warn') and 30 s expiry sweep on every
  receive bound attacker memory growth (modulo the offset-overlap gap noted in ME-04).
- **Refcount cannot go negative** — `releaseTransport` uses `Math.max(0, refCount - 1)`.

---

## Priority summary

| ID | Sev | One-line |
|----|-----|----------|
| CR-01 | critical | FIXED — Chunked UADP reassembly yields a DSM-level buffer the subscriber cannot decode → all over-MTU messages dropped |
| CR-02 | critical | FIXED — JSON now carries WriterGroupId + NM SequenceNumber; writerGroupId-filtered MQTT-JSON subscribers receive messages |
| HI-01 | high | FIXED — NM timestamp now emitted + decoded over JSON; msg.timestamp is publish-time, matching UADP |
| HI-02 | high | FIXED — JSON preserves publisherId type (no String() coercion); sequenceNumber is the NM seq on both transports |
| HI-03 | high | FIXED — published-snapshot deep-compare drives keyframe-vs-KeepAlive; equal re-sends no longer force a keyframe |
| HI-04 | high | FIXED — _nmSeq/_dsmSeq wrap modulo 0x10000; long-running publisher rolls 65535→0 instead of throwing |
| HI-05 | high | FIXED — setup try/catch releases transport on throw; pre-connect sends queued and flushed on 'connected' |
| ME-01 | medium | createError returns a plain object, not Error — degrades done(err)/instanceof/stack |
| ME-02 | medium | groupVersion/networkMessageNumber written as silent 0 (writeUInt32LE(undefined)) |
| ME-03 | medium | DSM status encoded as UInt16 (truncates 32-bit StatusCode); default 0 conflates "absent" with "Good" |
| ME-04 | medium | FIXED — Reassembly trusts attacker totalSize/offsets; no overlap/coverage check (hardens once CR-01 fixed) |
| ME-05 | medium | Grace-timer close races a re-acquire/send — messages lost in the redeploy window |
| ME-06 | medium | FIXED — Array.isArray guard gives a clear "writers must be a JSON array" error; full err.errors list surfaced |
