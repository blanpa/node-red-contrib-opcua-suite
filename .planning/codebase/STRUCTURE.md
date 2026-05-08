# Codebase Structure

**Analysis Date:** 2026-05-08

## Directory Layout

```
node-red-contrib-opcua-suite/
├── nodes/                              # Node-RED node implementations (runtime + editor)
│   ├── opcua-endpoint.js               # Config node: shared connection + cert mgmt
│   ├── opcua-endpoint.html             #   editor UI (drag-drop certs, sec settings)
│   ├── opcua-client.js                 # All-in-one msg-driven client
│   ├── opcua-client.html
│   ├── opcua-server.js                 # OPC UA server (independent, no endpoint config)
│   ├── opcua-server.html
│   ├── opcua-item.js                   # Item collector / msg shaper (no OPC UA dep)
│   ├── opcua-item.html
│   ├── opcua-event.js                  # Event subscription
│   ├── opcua-event.html
│   ├── opcua-method.js                 # Method invocation
│   ├── opcua-method.html
│   ├── opcua-browser.js                # Address-space browser (runtime)
│   ├── opcua-browser.html
│   ├── opcua-browse-client.js          # Editor-time browser + runtime read/subscribe
│   ├── opcua-browse-client.html        #   (large UI: 1049 lines — tree browser)
│   └── icons/
│       └── opcua.svg                   # Single shared palette icon for all nodes
├── lib/                                # OPC UA logic, reused by nodes/
│   ├── opcua-client-manager.js         # OPCUAClient/Session lifecycle + ops + reconnect
│   └── opcua-utils.js                  # NodeId parsing, ExtObject serialization
├── examples/                           # Importable Node-RED flow examples (.json)
│   ├── 01 - Read Single Variable.json
│   ├── 02 - Batch Read with Item Collector.json
│   ├── 03 - Write a Value.json
│   ├── 04 - Subscribe to Changes.json
│   ├── 05 - Browse Address Space.json
│   ├── 06 - Event Subscription.json
│   ├── 07 - Call a Method.json
│   ├── 08 - Server with Variables.json
│   └── 09 - Session Retry Test.json
├── locales/                            # i18n message catalogs (currently empty)
├── test/                               # Mocha unit + integration tests
│   ├── connection-sharing.test.js
│   ├── integration-session-retry.test.js
│   ├── live-integration.js             # not auto-run (no .test.js suffix)
│   ├── nodes-registration.test.js
│   ├── opcua-client-manager.test.js
│   ├── opcua-client-retry.test.js
│   ├── opcua-item.test.js
│   ├── opcua-nodes.test.js
│   ├── opcua-utils.test.js
│   └── run-examples.js                 # helper, not auto-run
├── test-server/                        # Standalone OPC UA test server (not published)
│   ├── server.js                       # Full server with anon/user-pass/X509 auth
│   ├── test-client.js                  # npm run test:integration entry
│   └── test-flows.js
├── data/                               # Local Node-RED userDir for dev (Docker mount)
│   ├── flows.json, flows_cred.json
│   ├── settings.js
│   ├── package.json
│   ├── opcua-certs/                    # Runtime certificate store (created on first load)
│   │   ├── client-cert.{pem,der}
│   │   ├── client-key.{pem,der}
│   │   └── user-{cert,key}.pem
│   ├── lib/flows/                      # Node-RED flow library
│   ├── nodes/                          # User-installed nodes (dev)
│   └── node_modules/
├── logs/                               # Runtime logs (Docker)
├── .github/workflows/
│   └── publish-npm.yml                 # CI: publish to npm on tag
├── package.json                        # Defines node-red.nodes mapping (8 nodes)
├── package-lock.json
├── README.md                           # User-facing docs (~9KB)
├── CHANGELOG.md
├── QUICKSTART.md
├── DOCKER.md
├── Dockerfile, Dockerfile.dev, Dockerfile.npm-test
├── docker-compose.yml, docker-compose.dev.yml
├── docker-entrypoint-dev.sh
├── docker-start.sh
├── Makefile
├── LICENSE                             # MIT
├── .dockerignore
├── .gitignore
├── .npmignore
└── .planning/                          # GSD planning docs (this directory)
    └── codebase/
```

## Directory Purposes

**`nodes/`:**
- Purpose: Every file directly registered with Node-RED. The "shell" layer.
- Contains: Paired `*.js` (runtime) + `*.html` (editor + palette + help) for each of 8 node types.
- Key files:
  - `nodes/opcua-endpoint.js` — Config node implementing shared `OpcUaClientManager` ref counting.
  - `nodes/opcua-client.js` — Largest worker (702 lines), dispatches all msg-driven ops.
  - `nodes/opcua-server.js` — Standalone server, does not use `opcua-endpoint`.
  - `nodes/opcua-browse-client.js` — Includes editor-time HTTP admin routes for live address-space browsing.
  - `nodes/opcua-item.js` — Pure data shaping; no `node-opcua` import.

**`nodes/icons/`:**
- Purpose: Palette icons referenced from `*.html` via `icon: 'opcua.svg'`.
- Contains: `opcua.svg` only — every node uses the same icon.

**`lib/`:**
- Purpose: Shared library code reused across multiple nodes; no Node-RED API calls (testable in isolation).
- Contains:
  - `lib/opcua-client-manager.js` (913 lines) — `OpcUaClientManager extends EventEmitter`. Single class, single responsibility: own one OPC UA client + session and expose async operation methods.
  - `lib/opcua-utils.js` (263 lines) — pure functions only: `parseNodeId`, `nodeIdToString`, `parseDataType`, `createError`, `isValidEndpointUrl`, `serializeExtensionObject`, `WELL_KNOWN_NODES`.

**`examples/`:**
- Purpose: Ready-to-import Node-RED flow JSON files. Surfaced in the editor via "Menu → Import → Examples → node-red-contrib-opcua-suite" (Node-RED auto-discovers an `examples/` dir at the package root).
- Contains: 9 numbered JSON files, one per use case. Each is a Node-RED flow array, all sharing the convention of an `exNN-endpoint` id.

**`locales/`:**
- Purpose: Reserved for Node-RED i18n catalogs (e.g. `en-US/opcua-client.json`). Currently empty — help text lives inline in `*.html` `<script type="text/html" data-help-name="...">` blocks.

**`test/`:**
- Purpose: Mocha unit and integration tests. Glob `test/**/*.test.js` (per `package.json` `scripts.test`).
- Contains: 7 `*.test.js` files plus 2 helpers (`live-integration.js`, `run-examples.js`) that are intentionally **not** matched by the test glob.

**`test-server/`:**
- Purpose: Standalone OPC UA test server used for live integration testing (not published to npm).
- Contains: `server.js` (full server with all auth modes), `test-client.js` (driver via `npm run test:integration`), `test-flows.js`.

**`data/`:**
- Purpose: Local Node-RED `userDir` for development (Docker mount target). Contains live runtime state — flows, installed nodes, certificate uploads.
- Generated: Yes (mostly).
- Committed: Partially — `.gitignore` excludes most of the runtime state but cert samples in `data/opcua-certs/` are tracked for development convenience.

**`logs/`:**
- Purpose: Container log output (Docker dev workflow).
- Generated: Yes.
- Committed: No.

**`.github/workflows/`:**
- Purpose: GitHub Actions CI.
- Contains: `publish-npm.yml` — npm publish on tag push.

**`.planning/codebase/`:**
- Purpose: GSD-generated codebase analysis docs (this file lives here).
- Generated: Yes (by `/gsd-map-codebase`).

## Key File Locations

**Entry Points (Node-RED):**
- `package.json` → `node-red.nodes` mapping registers 8 node types pointing at `nodes/*.js`.

**Configuration:**
- `package.json` — npm + Node-RED metadata.
- `.eslintrc` — not present (eslint config likely in `package.json` or default).
- `.prettierrc` — not present.
- `Dockerfile`, `Dockerfile.dev`, `Dockerfile.npm-test` — three Docker build variants.
- `docker-compose.yml` (prod) / `docker-compose.dev.yml` (dev with live mount of `data/`).
- `Makefile` — convenience targets for Docker workflow.

**Core OPC UA Logic:**
- `lib/opcua-client-manager.js` — connection + ops manager.
- `lib/opcua-utils.js` — pure helpers.

**Node Implementations (one runtime + one editor file each):**
- `nodes/opcua-endpoint.{js,html}` — config node (shared connection).
- `nodes/opcua-client.{js,html}` — all-in-one msg-driven client.
- `nodes/opcua-server.{js,html}` — independent server.
- `nodes/opcua-item.{js,html}` — item collector.
- `nodes/opcua-event.{js,html}` — event subscription.
- `nodes/opcua-method.{js,html}` — method invocation.
- `nodes/opcua-browser.{js,html}` — runtime browser.
- `nodes/opcua-browse-client.{js,html}` — editor-time tree browser + runtime read/subscribe.

**Testing:**
- `test/*.test.js` — Mocha test files (auto-discovered by `npm test`).
- `test-server/server.js` — local OPC UA server.
- `test-server/test-client.js` — integration entry (`npm run test:integration`).

**Documentation:**
- `README.md` — user-facing.
- `CHANGELOG.md` — release notes.
- `QUICKSTART.md`, `DOCKER.md` — supplementary.

**Runtime data:**
- `<RED.settings.userDir>/opcua-certs/` — created at load time by `nodes/opcua-endpoint.js`. In dev: `data/opcua-certs/`.

## Naming Conventions

**Node type ID convention:**
- All node types are namespaced with the prefix `opcua-` followed by a kebab-case role: `opcua-client`, `opcua-server`, `opcua-endpoint`, `opcua-item`, `opcua-event`, `opcua-method`, `opcua-browser`, `opcua-browse-client`.
- The node type ID matches the filename (without extension) **and** the key in `package.json` `node-red.nodes`. Always keep these three in sync when adding a new node.

**File pairing (`*.js` ↔ `*.html`):**
- For each Node-RED node, two files with the **same base name** must exist in `nodes/`:
  - `nodes/<type>.js` — runtime registration (`module.exports = function(RED) { ... RED.nodes.registerType('<type>', Ctor, [creds]); }`).
  - `nodes/<type>.html` — editor side: `<script type="text/javascript">RED.nodes.registerType('<type>', { ... defaults, oneditprepare, label ... })</script>`, then `<script type="text/html" data-template-name="<type>">...</script>` for the config form, and `<script type="text/html" data-help-name="<type>">...</script>` for the help panel.
- Node-RED requires exactly this pairing — the HTML is auto-loaded next to the JS.

**Constructor function naming:**
- Each node's constructor function uses PascalCase matching the type with `Node` suffix: `OpcUaClientNode`, `OpcUaEndpointNode`, `OpcUaServerNode`, `OpcUaItemNode`, `OpcUaEventNode`, `OpcUaMethodNode`, `OpcUaBrowserNode`, `OpcUaBrowseClientNode`.

**Library file convention:**
- `lib/opcua-<role>.js` — kebab-case prefixed with `opcua-` (e.g. `opcua-client-manager.js`, `opcua-utils.js`).
- Library exports a class (`module.exports = OpcUaClientManager`) or named functions (`module.exports = { parseNodeId, ... }`).

**Test file convention:**
- `test/<area>.test.js` — Mocha pattern, picked up by the test glob.
- `test/<area>-<sub>.test.js` for sub-areas (e.g. `opcua-client-manager.test.js`, `opcua-client-retry.test.js`, `connection-sharing.test.js`).
- Helpers without the `.test.js` suffix (`live-integration.js`, `run-examples.js`) are not auto-run.

**Example file convention:**
- `examples/NN - <Title Case Description>.json` — sequence-numbered (zero-padded `01`–`09`), space-separated, `.json` extension.
- Each example uses node IDs prefixed with `exNN-` (e.g. `ex01-endpoint`, `ex02-inject`) to avoid id collisions when multiple examples are imported into the same flow.

**Icons:**
- `nodes/icons/<name>.svg` — referenced from HTML as `icon: '<name>.svg'`. Currently only `opcua.svg` exists; all 8 nodes share it.

**Default editor color:**
- `'#3a8cba'` (OPC UA blue) — convention used in every node's `*.html` `color:` field.

**Editor category:**
- All worker/server nodes use `category: 'opcua'` (creates an "opcua" palette section).
- The endpoint config node uses `category: 'config'` (Node-RED convention for config-only nodes).

## Where to Add New Code

**New worker node (e.g. an additional OPC UA operation node):**
1. Create `nodes/opcua-<role>.js` and `nodes/opcua-<role>.html`. Use `nodes/opcua-method.js` as the most compact reference template (104 lines).
2. Inside the JS: import from `lib/opcua-utils.js` for any NodeId parsing/serialization. Get `endpointConfig = RED.nodes.getNode(config.endpoint)`. Call `endpointConfig.getSharedManager({ applicationName: '...' })`. Wire up the `statusCallback` pattern. Implement `node.on('input', ...)` and the matching `node.on('close', ...)` cleanup that calls `releaseSharedManager()` and `unregisterStatusCallback()`.
3. In the HTML: set `category: 'opcua'`, `color: '#3a8cba'`, `icon: 'opcua.svg'`, declare `endpoint: { value: '', type: 'opcua-endpoint', required: true }` in `defaults`.
4. Register the new node in `package.json` under `node-red.nodes`.
5. Add a Mocha test at `test/opcua-<role>.test.js`.
6. Add an example flow at `examples/NN - <Description>.json` with a fresh sequence number and `exNN-*` id prefix.

**New OPC UA operation on an existing client node:**
- Add the underlying call to `lib/opcua-client-manager.js` as a new `async <name>(...)` method that uses `this._withTimeout(this.session.X(...), this.operationTimeout, '<label>')` and `this._ensureConnected()`.
- Add a `case '<opname>': result = await handle<Op>(msg, clientManager); break;` to the dispatcher in `nodes/opcua-client.js`.
- Add a `handle<Op>(msg, mgr)` function in `nodes/opcua-client.js`.
- Surface the operation in `nodes/opcua-client.html` (`defaultOperation` options + help text).

**New utility helper:**
- Add a pure function to `lib/opcua-utils.js` and export it via `module.exports`. Add a unit test in `test/opcua-utils.test.js`.

**New shared OPC UA component (likely for the upcoming PubSub work):**
- Create a new `lib/opcua-<role>.js` (e.g. `lib/opcua-pubsub-publisher.js`). Follow the `EventEmitter` pattern of `OpcUaClientManager` for status events.
- If a new config node is needed, mirror `nodes/opcua-endpoint.js` for the ref-count + status-callback pattern.

**New example flow:**
- `examples/NN - <Title Case>.json`. Use `exNN-` as the prefix for every node id in the flow.

**New cert (runtime):**
- Drop into `<RED.settings.userDir>/opcua-certs/` directly **or** drag-and-drop via the editor (POSTs to `/opcua-endpoint/upload-cert` and writes to the same dir).
- For development, the path resolves to `data/opcua-certs/`.

## Special Directories

**`data/`:**
- Purpose: Node-RED `userDir` for local Docker development. Mounted into the dev container by `docker-compose.dev.yml`.
- Generated: Most contents (flows, node_modules) are runtime artifacts.
- Committed: Partial — `.gitignore` excludes most state, but a few certs in `data/opcua-certs/` are tracked for dev bootstrap.

**`logs/`:**
- Purpose: Container log output.
- Generated: Yes.
- Committed: No.

**`.planning/codebase/`:**
- Purpose: GSD `/gsd-map-codebase` output.
- Generated: Yes (by GSD agents).
- Committed: User-controlled.

**`locales/`:**
- Purpose: Reserved for i18n catalogs (Node-RED auto-loads `locales/<lang>/<type>.json` for help text overrides).
- Currently empty.

**`node_modules/`:**
- Purpose: Standard npm dependency tree. `node-opcua` (and its many `node-opcua-*` sub-packages) is the main dependency.
- Generated: Yes.
- Committed: No (`.gitignore`).

---

*Structure analysis: 2026-05-08*
