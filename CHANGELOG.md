# Changelog

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
