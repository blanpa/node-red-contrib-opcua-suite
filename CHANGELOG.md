# Changelog

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
