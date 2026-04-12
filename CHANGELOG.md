# Changelog

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
