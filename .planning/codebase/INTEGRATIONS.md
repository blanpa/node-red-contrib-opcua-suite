# External Integrations

**Analysis Date:** 2026-05-08

## APIs & External Services

### Outbound — OPC UA servers (the suite as client)

The suite's primary outbound integration is the OPC UA Client/Server protocol over TCP (binary, `opc.tcp://...`). All client-side traffic is mediated by `lib/opcua-client-manager.js` (class `OpcUaClientManager extends EventEmitter`).

- **Protocol:** OPC UA Binary over TCP (the only transport the runtime currently supports).
- **Endpoint URL format:** `opc.tcp://host[:port][/path]` — validated by `isValidEndpointUrl()` in `lib/opcua-utils.js` (regex `^opc\.tcp:\/\/[^\/]+(:\d+)?(\/.*)?$`).
- **Default endpoint:** `opc.tcp://localhost:4840` (`nodes/opcua-endpoint.js` line 71).
- **Connection sharing:** the `opcua-endpoint` config node ref-counts a single `OpcUaClientManager` per endpoint config; `getSharedManager()` / `releaseSharedManager()` in `nodes/opcua-endpoint.js` ensure all client/browser/method/event/browse-client nodes referencing the same endpoint share one TCP connection and one OPC UA session.
- **Session lifecycle:** `keepSessionAlive: true`, `requestedSessionTimeout: 60000` (ms), `endpointMustExist: false` (`lib/opcua-client-manager.js` lines 115–128).
- **Reconnect strategy:** exponential backoff handled in two layers:
  - node-opcua native: `connectionStrategy.initialDelay: 1000`, `maxRetry: maxReconnectAttempts (default 10)`, `maxDelay: reconnectDelay (default 5000)` (`lib/opcua-client-manager.js`).
  - Suite-level retry wrapper in `nodes/opcua-client.js` (`forceReconnect()`, `_doForceReconnect()`, lines 174–210) — per-message retry with exponential backoff (`RECONNECT_BASE_DELAY_MS = 2000`, capped at `RECONNECT_MAX_DELAY_MS = 30000`), defaulting to **infinite retries** when `config.retryAttempts <= 0`. A `reconnectPromise` single-flight lock prevents parallel reconnect storms.
  - Connection-lost detection (`isConnectionLostError()` in `nodes/opcua-client.js` lines 155–165) matches messages: `"Session is no longer valid"`, `"Not connected"`, `"premature disconnection"`, `"Secure Channel Closed"`, `"connection may have been rejected"`, `"Server end point"`, `"socket has been disconnected"`.

**OPC UA service calls used (all via the shared `session` object from node-opcua):**

| Service | Method | Files |
|---|---|---|
| Read (single + batch) | `session.read()` | `lib/opcua-client-manager.js` `read()`, `readMultiple()`, `readAttribute()`, `_readNodeAttributes()` |
| Write (single + batch) | `session.write()` | `lib/opcua-client-manager.js` `write()`, `writeMultiple()` |
| Browse | `session.browse()` | `lib/opcua-client-manager.js` `browse()`; also direct in `nodes/opcua-browse-client.js` |
| Translate Browse Path | `session.translateBrowsePath()` | `lib/opcua-client-manager.js` `translateBrowsePath()` |
| Register / Unregister Nodes | `session.registerNodes()`, `session.unregisterNodes()` | `lib/opcua-client-manager.js` |
| Method Call | `session.call()` | `lib/opcua-client-manager.js` `callMethod()`; also `nodes/opcua-method.js` |
| History Read | `session.readHistoryValue()` | `lib/opcua-client-manager.js` `historyRead()` |
| Subscription / MonitoredItem | `ClientSubscription.create()`, `ClientMonitoredItem.create()` | `lib/opcua-client-manager.js` `createSubscription()`, `nodes/opcua-client.js` (subscribe), `nodes/opcua-event.js`, `nodes/opcua-browse-client.js` |
| Event filter | `constructEventFilter([...])` | `nodes/opcua-event.js` line 95 (fields: `EventId`, `EventType`, `SourceNode`, `SourceName`, `Time`, `ReceiveTime`, `Message`, `Severity`) |
| Discovery | `OPCUAClient.create().getEndpoints()` | `lib/opcua-client-manager.js` `getEndpoints()` (creates a throwaway client per call) |
| ExtensionObject construction | `session.constructExtensionObject(dataTypeNodeId, fields)` | `lib/opcua-client-manager.js` `constructExtensionObject()` |

**ResultMask bit flags** for browse calls are documented in `nodes/opcua-browse-client.js` lines 83–99 (per OPC UA Part 4 §7.5).

### Inbound — embedded OPC UA server (the suite as server)

`nodes/opcua-server.js` exposes Node-RED itself as an OPC UA server via `node-opcua`'s `OPCUAServer` class.

- **Default port:** `4840` (string-coerced via `toPositiveInt()` to fix Node-RED `<input type=number>` returning strings — see `nodes/opcua-server.js` lines 16–24, fixed in #11 / v0.0.7).
- **Resource path:** `/UA/NodeRED` (hardcoded, line 38).
- **Application URI:** `urn:Node-RED:${serverName}` (default `serverName = "Node-RED OPC UA Server"`).
- **Capacity defaults:** `maxAllowedSessionNumber: 10`, `maxConnectionsPerEndpoint: 10` (configurable per node).
- **Address space build commands** (sent via `msg.command`): `addFolder`, `addVariable`, `setValue`, `setWritable`, `deleteNode`, `addMethod`, `addObject`, `raiseEvent`, `getServerInfo`, `getNamespaceIndex` (handlers in `nodes/opcua-server.js` lines 165–429).
- **ObjectsFolder reference rule:** standard `i=85` (ObjectsFolder) only accepts `Organizes` references, so the server picks `organizedBy` for that parent and `componentOf` for user folders (helper `isStandardObjectsFolder()` line 434).
- **Method binding:** `msg.func` (a string) is compiled via `new Function('inputArguments', 'context', funcBody)` (line 310) — **arbitrary code execution risk if Node-RED admin UI is exposed without auth**.

### Editor-side HTTP API (via `RED.httpAdmin`)

These run inside Node-RED's built-in admin Express app — they are **not** standalone services but are part of the Node-RED admin surface.

- `POST /opcua-endpoint/upload-cert` — receives base64 cert content, writes to `<userDir>/opcua-certs/<sanitized-filename>`. (`nodes/opcua-endpoint.js` lines 23–38). Filename sanitiser strips anything outside `[a-zA-Z0-9._-]`.
- `GET /opcua-endpoint/certs` — lists `*.pem|der|crt|key|pfx|p12` files in the cert dir (lines 40–47).
- `DELETE /opcua-endpoint/upload-cert/:filename` — removes a cert file (lines 49–62).
- `POST /opcua-browse-client/browse` — opens a temporary OPC UA session against the selected endpoint and returns a single tree level (`nodes/opcua-browse-client.js` lines 175–451). Idle browse connections close after **60 s** (`setTimeout(..., 60000)` in `getBrowseConnection()`).
- `POST /opcua-browse-client/disconnect` — explicitly closes a cached browse connection (lines 453–467).

## Data Storage

**Databases:**
- None. The suite has no DB integration of any kind.

**File Storage:**
- Local filesystem, two locations:
  - **Client/user certificates:** `<userDir>/opcua-certs/` (default `/data/opcua-certs/` inside the Docker container) — drop-zone for `certificateFile`, `privateKeyFile`, `caCertificateFile`, `userCertificateFile`, `userPrivateKeyFile`. The `opcua-endpoint` node stores absolute paths in the Node-RED flow JSON; the client manager reads them with `fs.existsSync` + `fs.readFileSync` at connect time (`lib/opcua-client-manager.js` lines 132–150 and `_buildUserIdentity()` lines 263–285).
  - **Test server PKI:** `test-server/pki/` with subfolders `certs/`, `user-certs/`, `server/`, `user/`. Auto-generated by `OPCUACertificateManager` with `automaticallyAcceptUnknownCertificate: true` (`test-server/server.js` lines 38–65).
- Node-RED flow JSON (`./data/...`) holds endpoint config including the cert file paths but **not** the cert contents themselves.

**Caching:**
- In-memory only: `OpcUaClientManager.subscriptions` (Map of subscriptionId → `ClientSubscription`), `monitorItems` Map per node (`nodes/opcua-client.js`, `nodes/opcua-event.js`, `nodes/opcua-browse-client.js`), and a per-endpoint `browseConnections` Map in `nodes/opcua-browse-client.js` for editor-side browse tree caching with 60 s idle timeout.

## Authentication & Identity

**Toward OPC UA servers (outbound auth, configured per endpoint):**

`OpcUaClientManager._buildUserIdentity()` in `lib/opcua-client-manager.js` lines 263–285 enforces a strict priority:

1. **X509 Certificate (UserTokenType = 2)** — when both `userCertificateFile` and `userPrivateKeyFile` exist on disk. Cert read as Buffer, private key read as `utf8`.
2. **Username/Password** — when `config.userName` is set. Password sourced from `node.credentials.password` (Node-RED encrypts these at rest in `data/flows_cred.json`).
3. **Anonymous** — fallback (returns `{}`).

**Transport security (Message Security):**
- Modes: `None`, `Sign`, `SignAndEncrypt` — set via `MessageSecurityMode[config.securityMode]` (`lib/opcua-client-manager.js` lines 96–104).
- Policies: `None`, `Basic128Rsa15`, `Basic256`, `Basic256Sha256`, `Aes128_Sha256_RsaOaep`, `Aes256_Sha256_RsaPss` — set via `SecurityPolicy[config.securityPolicy]` (lines 106–113). Same enum values used by the test server (`test-server/server.js` lines 89–94).

**Toward Node-RED (inbound auth):**
- Inherits whatever auth Node-RED itself is configured for (the suite registers `RED.httpAdmin.*` routes that piggy-back on Node-RED's admin auth). The cert upload and browse-tree HTTP endpoints have **no additional auth layer** beyond Node-RED admin.

**Embedded server auth (`nodes/opcua-server.js`):**
- The bundled OPC UA server has **no auth configured** — `userManager`, `userCertificateManager`, and security mode/policy lists are not set, so it accepts anonymous None-None. (Compare with the test-only `test-server/server.js` lines 96–112 which **does** configure all three auth methods + all security modes.) This is a meaningful gap if `opcua-server` is exposed beyond localhost.

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry / Rollbar / Datadog integration.

**Logs:**
- Node-RED logger (`node.log`, `node.warn`, `node.error`) is the only logging surface. Each node propagates connection-state changes via `node.status({ fill, shape, text })` (red/yellow/green dot/ring + label).
- Operation-level errors are always logged as `node.error(...)`. Connection lifecycle (`Connection lost ...`, `Reconnect attempt N/∞ ...`, `Reconnected ...`) is gated by `config.verboseLog` (default true) — `nodes/opcua-client.js` lines 20, 199, 204, 230.
- Embedded server logs via `node.log()` with German messages (e.g. `"OPC UA Server gestartet auf ..."`).
- Compose config bind-mounts `./logs:/var/log/node-red` (`docker-compose.yml`) but Node-RED is not configured to write there — log redirection is the operator's responsibility.

**Status events:**
- The shared `OpcUaClientManager` is an `EventEmitter` that emits: `connected`, `disconnected`, `reconnecting`, `error`, `backoff`, `subscription_started`, `subscription_keepalive`, `subscription_terminated` (`lib/opcua-client-manager.js`).
- The endpoint config node fans these out to all subscribed client nodes via `_statusCallbacks` (`nodes/opcua-endpoint.js` lines 89, 140–151, 162–168).

## CI/CD & Deployment

**Hosting:**
- Distributed as an npm package — `node-red-contrib-opcua-suite` on `https://registry.npmjs.org`.
- Bundled Docker images (not published — built locally from `Dockerfile`) target `nodered/node-red:latest-minimal` (production) and `nodered/node-red:latest` (dev with `Dockerfile.dev`).

**CI Pipeline:**
- GitHub Actions: `.github/workflows/publish-npm.yml` — triggers only on `v*` tag push:
  1. Checkout (`actions/checkout@v4`)
  2. Setup Node.js 24 with `registry-url: https://registry.npmjs.org` (`actions/setup-node@v4`)
  3. `npm ci`
  4. Verify the git tag matches `package.json` version (else fail)
  5. `npm test`
  6. `npm publish --access public`
- Permissions: `contents: read`, `id-token: write` — uses **npm Trusted Publishing (OIDC)**, so no `NPM_TOKEN` secret is required.

**No CI on PRs / pushes to main** — lint/test runs only inside the publish flow.

## Environment Configuration

**Required env vars at runtime:**
- None. The package itself reads zero env vars.

**Used by the Docker compose stack only:**
- `NODE_OPTIONS` (set to `--max-old-space-size=512`, plus `--inspect=0.0.0.0:9229` in dev).
- `TZ` (set to `Europe/Berlin`).
- `NODE_ENV` (set to `development` in `docker-compose.dev.yml`).

**Secrets location:**
- OPC UA Username/Password: stored as Node-RED `credentials` on the `opcua-endpoint` config node (`nodes/opcua-endpoint.js` lines 199–204) — encrypted by Node-RED in `data/flows_cred.json` using the user's `credentialSecret`.
- Certificates and private keys: filesystem at `<userDir>/opcua-certs/` (no encryption at rest — relies on filesystem permissions).
- No `.env` files; `.gitignore` and `.npmignore` both exclude `.env*` defensively.

## Webhooks & Callbacks

**Incoming HTTP:**
- Three Node-RED admin routes for the certificate-upload UX (`/opcua-endpoint/upload-cert`, `/opcua-endpoint/certs`, `/opcua-endpoint/upload-cert/:filename`) in `nodes/opcua-endpoint.js`.
- Two for the editor-side address-space browser (`/opcua-browse-client/browse`, `/opcua-browse-client/disconnect`) in `nodes/opcua-browse-client.js`.
- These are not webhooks in the SaaS sense — they are jQuery-driven editor RPCs, intended for the Node-RED admin user only.

**Incoming OPC UA (server side):**
- `nodes/opcua-server.js` exposes the runtime as an OPC UA server (default port 4840) accepting browse/read/write/method/subscription/event from any OPC UA client.

**Outgoing:**
- All OPC UA client traffic to `config.endpointUrl` (TCP `opc.tcp://...`).
- Discovery probes: `OPCUAClient.create({...}).getEndpoints()` in `lib/opcua-client-manager.js` `getEndpoints()` opens, queries, and disconnects a fresh client per call.

## Submodule Ecosystem (`node-opcua` 2.163.1)

`node-opcua` is a meta-package that pulls in 60+ scoped submodules under `node_modules/node-opcua-*`. Direct `require()` from suite code:

- `node-opcua` (top-level) — used by `lib/opcua-client-manager.js`, `nodes/opcua-server.js`, `nodes/opcua-event.js`, `nodes/opcua-client.js` (lazy `require` on subscribe), `nodes/opcua-browse-client.js`, `test-server/server.js`, `test-server/test-client.js`.
- `node-opcua-extension-object` — direct `require` in `lib/opcua-client-manager.js` line 35 to access `OpaqueStructure` (not re-exported by the meta-package). Wrapped in try/catch with a duck-type fallback (`value.constructor.name === "OpaqueStructure"`).

The submodule structure is otherwise opaque to the suite — all OPC UA service calls go through the top-level meta-package's re-exported surface.

## PubSub Roadmap (Not Yet Integrated)

A planned milestone will add OPC UA Part 14 PubSub support: UDP-UADP, MQTT, and AMQP transports (Publisher and Subscriber). **The current `node-opcua@2.x` line does not implement OPC UA PubSub** — none of the 60+ `node-opcua-*` submodules covers PubSub message mapping, network message encoding, dataset writers/readers, or transport bindings.

**Implications for new external dependencies:**

- **OPC UA PubSub library** — there is no PubSub support in `node-opcua@2.115.0` (or `2.163.1` currently installed). Options:
  - Wait for upstream `node-opcua` PubSub support (no public ETA known).
  - Pull a third-party PubSub library (e.g. `node-opcua-pubsub-*` packages from the broader ecosystem if/when available) — would become a **new direct runtime dependency**.
  - Implement PubSub network message encoding in-suite using `node-opcua-binary-stream`, `node-opcua-factory`, `node-opcua-types` (already transitively installed).

- **MQTT transport** — would require adding `mqtt` (npm) or `async-mqtt` as a new direct dependency. **Not currently in `node_modules/`**.

- **AMQP transport** — would require adding `amqplib` (RabbitMQ) or `rhea` (AMQP 1.0). **Not currently in `node_modules/`**.

- **UDP-UADP transport** — Node.js's built-in `dgram` module is sufficient for UDP datagrams; no new npm dependency required, but PubSub UADP encoding/decoding logic would need to be implemented.

- **Network configuration surface** — current `opcua-endpoint` and `opcua-server` config schemas only model `opc.tcp://` URLs and security mode/policy. PubSub will need new config nodes (e.g. `opcua-pubsub-connection`, `opcua-published-dataset`, `opcua-dataset-writer`, `opcua-dataset-reader`) covering broker URLs, topics/queues, publishing intervals, security keys, and dataset metadata.

- **Auth surface expansion** — MQTT/AMQP brokers introduce broker-level auth (SASL, TLS client certs, JWT) orthogonal to OPC UA security policies. The current `opcua-endpoint` credentials model (username/password OR X509) does not cover this.

- **Logging/status fan-out** — the `OpcUaClientManager` event emitter pattern handles a single TCP connection. PubSub adds N transport connections per dataset, requiring a redesigned status-propagation mechanism.

These are **green-field additions** — none of the new transports or PubSub primitives exist in the codebase or `node_modules/` today.

---

*Integration audit: 2026-05-08*
