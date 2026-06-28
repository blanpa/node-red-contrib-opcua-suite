# Changelog

## Unreleased

## 0.1.4 (2026-06-28)

### Changed

- **`opcua-client`: resolved operation on every output** – every output message (including the error output) now carries the resolved operation in `msg.operation` — `"read"`, `"write"`, `"browse"`, `"method"`, `"history"`, … (lower-cased), or the more specific `"readmultiple"` / `"writemultiple"` when a batch ran. Previously only the multiple/subscribe variants set it, so a downstream **switch** node could not reliably branch on single read/write/browse. Existing flows are unaffected — the field is only added where it was missing.

## 0.1.3 (2026-06-28)

### Added

- **`opcua-item`: full OPC UA scalar DataType set** – the per-item **DataType** dropdown now covers all scalar types, grouped for readability: booleans/integers, floating point (`Float`/`Double`), text/time (`String`, `DateTime`, `LocalizedText`, `QualifiedName`, `XmlElement`) and binary/identifier types (`ByteString`, `Guid`, `NodeId`, `StatusCode`). Previously only 14 numeric/text types were offered. The DataType is used for writes only; reads always return the server's type. The item-row fields were also enlarged for easier editing.
- **`opcua-item`: optional Operation** – new **Operation** dropdown (Read / Write / Subscribe / Unsubscribe) sets `msg.operation` so the downstream client knows what to do without separate configuration. Default *don't set* preserves an existing `msg.operation` / the client's default operation.
- **`opcua-client` & `opcua-item`: unwrap single read value** – new **Unwrap single value** option (`unwrapSingle`, default off on the client; checkbox on the item node sets `msg.unwrapSingle`). When a read resolves to exactly one item, the scalar value is returned in `msg.payload` (e.g. `false`) with its metadata flattened onto `msg`, instead of a one-element array (`[{value:false, …}]`). `msg.unwrapSingle` overrides per message; reads of two or more items are unaffected.

## 0.1.2 (2026-06-22)

### Added

- **Benchmark & stress-test harness** (`test-server/benchmark.js`, `npm run bench` / `bench:quick`) – drives the real `OpcUaClientManager` against the bundled test server and reports throughput + latency percentiles + error counts for read / readMultiple / write, plus resilience phases (connect/disconnect churn and reconnect-under-load with forced session loss) and a subscribe stress phase. Steady-state phases must be error-free; the reconnect phase is judged on recovery rate.
- **`opcua-client`: connect on deploy** – new **Connect on deploy** option (`autoConnect`, default on) so the node establishes the shared connection immediately and its status reflects the real connection state instead of staying "not connected" until the first message.
- **`opcua-client`: bounded operation retry** – new **Operation Retries** (`maxOperationRetries`, default 3) and **Retry Backoff** (`retryBackoffMs`, default 100 ms, capped at 2 s) options. A connection-lost operation is now retried multiple times with exponential backoff instead of exactly once.
- **`opcua-endpoint`: optional session pool** – new **Session Pool** option (`poolSize`, default 1). With `poolSize > 1`, stateless operations round-robin across N sessions (`lib/opcua-pool.js`); subscriptions and registered nodes stay on the primary member. Default `poolSize 1` keeps the single-shared-session behaviour byte-for-byte unchanged.

### Fixed

- **Reconnect storm under high concurrency left ~0.2% of in-flight operations unrecovered.** Three changes drive recovery to 100% in the reconnect-under-load benchmark: (1) the client node's bounded retry above; (2) a reconnect cool-down in `OpcUaClientManager` (`reconnectCooldownMs`, default 250 ms) so a redundant `reconnect()` arriving right after a successful one — while still connected — is a no-op instead of forcing another teardown+connect that briefly flips `isConnected` to false under other operations; (3) wider connection-lost classification — `_isConnectionLostError()` now also matches the channel-teardown abort ("Transaction has been canceled because client channel is being closed") and `BadSessionClosed` / `BadSessionIdInvalid` / `BadConnectionClosed` / `BadSecureChannelClosed`, so those are retried rather than surfaced as failures.

## 0.1.0 (2026-06-13)

### Added — OPC UA PubSub (v0.1.0 milestone)

A complete, purely additive OPC UA PubSub Publisher/Subscriber layer — zero breaking changes to the existing eight Client/Server nodes. ([#13](https://github.com/blanpa/node-red-contrib-opcua-suite/issues/13))

- **`opcua-publisher` node** – references an `opcua-pubsub-connection`, declares one WriterGroup with one or more DataSetWriters (each bound to a PublishedDataSet), and publishes in **acyclic** (msg-driven: one `msg.payload` field map → one NetworkMessage) or **cyclic** mode (one `setInterval` per WriterGroup at `PublishingInterval`, sending a KeepAlive NetworkMessage when no field value changed between ticks). Encoding (`uadp`/`json`) is selectable; UDP rejects JSON at startup.
- **`opcua-subscriber` node** – references an `opcua-pubsub-connection`, declares one DataSetReader filtering on PublisherId/WriterGroupId/DataSetWriterId, decodes received NetworkMessages (UADP or JSON), and emits one `msg` per matched DataSetMessage with `payload` plus `publisherId`, `writerGroupId`, `dataSetWriterId`, `sequenceNumber`, `timestamp`, `statusCode`, `encoding`, `transport`, and `topic` (MQTT only). A ConfigurationVersion mismatch surfaces as a visible `node.error()` and is never silently dropped.
- **`opcua-pubsub-connection` config node** – owns the transport lifecycle with ref-counted acquire/release + a 500 ms grace timer (so rapid redeploys reuse the same socket), fans out `connected`/`disconnected`/`reconnecting`/`error` status to worker nodes, and reuses the drag-and-drop cert dropzone. `transportType` dropdown (UDP / MQTT) and a String/UInt16/UInt32/UInt64 PublisherId.
- **UDP-UADP transport** – `dgram` multicast with `reuseAddr`, multicast loopback, chunk reassembly (30 s expiry + 1000-entry overflow guard), and clean `socket.close(done)` teardown (no `EADDRINUSE` across 20 rapid redeploy cycles).
- **MQTT transport** – MQTT 5.0 with one-shot fallback to 3.1.1, `retain: false` hard-coded on data topics (not caller-overridable), topic-injection guard, and graceful `client.end(false, …)` close. Credentials via the Node-RED credentials block.
- **UADP binary encoder/decoder** (`lib/uadp-encoder.js`) – NetworkMessage + DataSetMessage codec with the full ExtendedFlags1/2 cascade, all PublisherId variants, three field encodings (Variant/RawData/DataValue), and sender-side chunking against a 1400-byte MTU. Verified across all 8 flag-presence combinations.
- **JSON encoder/decoder** (`lib/json-encoder.js`) – Part 14 §7.2.5 JSON NetworkMessage codec with deterministic field order and structured decode errors.
- **Config-object layer** (`lib/pubsub-config.js`) – validate+factory hybrids for WriterGroup / DataSetWriter / PublishedDataSet / DataSetReader with frozen returns and cross-field validation (e.g. `KeepAliveTime ≥ PublishingInterval`).
- **Round-trip + redeploy tests** – Mocha round-trip coverage for all three shipped combinations (UDP-UADP, MQTT-UADP via in-process `aedes` broker, MQTT-JSON), a 20-cycle redeploy acceptance test, and confirmation of the 8-combination UADP flag matrix. (Open62541 byte-for-byte reference capture is a tracked manual follow-up.)
- **Three example flows** – `10 - PubSub UDP-UADP Loopback` (self-contained, no external infrastructure), `11 - PubSub MQTT-UADP`, and `12 - PubSub MQTT-JSON`, all validated by the example-flow harness.
- **Two comprehensive self-asserting validation flows** (GitHub repo, target the bundled Docker test stack) – `13 - PubSub Full Validation` (9 PubSub scenarios) and `14 - Full Suite Validation` (24 tabs exercising every node, classic + PubSub). Both were run live against a real Node-RED + test server + MQTT broker with every tab reporting `PASS`.
- **README PubSub section** – configuration hierarchy, full `msg` shape, the UDP-only-UADP rule, and the multicast NIC-selection caveat.

### Changed

- **Unified palette presentation** – all draggable OPC UA nodes now share a single `opcua-suite` palette category and the same suite color (`#3a8cba`), so the Client/Server and the new PubSub nodes group and render consistently.
- **Example flows now ship in the npm package** – the user-facing example flows (`01`–`12`) are now included in the published package so **Import → Examples → node-red-contrib-opcua-suite** works after `npm install` (previously the whole `examples/` directory was excluded). Internal planning/review artifacts (`.planning/`, `REVIEW.md`) are excluded from the package.

### Fixed

- **Browse results capped at the server's per-browse limit (e.g. 100 items on S7-1500)** – Neither the client manager's `browse()` nor the browse-client editor tree followed OPC UA continuation points. Servers with a low `MaxReferencesPerNode` (the S7-1500 returns at most 100 references per Browse response) silently truncated the result. All browse paths (`opcua-browser`, `opcua-client` browse operation, and the `opcua-browse-client` editor tree including its unfiltered fallback browse) now call `browseNext` until the server has returned all references, with a safety cap against servers that never exhaust their continuation point. ([#14](https://github.com/blanpa/node-red-contrib-opcua-suite/issues/14))
- **Failed browses shown as empty folders** – A Browse response with a bad status code (e.g. `BadNodeIdUnknown`) was indistinguishable from a legitimately empty folder in the browse-client editor tree. The HTTP API now returns the status code as an error, and `OpcUaClientManager.browse()` throws instead of returning an empty list, so missing nodes (e.g. DBs without "accessible from OPC UA" enabled in TIA Portal) are diagnosable. ([#14](https://github.com/blanpa/node-red-contrib-opcua-suite/issues/14))

### Added

- **Continuation-point tests** – 11 new unit tests covering multi-page browses (100+100+42 references), `browseNext` keep-alive semantics (`releaseContinuationPoints=false`), the misbehaving-server safety cap, bad-status surfacing, and the fallback browse pagination.

## 0.0.7 (2026-04-18)

### Fixed

- **`opcua-server`: "expecting a valid port (number)" when changing the port** – Node-RED stores values from `<input type="number">` fields as strings in the flow JSON. The server node forwarded `config.port` (as well as `maxAllowedSessionNumber` and `maxConnectionsPerEndpoint`) directly to `node-opcua`, which validates the port strictly as a JS number and threw `expecting a valid port (number)`. The default `4840` worked because it came from a number literal in the code, so the bug only surfaced as soon as the user edited the port in the editor. All three values are now coerced via `parseInt(..., 10)` with a safe fallback to the defaults. ([#11](https://github.com/blanpa/node-red-contrib-opcua-suite/issues/11))

### Added

- **Regression tests for `opcua-server` config coercion** – 3 new unit tests verifying that string port from the editor is coerced to number, and that invalid/empty ports fall back to `4840`.

## 0.0.6 (2026-04-16)

### Fixed

- **Reconnect on low-level connection errors** – In addition to `"Session is no longer valid"` and `"Not connected"`, the retry path now also triggers on `premature disconnection`, `Secure Channel Closed`, `Server end point are not known yet`, `connection may have been rejected`, and `socket has been disconnected`. Previously these errors went straight to the catch block without reconnect and produced `msg.payload: undefined` in the debug panel. ([#9](https://github.com/blanpa/node-red-contrib-opcua-suite/issues/9))
- **Retry covers `ensureConnected()` failures** – The retry wrapper now also handles connection setup errors, not just errors thrown inside `executeOperation()`. This makes the recovery transparent when the first re-read after a server restart fails at the connect step.
- **Single-flight reconnect lock** – A shared `reconnectPromise` prevents multiple parallel `forceReconnect` calls when several messages (e.g. from a 2s continuous-read inject) arrive during an outage. Only one reconnect runs at a time; concurrent messages wait for it.

### Added

- **Infinite reconnect by default** – The retry loop now retries forever with exponential backoff (2s, 4s, 6s, … capped at 30s). Continuous-read flows recover automatically from server restarts of arbitrary length.
- **`Retry Attempts` setting** (Advanced Settings) – Configurable per node. `0` (default) = infinite; positive values bound the number of retries per message.
- **`Verbose Log` checkbox** (node settings) – Toggles `[warn]` logging of `Connection lost …`, `Reconnect attempt N/∞ failed …`, and `Reconnected to OPC UA server (attempt N/∞)` messages. Operation errors (`[error]`) are always logged.
- **Retry tests for new error patterns** – 2 new unit tests covering `"premature disconnection"` and `"Secure Channel Closed"` reconnect paths.

### Changed

- **`opcua.svg` icon** – Larger, vertically centered `OPC UA` label (font size 9 → 13, `dominant-baseline="central"`) for improved readability in the flow editor.

## 0.0.5 (2026-04-16)

### Fixed

- **Automatic retry on session loss** – When an OPC UA session becomes invalid mid-operation (e.g. server restart, network interruption), the client now automatically reconnects and retries the operation once instead of failing immediately. Previously the current message was lost and only the *next* message would trigger a reconnect. ([#9](https://github.com/blanpa/node-red-contrib-opcua-suite/issues/9))
- **Force full reconnect on retry** – The retry path now tears down and rebuilds the connection unconditionally (`forceReconnect`), fixing a race condition where `isConnected` could remain `true` with a stale session when multiple nodes share the same connection.
- **`hasBeenClosed` called as function** – `session.hasBeenClosed` in node-opcua is a method, not a property. The previous code treated it as a boolean, causing every session to appear closed (functions are truthy). Now correctly called as `hasBeenClosed()` with a fallback for property access.

### Changed

- **`opcua-client`** – Refactored input handler into `executeOperation()`, `forceReconnect()`, `ensureConnected()` and `isSessionInvalidError()` for cleaner retry logic. Node status transitions through yellow/reconnecting before returning to green/connected on success.

### Added

- **Session retry tests** – 12 new unit tests covering retry on read/readmultiple/write, reconnect failure, non-session error passthrough, reconnect counter reset, status transitions, and stale-session race conditions.
- **Integration tests** – 5 end-to-end tests with a real OPC UA server that verify session kill → reconnect → retry for read, readMultiple, write, and full Node-RED node flow simulation.

## 0.0.4 (2026-04-12)

### Added

- **Operation timeouts** – `OpcUaClientManager` wraps critical async work with configurable timeouts and clearer failure behaviour.

### Changed

- **`opcua-client-manager`** – Fallback reads for non-Variable nodes when the primary read returns `BadAttributeIdInvalid`; improved handling of invalid sessions during reconnect; read/readMultiple error propagation aligned with tests.
- **`opcua-client`** – Reconnect attempt counter resets on user-triggered messages to avoid stuck reconnect loops.
- **CI** – npm Trusted Publishing workflow uses Node.js 24 as required by npm for OIDC publishes.

### Fixed

- Edge cases around session validity and reconnect after connection loss.

## 0.0.2 (2026-03-16)

### Added

- **ExtensionObject support** – Full read/write support for OPC UA ExtensionObjects and structured types in `opcua-client` and `opcua-browse-client`
- **Address space browser enhancements** – Expose structured types and fields in the `opcua-browse-client` editor tree

### Changed

- **`opcua-browse-client`** – Significant rewrite for structured type browsing and improved editor UX
- **`opcua-client`** – Updated with new endpoint settings and ExtensionObject-aware read/write logic
- **`opcua-client-manager`** – Improved datatype detection, ExtensionObject serialization, and connection handling
- **`opcua-utils`** – Extended with complex value support and improved parsing


## 0.0.1 (2026-03-06)

### Initial Release

- **opcua-endpoint** - Configuration node for OPC UA server connections
- **opcua-client** - Read, write, and subscribe to OPC UA variables
- **opcua-item** - Define OPC UA items (nodeId, datatype)
- **opcua-server** - Expose Node-RED as an OPC UA server
- **opcua-event** - Subscribe to OPC UA events
- **opcua-method** - Call OPC UA methods
- **opcua-browser** - Browse the OPC UA address space (config node)
- **opcua-browse-client** - Browse the OPC UA address space (flow node)
- Shared connection management via `opcua-client-manager`
- Utility functions in `opcua-utils`
