# Pitfalls Research

**Domain:** OPC UA PubSub — Part 14 implementation in Node.js, Node-RED contrib package
**Researched:** 2026-05-08
**Confidence:** HIGH (spec-grounded pitfalls) / MEDIUM (Node.js-specific, Node-RED integration)

---

## Critical Pitfalls

### Pitfall 1: UADP Flag Cascade — Omitting ExtendedFlags1/2 When Encoding

**What goes wrong:**
The UADP NetworkMessage header uses a three-level optional-flag cascade: `UADPFlags` bit 7 gates `ExtendedFlags1`, whose bit 7 gates `ExtendedFlags2`. If a field only reachable through ExtendedFlags2 is needed (e.g., chunking flag, PromotedFields, NetworkMessage type discriminator), the encoder must set both parent flag bytes. The reverse is equally dangerous: if an encoder emits `ExtendedFlags1` with all bits zero just because it is "cleaner", the spec says it SHALL be omitted when UADPFlags bit 7 is false. Receivers that blindly read a fixed header layout instead of checking each gate bit will misparse every subsequent field and silently produce garbage payloads.

**Why it happens:**
Developers hand-write a Buffer layout from a partial read of the spec tables and do not implement the "shall be omitted if parent bit is false" rule correctly. The spec lists fields top-to-bottom as if they are always present; the omission logic is in inline normative text that is easy to miss.

**How to avoid:**
Implement the encoder as a conditional serializer, not a fixed-offset Buffer writer. After encoding all optional flag bytes in a scratch buffer, walk the cascade: if ExtendedFlags2 is all-zero, suppress it and clear the bit in ExtendedFlags1; if ExtendedFlags1 is then also all-zero, suppress it and clear bit 7 of UADPFlags. The decoder must mirror this exactly: check gate bit before reading the next flag byte.

**Warning signs:**
- Interop tests against reference implementations (open62541, UA-.NETStandard) fail at the very first message.
- Decoded PublisherId, GroupHeader, or DataSetWriterId are off by one or two bytes.
- Round-trip tests (encode → decode) pass in isolation but break when testing against a third-party subscriber.

**Phase to address:** Phase 1 — UADP encoder/decoder core. This is the foundation; every other encoding feature builds on top of it.

**References:**
- OPC UA Part 14 v1.05 §7.2.4 — UADPFlags, ExtendedFlags1, ExtendedFlags2 tables
- open62541 PubSub source — `UA_NetworkMessage_encodeBinary` flag cascade

---

### Pitfall 2: RawData Field Encoding — Type Information Loss

**What goes wrong:**
When `DataSetFieldContentMask` specifies `RawData` encoding, field values are written with no type wrapper — no Variant type byte, no DataValue mask. Subscribers that do not have a pre-loaded `DataSetMetaData` for the exact `ConfigurationVersion` cannot decode a RawData stream at all: there are no field names, no types, no array dimension markers in the wire format itself. Additionally, the spec forbids abstract DataTypes (NodeId, ExpandedNodeId, DiagnosticInfo) and requires explicit `MaxStringLength` and `ArrayDimensions` in the MetaData for strings and multi-dimensional arrays. Using abstract types with RawData puts the DataSetReader into error state on the subscriber side.

**Why it happens:**
RawData is appealing for performance (smallest wire size), and developers use it without ensuring the subscriber has a synchronized MetaData record. The interop failure is asymmetric: the publisher's own loopback test works because MetaData is always available locally.

**How to avoid:**
Default all DataSetWriters to Variant encoding unless the user explicitly opts in to RawData. When RawData is enabled, enforce at configuration time that: (a) no abstract types are used, (b) string fields have `MaxStringLength` set, (c) a MetaData publication mechanism is configured. For the subscriber node, treat a RawData message received without matching MetaData as a hard error, not a decode attempt.

**Warning signs:**
- Subscriber emits no output for RawData-encoded publishers from third-party stacks.
- Subscriber silently produces `Field1, Field2, Field3` placeholder names instead of real field names.

**Phase to address:** Phase 1 — UADP encoder. Enforce Variant-only default. Phase 2 — DataSetMetaData management.

**References:**
- OPC UA Part 14 v1.05 §7.2.4 DataSetFlags1 field encoding type bits
- OPC Labs QuickOPC — "Decoding without Metadata" note

---

### Pitfall 3: Delta Frame / Key Frame Mis-configuration Causes Silent Subscriber Stalls

**What goes wrong:**
When a Publisher emits delta frames (`DataSetMessageType = DeltaFrame`), a subscriber that joins after the initial key frame has no complete dataset. Until the next scheduled key frame, the subscriber receives deltas it cannot apply. If `KeyFrameCount` is large (e.g., 1000 intervals of 100 ms = 100 s before a key frame) and no `KeepAlive` is configured, the subscriber's Node-RED output node emits nothing for up to 100 seconds after startup. Users assume the flow is broken.

Second sub-problem: `KeepAliveTime` must be >= `PublishingInterval` per the spec. Setting `KeepAliveTime < PublishingInterval` violates the spec and different implementations handle this inconsistently — some clamp it, some reject the configuration, some silently misbehave.

**Why it happens:**
Delta frames are often enabled for bandwidth reduction without considering subscriber cold-start. `KeyFrameCount` defaults in some stacks are very high. The relationship between `KeepAliveTime` and `MessageReceiveTimeout` on the subscriber side is not obvious — the subscriber timeout must be set longer than `KeepAliveTime` or it will declare the publisher dead during static data periods.

**How to avoid:**
In the Publisher node UI: default `KeyFrameCount = 1` (always key frame) for first-time users; document the trade-off. When `KeyFrameCount > 1`, force-enable `KeepAlive` with a validation warning if it is unset. In the Subscriber node: set `MessageReceiveTimeout = max(3 * KeepAliveTime, 5000 ms)` as the default, expose it as a configurable field, document its relationship to KeepAliveTime.

**Warning signs:**
- Subscriber node output appears after a multi-second delay at startup that matches `KeyFrameCount * PublishingInterval`.
- After a publisher restart, the subscriber goes silent until the next key frame cycle.
- `MessageReceiveTimeout` fires during periods of static data where delta frames are suppressed.

**Phase to address:** Phase 1 — Publisher config (add KeepAlive validation). Phase 3 — Subscriber node (set MessageReceiveTimeout correctly).

**References:**
- OPC UA Part 14 §6.2.5 WriterGroup Parameters — KeepAliveTime minimum = PublishingInterval
- Beckhoff TF6105 PubSub documentation — KeyFrames, DeltaFrames, KeepAlive section
- OPC Labs QuickOPC — "Delta frame buffering" pitfall

---

### Pitfall 4: UDP Multicast — Wrong Socket Bind Address Silently Drops All Incoming Messages

**What goes wrong:**
Node.js `dgram` sockets for multicast must be bound to `0.0.0.0` (all interfaces), not to the multicast group address or the local NIC IP. If the socket is bound to a specific interface IP (e.g., `192.168.1.10`), `socket.addMembership(multicastGroup)` succeeds but the kernel delivers only unicast traffic to that socket; multicast datagrams are silently dropped. There is no error, no warning, and the socket appears fully operational.

Second sub-problem: On multi-NIC hosts (extremely common in OT environments — one NIC on OT network, one on IT network), the OS routes multicast group joins to the default interface, which is often the wrong one. The result: the subscriber joins the group on the IT NIC while the publisher is sending on the OT NIC.

**Why it happens:**
The Node.js `dgram` documentation describes `addMembership(multicastAddress, multicastInterface)` but the default behavior when `multicastInterface` is omitted (OS picks) is not safe for multi-NIC hosts. Node.js issue #1690 confirmed this bind-address vs. multicast interaction is a long-standing gotness.

**How to avoid:**
Always bind the receiver socket to `0.0.0.0` (not to the multicast group address, not to the local IP). Always require the user to specify `NetworkInterface` (NIC IP or name) when the OPC UA PubSub connection has multiple available interfaces. Pass the interface explicitly to `socket.addMembership(groupAddr, localInterfaceAddr)`. In the Subscriber config node UI, surface a field for "Multicast Interface" and make it required when multiple NICs are detected; default to the first non-loopback interface and show the chosen value prominently.

**Warning signs:**
- Publisher and subscriber work on the same machine but fail across two machines.
- Works on a single-NIC VM but fails on a bare-metal host with multiple network cards.
- `tcpdump`/Wireshark shows packets arriving on the wire but no `dgram` events fire.

**Phase to address:** Phase 2 — UDP transport adapter. Interface selection must be first-class, not an afterthought.

**References:**
- Node.js issue #1690 — "no udp multicast message received when binding on a specific address"
- OPC UA Part 14 v1.05 §7.3.2.2 — NetworkInterface required for multi-NIC hosts
- OPC Labs KB — "Network Interface Selection" pitfall

---

### Pitfall 5: MQTT RETAIN Flag on Data Messages Causes Stale Payload Poisoning

**What goes wrong:**
If the MQTT `RETAIN` flag is set on data `NetworkMessage` topics, a newly connected subscriber immediately receives the last published message — which may be minutes or hours old — before any live messages arrive. In OPC UA PubSub, this stale message has the `Timestamp` from when it was originally published. A subscriber that checks timestamps will silently discard all "new" messages whose timestamps are older than `MessageReceiveTimeout`. A subscriber that does not check timestamps will present stale data as current values — a critical correctness problem in industrial automation.

The spec is explicit: the RETAIN flag SHALL NOT be set for data messages. It SHALL be set only for `DataSetMetaData` messages on the metadata topic.

**Why it happens:**
Developers familiar with plain MQTT assume RETAIN is always safe or even desirable (so subscribers see the last value immediately). The OPC UA PubSub restriction is in the spec but not prominently highlighted. Generic MQTT clients used for testing often show retained messages indistinguishably from live ones.

**How to avoid:**
Hard-code `retain = false` in the MQTT publisher for all data topics. Set `retain = true` only for the metadata topic (`<prefix>/json/ua-metadata/<publisherId>` or the configured MetaDataQueueName). Add an assertion / unit test that verifies this. On the subscriber side, log a warning when a received message has the MQTT RETAIN flag set on a data topic (MQTT 5.0 exposes this via message properties).

**Warning signs:**
- Subscriber emits a burst of old data immediately after connecting or redeploying.
- Subscriber stops emitting after receiving one message from the broker (stale timestamp triggers timeout and the node transitions to error state).
- Interop failures with other OPC UA PubSub implementations that correctly reject retained data messages.

**Phase to address:** Phase 2 — MQTT transport adapter. Enforce in code, not documentation only.

**References:**
- OPC UA Part 14 v1.04 §7.3.5 — RETAIN flag rules
- Research finding: "implementations should not set the MQTT RETAIN flag, except for metadata messages"

---

### Pitfall 6: UADP Chunking — MaxNetworkMessageSize vs. UDP MTU Miscalculation

**What goes wrong:**
The UDP MTU for OPC UA UADP is 1472 bytes for IPv4 (1500 - 20 IP header - 8 UDP header) and 1452 bytes for IPv6. If `MaxNetworkMessageSize` is set to 1500 (a common default) without accounting for the IP/UDP headers, the resulting datagrams will be fragmented at the IP layer. IP fragmentation is unreliable in OT networks: many industrial switches drop fragmented packets, and the reassembly timeout at the receiver means partial NetworkMessages are silently lost.

When a single `DataSetMessage` exceeds 65535 bytes, UADP specifies a chunking mechanism (each chunk is a separate NetworkMessage with `ChunkOffset` and `TotalSize` fields in a chunk-specific Payload header). Implementing chunk reassembly requires a per-Publisher, per-SequenceNumber reassembly buffer with expiry. Forgetting expiry causes a slow memory leak whenever a chunk sequence is never completed.

**Why it happens:**
MTU calculation is easy to get wrong by one header. Chunking is a rarely exercised code path in unit tests (most test datasets fit easily in 1 packet) but is triggered in production by large structures or arrays.

**How to avoid:**
Set `MaxNetworkMessageSize = 1400` as the safe default for IPv4 UDP (leaves margin for IP options and tunnel overhead). Expose it as a configurable parameter. Implement chunk reassembly with a 30-second expiry per incomplete sequence. Add a unit test with a synthetic 100 KB DataSetMessage that exercises the chunk encode → reassemble path end-to-end.

**Warning signs:**
- Wireshark shows "IP Fragmentation" or "Fragmented IP protocol" for PubSub packets.
- Large DataSets are silently dropped; small DataSets work fine.
- Memory grows slowly under load when a publisher intermittently sends large messages.

**Phase to address:** Phase 1 — UADP encoder (MTU-safe default). Phase 2 — UDP transport (chunk reassembly with expiry).

**References:**
- OPC UA Part 14 v1.05 §7.3 — "MaxNetworkMessageSize plus additional headers to a MTU size"
- open62541 PubSub docs — MaxNetworkMessageSize IPv4 = 1472, IPv6 = 1452

---

### Pitfall 7: ConfigurationVersion Mismatch Causes Silent Subscriber Decode Failure

**What goes wrong:**
Every `DataSetMessage` carries a `ConfigurationVersion` (MajorVersion + MinorVersion). The subscriber must have a `DataSetMetaData` record whose `ConfigurationVersion.MajorVersion` matches exactly. If the publisher changes its dataset schema (adds or removes fields) and increments MajorVersion, subscribers that have not yet received the updated MetaData enter an error state and stop emitting messages. With static Node-RED configuration (no MetaData exchange channel), this state is permanent: the subscriber silently produces no output and shows no visible error unless status is checked.

**Why it happens:**
Static configuration is common in simple deployments — publishers and subscribers are configured by hand with matching schema. But any schema change by a third-party publisher (firmware update, PLC configuration change) increments MajorVersion, and the Node-RED subscriber's static MetaData becomes stale. There is no automatic recovery path.

**How to avoid:**
Implement the MetaData exchange mechanism (DataSetMetaData discovery message, or MQTT metadata topic) even in the first release. When the subscriber detects a MajorVersion mismatch, set node status to `error` with a descriptive message ("ConfigurationVersion mismatch — awaiting updated MetaData"). Provide a flow-injectable way to push new MetaData (`msg.operation = 'updateMetaData'`). For the MQTT transport, subscribe to the metadata topic automatically and update in-memory MetaData on receipt.

**Warning signs:**
- Subscriber node output stops without any error log after a publisher firmware update.
- Node status shows no error but `msg` output is absent.
- Third-party publisher sends `ConfigurationVersion.MajorVersion` incremented by 1 after a schema change.

**Phase to address:** Phase 2 — DataSetMetaData management and discovery. Phase 3 — Subscriber node status reporting.

**References:**
- OPC UA Part 14 §5.2.3 DataSetMetaData
- open62541 issue #2800 — "PubSub Publisher example, not setting the DataSetMetaData"

---

### Pitfall 8: Security — MessageNonce Reuse Breaks AES-CTR Confidentiality

**What goes wrong:**
OPC UA PubSub security policies `Aes128-CTR` and `Aes256-CTR` derive the AES-CTR counter block from `TokenId || MessageSequenceNumber || SequenceNumber` (or a similar nonce construction — there is an errata on the exact layout). If the `TokenId` does not change at key rotation, or if `MessageSequenceNumber` wraps around to 0 while the same key is in use, the nonce repeats. AES-CTR with a repeated nonce under the same key is catastrophically broken: XORing two ciphertexts encrypted with the same keystream reveals the XOR of plaintexts.

**Why it happens:**
`MessageSequenceNumber` is a UInt16 (0–65535). At 50 ms PublishingInterval, it wraps in ~54 minutes. The spec says "reset to 1 after a key update" but if key rotation (via SKS) is not implemented, the counter wraps with the same key. The errata on nonce construction makes independent implementations diverge.

**How to avoid:**
For Phase 1, document that security policies with encryption are deferred to a dedicated security phase. When implementing: (a) Track `MessageSequenceNumber` per `WriterGroup`; (b) Trigger a key rotation request to SKS before the sequence number reaches 60000 (leaving margin); (c) If no SKS is configured, refuse to use encrypting security policies — only allow `Sign` mode; (d) Read the OPC UA Part 14 errata corrigendum for the exact nonce layout before implementing.

**Warning signs:**
- Decryption failures after ~54 minutes of operation at 50 ms intervals.
- Interop failures with other stacks on the nonce/counter construction even when keys are identical.

**Phase to address:** Phase 4 — PubSub security. Do not ship encryption without addressing this.

**References:**
- OPC UA Part 14 v1.04 §7.2.2.2.3.2 AES-CTR (and errata corrigendum)
- Research finding: "Errata exists for the OPC UA PubSub specification regarding the layout of the MessageNonce for AES-CTR mode"
- RFC 3686 — AES Counter Mode in IPsec (nonce construction reference)

---

### Pitfall 9: SKS Key Rotation — Subscriber Receives Messages Encrypted with Revoked Key

**What goes wrong:**
The Security Key Service (SKS) returns `MaxFutureKeyCount` future keys along with the current key. Publishers call `GetSecurityKeys` at half the `KeyLifetime` interval. If a subscriber has not called `GetSecurityKeys` before the publisher rotates to the next key (by incrementing `TokenId`), the subscriber receives a message it cannot decrypt. The subscriber must use `TokenId` from the SecurityHeader to select the correct key from its cache. If it only holds the current key, messages encrypted with the next key fail to decrypt.

**Why it happens:**
Implementations store only the "current" key rather than the pre-fetched future keys. The race condition between publisher rotation and subscriber fetch is not obvious in local tests where both sides share the same clock.

**How to avoid:**
Pre-fetch and cache at least 3 future keys (or `MaxFutureKeyCount`, whichever is smaller). Key rotation must be based on `TokenId` from the received message, not on a local timer. Implement `MaxPastKeyCount` to cache recent expired keys for late-arriving messages. Provide a test that advances `TokenId` through two rotations and verifies the subscriber correctly decrypts throughout.

**Warning signs:**
- Decryption failures exactly at `KeyLifetime` boundaries.
- Works in 1-minute tests but fails in 30-minute soak tests.

**Phase to address:** Phase 4 — PubSub security. Out of scope for v1 (SKS server not built), but key caching on the client side must be correct.

**References:**
- OPC UA Part 14 §5.4.3 Security Key Service
- OPC UA Part 14 §8 PubSub Security Key Service Model — MaxFutureKeyCount, MaxPastKeyCount

---

### Pitfall 10: Node-RED Deployment Race — UDP/MQTT Socket Opened Before Previous Instance is Closed

**What goes wrong:**
When a Node-RED flow is redeployed, nodes receive `close` events and then new node instances are created. If the `close` handler for a PubSub transport node does not call `done()` only after the underlying socket (UDP `dgram.Socket` or MQTT client) is fully closed, the new instance may attempt to bind the same UDP port or reconnect to the broker while the old socket's OS-level teardown is still in progress. For UDP multicast, the OS may accept the new `bind()` call and leave both sockets joined to the multicast group, causing duplicate message delivery or `EADDRINUSE` errors.

This is a documented Node-RED pitfall: before Node-RED 0.18, `done()` was not reliably awaited; the async close pattern using `this.on('close', function(removed, done) { ... done(); })` is required.

**Why it happens:**
Transport teardown (MQTT `client.end()`, UDP `socket.close()`) is asynchronous. Developers often write `this.on('close', () => { socket.close(); })` without the `done` argument, so Node-RED proceeds immediately without waiting for the socket to fully close.

**How to avoid:**
All PubSub transport nodes must use the three-argument close form: `this.on('close', function(removed, done) { transport.close(() => done()); })`. UDP sockets should be closed with `socket.close(done)` (the callback form). MQTT clients with `client.end(false, done)`. Add a test that redeploys the flow 10 times in rapid succession and asserts no `EADDRINUSE` errors.

**Warning signs:**
- `EADDRINUSE` errors on UDP bind after flow redeploy.
- Duplicate DataSet messages emitted immediately after redeploy.
- MQTT reconnection storms during redeploy sequences.

**Phase to address:** Phase 2 — All transport adapters. Include in acceptance criteria for each transport.

**References:**
- Node-RED issue #2067 — "Node does not wait for done callback on close event"
- Node-RED docs — "JavaScript file: creating nodes" — async close pattern

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Fixed-offset Buffer writer for UADP (no flag cascade logic) | Fast to write, easy to read | Cannot handle optional fields; fails interop with any non-default configuration | Never — flag cascade is fundamental to Part 14 |
| No DataSetMetaData exchange (subscriber requires static schema) | Simpler config; no discovery topic needed | Breaks silently on any publisher schema change; cannot interop with third-party publishers | Only acceptable as an explicit limitation in v1 if clearly documented and detectable |
| No chunk reassembly (drop messages > 1 UDP packet) | Much simpler subscriber code | Silently loses large DataSets on production PLCs with many variables | Only for prototype; must be implemented before any customer deployment |
| Single shared EventEmitter for all WriterGroups | Reuses existing endpoint fan-out pattern | Hard to isolate per-group errors; status changes leak across groups | Never for production; use per-group emitters from the start |
| Copying reconnect retry loop from `opcua-client.js` into PubSub subscriber | Quickest path to working subscriber | Creates a fourth copy of retry logic (already 3 in existing code — see CONCERNS.md §Tech Debt 1) | Never — CONCERNS.md explicitly flags this; consolidate first |
| Storing SKS key as a single `currentKey` rather than a key cache | Simple implementation | Key rotation window causes decryption failures; impossible to fix without subscriber restart | Never for any security-enabled deployment |
| Setting MQTT RETAIN = true on all topics | Subscriber gets "last value" immediately on connect | Stale data presented as live; violates Part 14 spec; rejected by conformant subscribers | Never |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| UDP multicast (dgram) | Bind socket to the multicast group IP or local NIC IP | Always bind to `0.0.0.0`; pass interface explicitly to `addMembership()` |
| UDP multicast (dgram) | Call `addMembership()` once without specifying interface on multi-NIC host | Require explicit `multicastInterface` parameter; validate NIC exists at node startup |
| MQTT (any broker) | Set `retain = true` on NetworkMessage topics | `retain = false` on data topics; `retain = true` only on MetaData topics |
| MQTT broker | Ignore `QoS` setting for OPC UA PubSub messages | Map `BestEffort` → QoS 0, `AtLeastOnce` → QoS 1, `ExactlyOnce` → QoS 2 per Part 14 §7.3.5 |
| MQTT 3.1.1 vs 5.0 | Assume broker supports MQTT 5.0 message properties | Detect broker version; degrade gracefully; MQTT 5.0 required for full metadata in message properties |
| AMQP 1.0 | Use AMQP 0-9-1 routing key conventions (RabbitMQ style) | OPC UA PubSub only defines AMQP 1.0 mapping; AMQP 0-9-1 has no standard mapping |
| AMQP 1.0 | Set the node address without the correct `<prefix>/<encoding>/<messageType>/<publisherId>` hierarchy | Follow Part 14 §7.3.4 node address conventions exactly; mismatched addresses silently lose messages |
| Node-RED deployment | Synchronous close handler without `done()` argument | Use `this.on('close', function(removed, done) { ... done(); })` for all async teardown |
| Node-RED config node | Initializing transport in constructor before `credentials` are available | Defer transport initialization to first `getSharedManager()` call or an explicit `start()` lifecycle |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Allocating a new `Buffer` per NetworkMessage in the encode path | GC pauses at 50 ms publishing intervals; CPU spikes | Pre-allocate a fixed-size encode buffer (e.g., 2 KB) per WriterGroup and reuse it across publishes | At publishing intervals < 200 ms with > 5 WriterGroups |
| Calling `JSON.stringify()` on the full NetworkMessage object for JSON encoding | 3–5x slower than building the JSON string field-by-field | Use `fast-json-stringify` with a pre-compiled schema, or build the JSON string imperatively | At intervals < 100 ms or DataSets > 50 fields |
| Re-joining multicast group on every reconnect without checking membership | EADDRINUSE or kernel multicast table overflow | Track membership state; only call `addMembership()` once per group per socket lifetime | At > 10 redeploys per hour |
| Chunk reassembly buffer growing unbounded | Memory leak visible over hours; Node.js heap size grows monotonically | Add 30-second TTL expiry per incomplete sequence, sweep on each new message arrival | After ~1000 incomplete chunk sequences (network loss scenario) |
| Per-DataSetField `ExtensionObject` round-trip to server for type resolution on every publish | CPU-bound publish loop; publish latency proportional to number of ExtensionObject fields | Cache resolved DataType constructors by `dataTypeNodeId` (mirrors the existing concern in CONCERNS.md §Performance) | At > 5 ExtensionObject fields per DataSet |
| Emitting a Node-RED `msg` per DataSetField rather than per DataSetMessage | Flow becomes unmanageable; downstream nodes receive 100s of msgs per publish interval | Always emit one `msg` per DataSetMessage with `msg.payload` as the full field map; let the user use a Change node to extract individual fields | Immediately, in any flow with > 5 fields |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Using AES-CTR encryption without SKS key rotation | MessageSequenceNumber (UInt16) wraps in ~54 min at 50 ms; repeated nonce breaks CTR mode catastrophically | Refuse encryption-mode security policies unless SKS is configured; or limit to Sign-only in v1 |
| Storing SKS credentials (username/password to call `GetSecurityKeys`) in Node-RED flow JSON | Credentials visible in `flows.json` plaintext | Use Node-RED `credentials` fields (encrypted at rest); scrub after session creation (mirrors CONCERNS.md §Security 3) |
| Reusing the cert upload HTTP endpoint without a size/content validation for PubSub key material | Arbitrary bytes written to disk; disk-fill possible | Apply same size cap (64 KiB) and PEM/DER validation rules recommended in CONCERNS.md §Security 1 |
| Surface DataSetWriterId / WriterGroupId in `node.error()` unmasked in multi-tenant deployments | Internal topology info leaked to Node-RED debug sidebar | Add a sanitisation helper (CONCERNS.md §Security 4 already flags this for PubSub specifically) |
| Accepting unsigned NetworkMessages when `SecurityMode != None` is configured | A network attacker can inject arbitrary DataSet values | On subscriber side, drop unsigned messages when DataSetReader is configured with Sign/SignAndEncrypt |
| Storing SecurityGroup keys in flow context (not credentials) | Key material visible in heap dumps, `util.inspect`, debug sidebar | Always store key material using Node-RED's `credentials` mechanism or in-memory only, never in `flow.json` |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Exposing all 20+ WriterGroup / DataSetWriter parameters in a single config panel | Overwhelming for industrial users who just want "publish this tag over MQTT" | Use a three-tier progressive disclosure: (1) minimal preset, (2) common options, (3) advanced accordion. Default to KeyFrame-only, Variant encoding, no security |
| No visible node status for transport connection state | Users cannot tell if the MQTT/UDP connection is live without injecting a diagnostic message | Always update `node.status()` on connect/disconnect/error; use OPC-UA-style colours already in the codebase |
| Hiding the MQTT topic structure from the user | Users cannot subscribe in parallel from other tools (Wireshark, MQTT Explorer) for debugging | Show the computed topic in the node's info sidebar; make it copyable |
| Requiring users to manually configure matching MetaData on both Publisher and Subscriber nodes | Schema mismatches cause silent failures; hard to diagnose | Auto-exchange MetaData over the metadata topic when transport supports it; show ConfigurationVersion in node status |
| Accepting `msg.operation = 'publish'` as the only trigger model | Industrial users expect the publisher to run autonomously on a timer, not to be triggered by flow messages | Support both: timer-driven (autonomous publish on `PublishingInterval`) and msg-triggered (manual publish via `msg` injection). Make timer-driven the default |
| Treating PubSub subscriber as a "fire and forget" node with no start/stop control | No way to pause/resume subscription without redeploying | Support `msg.operation = 'start'` / `'stop'` / `'status'` on the subscriber node, consistent with how the existing `opcua-client` handles operations |

---

## "Looks Done But Isn't" Checklist

- [ ] **UADP encoder:** Verify the encoder suppresses ExtendedFlags1/2 when all their bits are false. Test with a minimal-flags packet (no PublisherId, no GroupHeader, no security) against a third-party decoder.
- [ ] **Delta frame handling:** Verify the subscriber correctly handles the state where it receives delta frames before the first key frame. Output must be suppressed (not empty-payload) until a key frame arrives.
- [ ] **MQTT retain flag:** Verify the publisher never sets RETAIN on data topics. Use MQTT 5.0 message properties or a broker-side trace to confirm.
- [ ] **UDP bind address:** Verify the subscriber socket is bound to `0.0.0.0`, not to the multicast group address. Test on a multi-NIC host with the wrong NIC selected to confirm the error is surfaced, not silently ignored.
- [ ] **Node-RED close handler:** Verify each transport node's `close` handler passes `done` and calls it only after the socket/client is fully closed. Confirm by doing 20 rapid redeploys without `EADDRINUSE`.
- [ ] **ConfigurationVersion display:** Verify the subscriber node's status panel shows the current `MajorVersion.MinorVersion` it expects so users can diagnose mismatches.
- [ ] **KeepAlive validation:** Verify the publisher config node rejects (or warns) when `KeepAliveTime < PublishingInterval`.
- [ ] **MTU-safe default:** Verify `MaxNetworkMessageSize` defaults to ≤ 1400 bytes for UDP transport, not 1500 or higher.
- [ ] **SequenceNumber monotonicity:** Verify the encoder increments the sequence number per message, resets on key rotation, and that the decoder tolerates UInt16 wrap-around (65535 → 0) without treating the wrap as a duplicate.
- [ ] **Inherited CONCERNS.md items:** Verify PubSub manager does NOT copy `forceReconnect` from `opcua-client.js` (3rd copy). Verify cert upload reuses the existing HTTP endpoint with the existing size/validation guards. Verify `DataSetWriterId` is not leaked in `node.error()` calls.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| UADP flag cascade bug found after shipping | HIGH | Requires encoder rewrite + version bump; all existing flows must be re-tested; third-party interop broken until fix deployed |
| Wrong MQTT RETAIN flag shipped | MEDIUM | Hot-fix publisher node; users must flush broker retained messages manually (`mosquitto_pub -r -n -t <topic>`) |
| UDP bind address bug (specific IP instead of 0.0.0.0) | LOW | One-line fix; redeploy; no persistent state affected |
| Delta frame cold-start not handled | LOW | Add key-frame-wait state to subscriber; existing flows continue working (just with slightly different startup behaviour) |
| ConfigurationVersion mismatch with no recovery path | MEDIUM | Add `msg.operation = 'updateMetaData'` endpoint to subscriber; users need to inject new MetaData manually until automatic MetaData exchange is built |
| AES-CTR nonce wrap shipped with encryption enabled | HIGH | Must rotate all keys immediately; all encrypted subscribers must redeploy with new SKS configuration; potential data confidentiality breach |
| Chunk reassembly memory leak | MEDIUM | Add expiry sweep in a patch release; existing deployments restart Node-RED to clear accumulated buffers |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| UADP flag cascade (Pitfall 1) | Phase 1 — UADP encoder | Round-trip test + third-party interop test (open62541 or UA-.NETStandard subscriber decodes messages correctly) |
| RawData type information loss (Pitfall 2) | Phase 1 — UADP encoder; Phase 2 — MetaData management | Unit test: RawData without MetaData produces `node.error`, not silent empty output |
| Delta frame subscriber stall (Pitfall 3) | Phase 1 — Publisher config validation; Phase 3 — Subscriber | Integration test: subscriber joins mid-stream with delta publisher; output suppressed until first key frame |
| UDP multicast bind address (Pitfall 4) | Phase 2 — UDP transport adapter | Test on dual-NIC host; wrong NIC config → visible error; right NIC → messages received |
| MQTT RETAIN flag (Pitfall 5) | Phase 2 — MQTT transport adapter | Unit test: publisher MQTT options have `retain: false` for data topics; integration test with MQTT 5.0 broker confirming flag |
| UDP MTU / chunking (Pitfall 6) | Phase 1 (MTU default); Phase 2 — UDP transport | Unit test: encode 100 KB DataSet → N chunks; decode chunks in order → original dataset; decode with out-of-order chunk → partial output handled |
| ConfigurationVersion mismatch (Pitfall 7) | Phase 2 — MetaData management; Phase 3 — Subscriber | Test: send DataSetMessage with MajorVersion = subscriber's version + 1 → node status = error with descriptive message |
| AES-CTR nonce reuse (Pitfall 8) | Phase 4 — Security | Unit test: MessageSequenceNumber rollover with same TokenId detected and treated as error; encryption refused without SKS |
| SKS key rotation race (Pitfall 9) | Phase 4 — Security | Integration test: advance TokenId × 2 across key boundary; subscriber decrypts successfully using pre-fetched keys |
| Node-RED deployment race (Pitfall 10) | Phase 2 — All transports | Automated redeploy × 20 without EADDRINUSE; Mocha redeploy harness |

---

## Cross-Reference: CONCERNS.md Items Inherited by PubSub

The following items from `.planning/codebase/CONCERNS.md` are directly inherited or amplified by the PubSub milestone. Each maps to a pitfall or phase concern above.

| CONCERNS.md Item | PubSub Inheritance | Mitigation in PubSub Phases |
|------------------|-------------------|------------------------------|
| Reconnect logic split (Tech Debt §1) **[PubSub-impacted]** | PubSub subscriber needs reconnect semantics for MQTT/AMQP; without consolidation creates 3rd copy of retry loop | Phase 1 pre-work: move retry into a shared `OpcUaPubSubManager`, do not copy `forceReconnect` pattern |
| Subscription handling in consumer (Tech Debt §3) **[PubSub-impacted]** | DataSetReader monitoring is conceptually identical to `ClientMonitoredItem`; would become 4th duplicate | Phase 1 pre-work: introduce `manager.subscribeDataSet()` abstraction |
| Subscription survival across reconnect (Fragile §5) **[PubSub-impacted]** | DataSetReader subscriptions must survive MQTT/AMQP reconnect; same unsolved problem as classic subscriptions | Phase 3 — Subscriber: add `manager.on('connected', resubscribe)` handler; test with broker restart |
| Ref-count hysteresis (Performance §1) **[PubSub-impacted]** | PubSub nodes are ref-holders; redeploy without hysteresis causes extra transport disconnect storms | Phase 2 — All transports: add 500 ms grace period on last-ref-release |
| Error-message string matching (Fragile §1) **[PubSub-impacted]** | PubSub will add new error strings (DataSet decode failure, WriterGroup unreachable); grows the brittle OR-chain | Phase 1 pre-work: introduce status-code-based error classification before adding PubSub strings |
| Pre-1.0 schema churn (Dependencies §3) **[PubSub-impacted]** | PubSub introduces `msg.dataSet`, `msg.writerGroup`, `msg.networkMessage` top-level fields; schema churn compound | Phase 0 (before any PubSub code): freeze and document existing `msg.*` schema as 1.0 API |
| Cert upload validation (Security §1) | PubSub key material upload reuses same HTTP endpoint; same size/MIME risks | Phase 4 — Security: apply existing size + PEM/DER validation to PubSub key upload path |
| NodeIds reflected in `node.error()` (Security §4) **[PubSub-impacted]** | DataSetWriterId / WriterGroupId will flow into error messages the same way | Phase 3 — add sanitisation helper before PubSub nodes emit their first error messages |
| HTML cert dropzone duplication (Maintenance §3) **[PubSub-impacted]** | PubSub config node needs cert/key dropzone; consolidate now or create 3rd copy | Phase 4 — Security: extract shared `setupKeyUpload()` helper before building PubSub security UI |

---

## Sources

- [OPC UA Part 14: PubSub v1.05 — UADP Message Mapping §7.2.4](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.2.4)
- [OPC UA Part 14: PubSub v1.05 — UDP Multicast §7.3.2.2](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.3.2.2)
- [OPC UA Part 14: PubSub v1.04 — MQTT §7.3.5](https://reference.opcfoundation.org/Core/Part14/v104/docs/7.3.5)
- [OPC UA Part 14: PubSub v1.04 — AMQP §7.3.4](https://reference.opcfoundation.org/Core/Part14/v104/docs/7.3.4)
- [OPC UA Part 14: PubSub v1.05 — JSON Message Mapping §7.2.5](https://reference.opcfoundation.org/Core/Part14/v105/docs/7.2.5)
- [OPC UA Part 14: PubSub v1.04 — Security Key Service §5.4.3](https://reference.opcfoundation.org/Core/Part14/v104/docs/5.4.3)
- [OPC UA Part 14: PubSub v1.04 — WriterGroup Parameters §6.2.5](https://reference.opcfoundation.org/Core/Part14/v104/docs/6.2.5)
- [OPC Labs KB — OPC UA PubSub Traps And Pitfalls](https://kb.opclabs.com/OPC_UA_PubSub_Traps_And_Pitfalls)
- [OPC Labs KB — OPC UA PubSub Common Traps And Pitfalls](https://kb.opclabs.com/OPC_UA_PubSub_Common_Traps_And_Pitfalls)
- [open62541 PubSub documentation (master)](https://open62541.org/doc/master/pubsub.html)
- [OPC Foundation UA-.NETStandard — PubSub.md](https://github.com/OPCFoundation/UA-.NETStandard/blob/master/Docs/PubSub.md)
- [Beckhoff TF6105 — KeyFrames, DeltaFrames, KeepAlive](https://infosys.beckhoff.com/content/1033/tf6105_tc3_opc_ua_pub_sub/10407882251.html)
- [Node.js issue #1690 — UDP multicast bind address bug](https://github.com/nodejs/node/issues/1690)
- [Node-RED issue #2067 — close event done() not awaited](https://github.com/node-red/node-red/issues/2067)
- [Unified Automation Forum — PubSub UDP Multicast](https://forum.unified-automation.com/viewtopic.php?t=8123)
- [open62541 issue #2800 — DataSetMetaData not set](https://github.com/open62541/open62541/issues/2800)
- [Prosys OPC UA Forum — Issue with PubSub UDP](https://forum.prosysopc.com/forum/opc-ua-client/issue-with-pubsub-with-udp/)
- [Node-RED docs — JavaScript file / async close pattern](https://nodered.org/docs/creating-nodes/node-js)
- RFC 3686 — AES Counter Mode (nonce construction reference)

---
*Pitfalls research for: OPC UA PubSub in Node-RED (node-red-contrib-opcua-suite)*
*Researched: 2026-05-08*
