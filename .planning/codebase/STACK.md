# Technology Stack

**Analysis Date:** 2026-05-08

## Languages

**Primary:**
- JavaScript (ES2020+, CommonJS) — runtime code in `nodes/*.js`, `lib/*.js`, `test-server/*.js`, `test/*.js`. Uses `async/await`, optional chaining (`?.`), nullish coalescing, `class` syntax, `Map`/`Set`. No TypeScript in this repo (only consumed via `node-opcua` typings).

**Secondary:**
- HTML + jQuery + inline CSS — Node-RED editor UIs in `nodes/*.html` (e.g. `nodes/opcua-endpoint.html`, `nodes/opcua-browse-client.html`). Uses `RED.nodes.registerType()` JS-in-HTML pattern.
- SVG — single icon at `nodes/icons/opcua.svg`.
- Shell — `docker-start.sh`, `docker-entrypoint-dev.sh` (POSIX `/bin/sh` and Bash).
- Makefile — top-level `Makefile` for Docker workflows (German help strings).

## Runtime

**Environment:**
- Node.js — required `>=18.0.0` (see `package.json` `engines.node`). The npm publish workflow at `.github/workflows/publish-npm.yml` uses Node.js 24 (required for npm OIDC Trusted Publishing).
- Node-RED — host runtime, required `>=3.0.0` (see `package.json` `node-red.version`). The plugin runs as eight registered Node-RED node types (declared under `package.json` `node-red.nodes`).

**Package Manager:**
- npm (CommonJS, no Yarn / pnpm config). `package-lock.json` is committed at the repo root (~173 KB).
- Lockfile: present (`package-lock.json`).

## Frameworks

**Core:**
- Node-RED `>=3.0.0` — host application. The plugin extends Node-RED via `RED.nodes.registerType(...)` (every file in `nodes/*.js`) and `RED.httpAdmin.post/get/delete(...)` for editor-side HTTP endpoints (cert upload in `nodes/opcua-endpoint.js`, browse tree in `nodes/opcua-browse-client.js`).
- node-opcua `^2.115.0` (resolved to `2.163.1` in `node_modules/node-opcua/package.json`) — the entire OPC UA implementation. Imported in `lib/opcua-client-manager.js`, `nodes/opcua-server.js`, `nodes/opcua-event.js`, `nodes/opcua-client.js`, `nodes/opcua-browse-client.js`, `test-server/server.js`.

**Testing:**
- Mocha `^10.2.0` — test runner. Invoked via `npm test` → `mocha test/**/*.test.js --timeout 30000 --exit`.
- Chai `^4.3.10` — assertion library (used inside `test/*.test.js`).
- Sinon `^17.0.1` — mocks/stubs/spies for unit tests (used in `test/opcua-client-retry.test.js`, `test/opcua-client-manager.test.js`, etc.).

**Build/Dev:**
- ESLint `^8.57.0` — linting. Invoked via `npm run lint` → `eslint nodes/*.js lib/*.js`. **No `.eslintrc*` config file is committed**; ESLint 8 will fall back to its embedded defaults.
- Prettier `^3.2.5` — formatter. Invoked via `npm run format` → `prettier --write nodes/**/*.js lib/**/*.js`. **No `.prettierrc*` config file is committed**; Prettier defaults apply.
- No bundler, no transpiler, no TypeScript compiler — JS files are shipped as-is.

## Key Dependencies

**Critical (runtime):**
- `node-opcua` `^2.115.0` — the only declared runtime dependency. Provides everything: OPC UA client (`OPCUAClient`), server (`OPCUAServer`), security primitives (`MessageSecurityMode`, `SecurityPolicy`), data types (`Variant`, `DataType`, `StatusCodes`), discovery (`OPCUADiscoveryServer`, `performFindServersRequest`), monitoring (`ClientSubscription`, `ClientMonitoredItem`), event filters (`constructEventFilter`), browse path utilities (`makeBrowsePath`, `coerceNodeId`, `resolveNodeId`), localization (`coerceLocalizedText`), access flags (`AccessLevelFlag`), certificate manager (`OPCUACertificateManager`), arrays (`VariantArrayType`).
- `node-opcua-extension-object` — used **transitively** but `require()`-d directly in `lib/opcua-client-manager.js` line 35 (`OpaqueStructure` is not re-exported by the top-level `node-opcua`). Wrapped in a try/catch with a duck-type fallback.

**Transitive (notable, all installed under `node-opcua@2.163.1`):**
- `node-opcua-client`, `node-opcua-server`, `node-opcua-address-space`, `node-opcua-address-space-base`
- `node-opcua-secure-channel`, `node-opcua-transport`, `node-opcua-chunkmanager`, `node-opcua-packet-assembler`, `node-opcua-packet-analyzer`
- `node-opcua-pki`, `node-opcua-crypto`, `node-opcua-certificate-manager`
- `node-opcua-nodesets`, `node-opcua-nodeset-ua`, `node-opcua-schemas`, `node-opcua-types`
- `node-opcua-data-access`, `node-opcua-data-model`, `node-opcua-data-value`, `node-opcua-variant`, `node-opcua-status-code`
- `node-opcua-aggregates`, `node-opcua-alarm-condition`
- `node-opcua-client-dynamic-extension-object`, `node-opcua-client-proxy`, `node-opcua-pseudo-session`
- `node-opcua-service-*` (read, write, browse, call, history, subscription, discovery, endpoints, filter, node-management, query, register-node, secure-channel, session, translate-browse-path)
- 62 `node-opcua-*` submodules in total under `node_modules/`.

**Infrastructure (none declared):**
- No HTTP server, MQTT, AMQP, UDP/UADP, WebSocket, database, ORM, queue, cache, or auth library is declared as a direct dependency. Node-RED's bundled Express is used implicitly via `RED.httpAdmin` but is not a direct dependency of this package.

## Configuration

**Environment:**
- No `.env*` files committed (`.env*` is in `.gitignore` and `.npmignore`).
- No `dotenv` integration — the package reads zero env vars at runtime.
- Docker compose injects `NODE_OPTIONS=--max-old-space-size=512` (`docker-compose.yml`, `docker-compose.dev.yml`) and `TZ=Europe/Berlin`.
- Dev compose adds `--inspect=0.0.0.0:9229` and `NODE_ENV=development` (`docker-compose.dev.yml`).
- Runtime configuration is entirely **flow-driven**: each Node-RED node reads its `config` object (`config.endpointUrl`, `config.securityMode`, `config.port`, `config.retryAttempts`, `config.verboseLog`, etc.) — see top of `nodes/opcua-endpoint.js`, `nodes/opcua-server.js`, `nodes/opcua-client.js`.

**Node-RED registration:**
- `package.json` → `node-red.nodes` maps eight node types to their JS entry files:
  - `opcua-client` → `nodes/opcua-client.js`
  - `opcua-server` → `nodes/opcua-server.js`
  - `opcua-item` → `nodes/opcua-item.js`
  - `opcua-endpoint` → `nodes/opcua-endpoint.js` (config node)
  - `opcua-event` → `nodes/opcua-event.js`
  - `opcua-method` → `nodes/opcua-method.js`
  - `opcua-browser` → `nodes/opcua-browser.js`
  - `opcua-browse-client` → `nodes/opcua-browse-client.js`

**Build:**
- No build step. JS files are published as-is. `tsbuildinfo`, `dist/`, `build/` are explicitly excluded by `.gitignore` / `.dockerignore` (none are produced by this repo — `node_modules/node-opcua/dist` belongs to the dependency).
- Files included in the npm package: governed by `.npmignore` — `nodes/`, `lib/`, `package.json`, `LICENSE`, `README.md`, `CHANGELOG.md` are published; `test/`, `test-server/`, `examples/`, `Dockerfile*`, `docker-compose*.yml`, `Makefile`, `DOCKER.md`, `QUICKSTART.md`, `data/`, `.claude/`, `.github/` are excluded.

**Locales:**
- `locales/` exists but is empty — i18n is not used. Strings are hardcoded (mix of English and German, e.g. `nodes/opcua-server.js` German log lines, `Makefile` German help).

## Platform Requirements

**Development:**
- Node.js 18+ (CI uses Node.js 24).
- npm.
- Docker `>=20.10` and Docker Compose `>=2.0` for the containerised dev/test workflow (`DOCKER.md`).
- Native build toolchain (`python3`, `make`, `g++`, `git`) for `node-opcua` native crypto modules — installed via `apk add` in `Dockerfile`, `Dockerfile.dev`, `Dockerfile.npm-test`. Same prerequisites apply to bare-metal installs on Alpine; Debian/Ubuntu hosts need `build-essential` + `python3`.
- WSL2 (Linux) is the active development host (per `gitStatus`/working dir `/home/la/private/node-red-contrib-opcua-suite`).

**Production:**
- Node-RED 3.x or newer with Node.js 18+.
- File-system write access to `<userDir>/opcua-certs/` for drag-and-drop certificate uploads (created at startup by `nodes/opcua-endpoint.js` via `fs.mkdirSync(certsDir, { recursive: true })`, where `certsDir = path.join(RED.settings.userDir || '/data', 'opcua-certs')`).
- Outbound TCP to OPC UA servers (default `opc.tcp://...:4840`) for client nodes.
- Inbound TCP listener (default port `4840`, configurable per `opcua-server` node) for the embedded OPC UA server, with `resourcePath: "/UA/NodeRED"` (test server uses `/UA/TestServer` on `4841` in compose).
- Recommended deploy target per `DOCKER.md`: HTTPS reverse proxy (nginx / traefik), Docker secrets for credentials, and backup of `./data`.

## Tooling Notes

**CI/CD:**
- Single GitHub Actions workflow at `.github/workflows/publish-npm.yml` — triggers on `v*` tag push, runs `npm ci`, verifies tag matches `package.json` version, runs `npm test`, then `npm publish --access public` via npm Trusted Publishing (OIDC, `id-token: write` permission, Node.js 24 image). No build/lint job in CI.

**Test scripts:**
- `npm test` — Mocha unit tests (~120 specs per README).
- `npm run test:integration` — `node test-server/test-client.js` runs a one-shot integration suite against the test server.
- `node test/live-integration.js` — 36 live integration tests (require Docker stack).

---

*Stack analysis: 2026-05-08*
