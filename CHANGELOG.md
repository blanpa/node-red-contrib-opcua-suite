# Changelog

## Unreleased

## 0.2.0 (2026-08-28)

A connection-lifecycle and code-review release. The headline fix closes
**issue #17**; a full review of the client/server/editor layer (the PubSub layer
was already covered by `REVIEW.md`) surfaced a further 20 defects, all fixed
here. See `REVIEW-CLIENT-SERVER.md` for the complete findings with evidence.

Validated against a real Node-RED 5.0.4 / Node.js 24 container talking to the
bundled OPC UA test server over `opc.tcp`, not only the mock-based unit suite:
`14 - Full Suite Validation` (24 tabs, every shipped node, all three PubSub
transport/encoding combinations) passes 24/24, repeated redeploys hold the
session count flat, and a server-side session kill recovers on the first retry
with subscriptions intact.

**This release contains breaking changes** — see below before upgrading.

### Breaking

- **`opcua-server`: `msg.func` is now opt-in.** The `addMethod` command
  evaluates the JavaScript body in `msg.func` via `new Function()`. Unlike a
  Function node that code arrives with the **message**, so any upstream node fed
  from outside (`http in`, MQTT, …) was a remote-code-execution path into the
  Node-RED process. Enable **Allow method code from `msg.func`** under
  *Security* in the server node to keep using it; `addMethod` without `msg.func`
  is unaffected.
- **`opcua-client` / `opcua-browser`: `browse` now follows
  `HierarchicalReferences` only** — the same filter the editor tree and
  node-opcua's own default use. Passing a BrowseDescription object bypassed that
  default and returned *every* reference type, mixing `HasTypeDefinition` /
  `HasSubtype` links into the children of an address-space browse. Set
  `msg.referenceTypeId = null` to opt back into the old behaviour.
- **`opcua-client` / `opcua-browser`: `nodeClass` is emitted as a name**
  (`"Variable"`) instead of the raw `NodeClass` enum number, matching the Browse
  Client node.

### Fixed

- **Sessions leaked on every redeploy until the server refused new connections
  (issue #17).** `OpcUaClientManager.connect()` had no single-flight lock, but
  every consumer node calls `connect()` on the *shared* manager when its flow is
  deployed. All those calls passed the `isConnected` check in the same tick and
  each built its own `OPCUAClient` + session; only the last assignment survived
  in `this.client` / `this.session`, so every earlier session was orphaned —
  still open on the server, kept alive by `keepSessionAlive`, and invisible to
  `disconnect()`. With three client nodes a redeploy leaked two sessions, which
  accumulated until the server answered *"connection was rejected by the
  server"*. `connect()` now shares one in-flight attempt, `disconnect()` awaits
  a connect that is still running, a session refused after the secure channel is
  up tears that channel down, and `after_reconnection` closes the session it
  replaces.
- **The editor's browse connection had the same race.** Parallel expand requests
  in the address-space tree each built their own manager and overwrote the cache
  entry, orphaning the rest. Browse connections are now single-flighted per
  endpoint, a failed connect is not cached, and they are closed on runtime stop
  instead of lingering until the 60 s idle timer.
- **`opcua-server`: `setValue` only ever worked on `Double` variables.** The
  handler resolved the target type with `DataType[msg.datatype || node.dataType]`,
  but `UAVariable.dataType` is a `NodeId` object, so that lookup was always
  `undefined` and every datatype-less `setValue` silently became a `Double` —
  which node-opcua then rejected with *"the provided variant must have the
  expected dataType"*. The variable's declared type is now resolved via
  `addressSpace.findCorrespondingBasicDataType()`, with inference from the JS
  value as a last resort. An explicit `msg.datatype` still wins.
- **`opcua-server`: a fast redeploy could leave the port bound.** `startServer()`
  was fire-and-forget and `close()` did not await it, so a close landing between
  `new OPCUAServer()` and `await server.start()` made `shutdown()` fail while
  `start()` went on to bind the port — with no reference left to release it, the
  next deploy hit `EADDRINUSE`.
- **`opcua-server`: `addVariable` with `Byte` / `SByte` defaulted to `null`.**
  The `getDefaultValue` switch used `DataType.Int8` / `DataType.UInt8`, which do
  not exist in node-opcua (the names are `SByte` / `Byte`), so those cases fell
  through to `null` instead of `0`.
- **`opcua-browse-client` and `opcua-event`: subscriptions died after a
  reconnect.** The `session_recreated` handling that fixed issue #15 in
  `opcua-client` was never applied to these two nodes, so after a server-side
  session timeout they held handles bound to the dead session and silently
  stopped delivering. Both now drop the stale handles and rebuild on the fresh
  session; the Event node remembers its request for replay and stops replaying
  after an explicit `unsubscribe`.
- **`opcua-browse-client`: subscribe mode never connected on its own.** A flow
  whose only OPC UA node was a subscribe-mode Browse Client stayed at
  *"not connected"* forever, because subscriptions were only set up in reaction
  to a `connected` event that nothing triggered.
- **`opcua-event`: the configured event type was ignored.** It was read into a
  variable and then discarded — every event type was delivered regardless of the
  setting. It is now translated into an `OfType` where-clause, and an unknown
  type name is reported instead of silently dropped.
- **`opcua-browser`: recursive browsing produced no children.** The recursion
  compared `ref.nodeClass === 'Object'`, but `nodeClass` is a `NodeClass` enum
  value, so the comparison was always false and `children` was always `[]`. The
  walk now also carries a visited set, so a shared subtree cannot be traversed
  repeatedly.
- **`parseNodeId` truncated String identifiers containing `;`.**
  `ns=2;s=Line1;Motor` parsed to `Line1`, because the parser split on every `;`
  and took `parts[1]`. Only the first separator is significant now. A
  non-numeric namespace (`ns=abc;…`) is rejected instead of yielding `NaN`.
- **`PooledClientManager.write()` dropped `arrayType`.** The delegation forwarded
  only four of the manager's five parameters, so with `poolSize > 1` every array
  write silently degraded to a scalar.
- **`getEndpoints()` leaked its discovery channel** when the call threw — the
  `disconnect()` was not in a `finally`.
- **An operation timeout no longer costs a message.** `_withTimeout` already
  marks the connection dead, but the timeout message matched none of the
  connection-lost patterns, so the retry loop skipped the reconnect and failed
  the message outright; the *next* message then reconnected and succeeded.
- **`opcua-client`: `subscribe` now serialises ExtensionObjects** like `read`
  does, so a struct variable yields the same plain-JSON payload either way. The
  same applies to `readAttribute`.
- **`opcua-client`: unsubscribing the last item terminates the subscription**
  instead of leaving an empty one for the server to keep publishing keep-alives
  for.
- **Connection errors are surfaced in the Browser / Event / Method nodes.** They
  received the error object and dropped it, leaving a red status dot with no
  explanation anywhere.
- **`serializeExtensionObject` guards against cycles and unbounded depth** —
  this walks decoded network input, where an unbounded recursion would take the
  process down with a stack overflow rather than yielding a bad message.

- **`opcua-server` container was permanently `unhealthy`.** The service reuses
  the `nodered/node-red` image but replaces the entrypoint with the OPC UA test
  server, so it inherited that image's `HEALTHCHECK` — a probe of Node-RED's
  HTTP port that nothing in the container answers. Both compose files now
  override it with a TCP probe of port 4840. `docker-compose.yml` consequently
  upgrades `depends_on` from `service_started` to `service_healthy`, so
  Node-RED no longer races the OPC UA server's startup on the first deploy.
- **The dev stack had no MQTT broker.** The validation flows
  `13 - PubSub Full Validation` and `14 - Full Suite Validation` address one as
  `mqtt://val-mosquitto:1883`, and `README.md` told you to run them against
  `docker-compose.dev.yml` — which never provided it, so the MQTT PubSub tabs
  (T2, T3) could not pass as documented. `docker-compose.dev.yml` now ships an
  anonymous `eclipse-mosquitto` service under the service name the flows
  expect.

### Security

- **All six HTTP admin routes now require a Node-RED admin permission.** The
  certificate upload/list/delete routes (registered under both
  `/opcua-endpoint` and `/opcua-pubsub-connection`) and the two
  `/opcua-browse-client` routes had no `RED.auth.needsPermission` guard, so they
  stayed reachable unauthenticated even with `adminAuth` configured — allowing
  file writes under the user directory and OPC UA connections to configured
  endpoints. Writes require `flows.write`, reads `flows.read`; a pass-through is
  used where `RED.auth` is unavailable.
- **Certificate uploads enforce the extension whitelist on write**, not only
  when listing — previously anything could be written and would simply be
  invisible in the UI.
- **`msg.func` is opt-in** (see *Breaking*).
- **Dev private keys removed from the repository.** `data/opcua-certs/` held
  real RSA private keys for the dev container and is now git-ignored.
  ⚠️ They remain in the git history — rotate them if they were ever used
  anywhere but the local dev container.
- **`ip-address` pinned to `^10.5.0`** via `overrides` (reached through
  `mqtt` → `socks`), closing the SSRF / trust-boundary advisories. The remaining
  `npm audit` findings are devDependency-only (mocha's `diff` /
  `serialize-javascript`); the published dependency tree is clean.

### Added

- **`opcua-endpoint`: configurable operation timeout.** The manager always
  honoured `config.operationTimeout`, but nothing passed it in, so the 10 s
  default was unreachable from the editor. A slow batch read on a PLC could
  exceed it, which marked the connection dead and tore down an otherwise healthy
  session on the next message.
- **`opcua-endpoint`: the endpoint URL is validated at deploy time** instead of
  failing later as an opaque node-opcua connect error.
- **`opcua-endpoint`: the `reconnected` manager event is forwarded** to status
  callbacks; it was previously swallowed.

### Changed

- **Dependencies updated**: `node-opcua` 2.163 → 2.179, `mqtt` 5.15.1 → 5.15.2,
  `aedes` 1.0.2 → 1.1.1, `mocha` 10 → 11, `sinon` 17 → 22, `prettier` 3.8 → 3.9,
  `eslint` 8 → 9. `chai` stays on 4.x — 6.x is ESM-only and the suite is
  CommonJS.
- **`npm run lint` actually runs.** The repo declared the script but shipped no
  ESLint config at all, so it failed with *"ESLint couldn't find a configuration
  file"*; the glob also only covered `lib/*.js` and silently skipped
  `lib/transports/`. Added `eslint.config.js` (flat config) covering
  `nodes/`, `lib/` and `test/`, and cleaned up the ~35 findings it reported
  (dead imports, unused parameters).

### Tests

- `test/connect-single-flight.test.js` — the issue #17 leak, proven by counting
  opened vs. closed sessions across concurrent connects, redeploy cycles, a
  disconnect racing an in-flight connect, and a session refused after the
  channel is up. Plus the pool's `arrayType` forwarding.
- `test/opcua-server-setvalue.test.js` — `setValue` without `msg.datatype`
  against a **real** node-opcua server for `Boolean` / `Int32` / `String` /
  `Double`, the `Byte` / `SByte` defaults, and the `msg.func` opt-in gate.
- `test/node-reconnect-resilience.test.js` — `session_recreated` rebuilds for the
  Browse Client and Event nodes, subscribe-mode auto-connect, the event-type
  where-clause, and the editor browse-connection single-flight.
- `test/review-fixes.test.js` — `parseNodeId` semicolons, serializer recursion
  guards, the admin-permission guards and extension whitelist, the browse
  reference-type default, timeout classification, and `getEndpoints` cleanup.

### Documentation

- **`docs/MSG-SCHEMA.md` covered eight of the eleven shipped nodes.**
  `opcua-pubsub-connection`, `opcua-publisher` and `opcua-subscriber` shipped
  in 0.1.0, but the reference was never updated and still listed their fields
  under *"Reserved for v0.1.0 (PubSub)"* — reserving names that never
  materialised (`msg.dataSet`, an `amqp` transport) while omitting the ones
  that did. All three nodes now have real sections matching the
  implementation.
- **Every source citation in `docs/MSG-SCHEMA.md` pointed at the wrong line.**
  The repository-wide Prettier pass in this release shifted all 82 of them
  at once
  (`opcua-client.js:244` for an `Object.assign` that now sits at 343, and so
  on). Citations are now anchored to file + function name, which a reformat
  cannot invalidate.
- Documented three behaviours that the live runs made visible and the reference
  did not state: a Bad OPC UA status arrives in `msg.statusCode` and does **not**
  raise `msg.error` or trigger a Catch node; subscription value-change messages
  carry `msg.nodeId` but not `msg.topic` (unlike `opcua-event`); and array
  variables arrive as node-opcua typed arrays (`Int32Array`, `Float64Array`),
  which `JSON.stringify` renders as objects.
- Corrected the coverage cross-check: the documented grep finds 45 fields, not
  39, and structurally cannot see fields introduced as object-literal keys —
  the entire `opcua-subscriber` output message among them. The section now says
  so instead of implying the grep is exhaustive.
- `DOCKER.md`: documented the dev stack's third container and why the
  `val-mosquitto` *service* name is load-bearing, added troubleshooting entries
  for the healthcheck fix and for the first-run
  `Cannot find private key … private_key.pem` race, and normalised the v1
  `docker-compose` invocations to `docker compose`.
- `README.md`: the validation-flow instructions now name the broker requirement
  and warn that T5/T8/T9 are two-step tabs whose *check* inject needs the
  documented ~2 s gap — firing it immediately reports a failure that is only
  impatience.

### Known issues

- **First start on an empty Node-RED user directory can fail with
  `Cannot find private key … private_key.pem`.** Deploying a flow with several
  `opcua-endpoint` config nodes and/or an `opcua-server` node before node-opcua
  has written its default self-signed certificate makes every instance create
  that certificate in the same PKI folder at once; one wins and the others read
  a key that is not on disk yet. It is first-run-only and does not recur —
  restarting Node-RED clears it permanently. Not introduced by this release.

## 0.1.8 (2026-08-26)

### Changed

- **License changed from MIT to Apache-2.0.** Apache-2.0 is the license
  Node-RED itself uses. Compared to MIT it adds an explicit patent grant
  (section 3), keeps attribution intact downstream through the new `NOTICE`
  file (section 4d), and requires modified files to be marked as changed
  (section 4b). It remains fully permissive: commercial use, closed-source
  derivatives and forks are all still allowed.
- **`NOTICE` added** and verified to ship inside the npm tarball.
- **Contributing and fork guidance in the README.** Pull requests are welcome,
  including large ones — an issue up front means substantial work can usually
  land here instead of in a parallel package. Forks that are published under
  their own package name are asked to rename their Node-RED node type IDs and
  use their own palette category, so both packages can be installed side by
  side.

## 0.1.7 (2026-07-20)

### Fixed

- **`opcua-server`: `addMethod` works now (issue #16)** – every `addMethod` command used to fail with *"expecting a valid parent object"*, because the handler called `namespace.addMethod(options)` with a single options object while the node-opcua signature is `addMethod(parentObject, options)` with a resolved parent **node instance** as first argument. The handler now resolves `msg.parentNodeId`, validates it (must exist and be an Object/ObjectType — OPC UA does not allow methods directly under the standard Objects folder, so there is no `ObjectsFolder` default for this command; all failure modes produce clear error messages) and passes the node instance to node-opcua.
- **`opcua-server`: `addMethod` call handler is actually bound** – the previous code passed the handler as an `onCall` option, which node-opcua silently ignores, so a created method would have answered every call with `BadInternalError`. The handler (default or `msg.func`) is now bound via `method.bindMethod()`. A `msg.func` body additionally receives the `Variant`, `DataType` and `StatusCodes` constructors as parameters (`(inputArguments, context, Variant, DataType, StatusCodes)`) so it can construct its return value without module access.

### Tests

- Added `test/opcua-server-addmethod.test.js`: end-to-end coverage against a **real** node-opcua server and client — reproduces the exact issue #16 flow (`addObject` → `addMethod`), calls the created method over OPC UA (default handler and custom `msg.func` echo handler) and verifies all rejection paths (missing/standard-Objects-folder/unknown/non-object parent). Updated the mocked `opcua-server` unit tests to the real `addMethod(parentObject, options)` signature.

## 0.1.6 (2026-07-10)

### Fixed

- **`opcua-client`: subscriptions survive a server-side session timeout (issue #15)** – a subscribed variable used to stop delivering data after ~1 minute on servers with a short session timeout (e.g. Siemens S7-1200), and a later `subscribe` crashed with *"expecting a valid session"*. When the manager replaces the session on reconnect, the node-local `subscription` was left pointing at the dead session. The manager now emits a new **`session_recreated`** event whenever a fresh session replaces an old one (both the automatic `after_reconnection` path and a full `reconnect()`), and the client node transparently replays every active subscription on the new session — no re-`subscribe` message needed. `disconnected` now also clears the stale subscription handle so a subscribe arriving mid-outage cannot reuse it.

### Tests

- Added `test/opcua-client-resubscribe.test.js` covering the reconnect replay, that an unsubscribed topic is not replayed, and that a subscribe during an outage builds a fresh subscription; plus manager-level coverage for `session_recreated` / `_handleSessionReplaced()`.

## 0.1.5 (2026-06-28)

### Added

- **`opcua-item`: complete OPC UA DataType set** – the per-item **DataType** dropdown now exposes the full enum: the previously added scalars plus `ExpandedNodeId`, the structured `ExtensionObject`, and an *Advanced (rarely writable)* group (`DataValue`, `Variant`, `DiagnosticInfo`). The advanced types are offered for completeness — an incompatible value surfaces a server-side write error.
- **`opcua-item` / `opcua-client`: array (ValueRank) writes** – a per-item `[]` checkbox (or `arrayType: "Array"` on an item / `msg.arrayType` for single write) builds the Variant with `VariantArrayType.Array`, so array-valued nodes (e.g. `Int32[]`) can be written. The payload must be a JS array; the element DataType comes from the selected DataType or is inferred from the first element. Scalar behaviour is unchanged when the flag is off.
- **`opcua-item`: ExtensionObject DataType NodeId field** – selecting `ExtensionObject` reveals a **DataType NodeId** input (e.g. `ns=2;i=3003`), so structured-type writes can be configured entirely in the Item node UI (previously only via a function node setting `msg.items`). Reading ExtensionObjects still needs no configuration.

### Tests

- Added end-to-end coverage proving the **read** path serializes ExtensionObject values to plain JSON (`read` and `readMultiple`), plus array-Variant construction and arrayType/dataTypeNodeId passthrough from the Item node through the client to the manager.

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
