# OPC UA Suite — Message Schema Reference

**Version:** v1.1 (2026-08-28)
**Scope:** All eleven shipped nodes (v0.1.0 and later)

This document is the authoritative reference for every `msg.*` field that the
eleven nodes in this package read from input messages or write to output
messages. Use it before adding a new field — both to discover what is already
there and to avoid silent collisions with existing names.

The breakdown was derived by reading the source files referenced in each
`Source` column and cross-checking with:

```bash
grep -rhnE "msg\.[a-zA-Z_]+" nodes/*.js lib/*.js | grep -oE "msg\.[a-zA-Z_]+" | sort -u
```

See `## Coverage cross-check` at the end for the limits of that grep.

---

## v1.0 Stability Statement

The fields listed below are the **v1.0 message contract** for the eight
original nodes (`opcua-endpoint`, `opcua-client`, `opcua-server`, `opcua-item`,
`opcua-event`, `opcua-method`, `opcua-browser`, `opcua-browse-client`) and the
**v0.1.0 contract** for the three PubSub nodes (`opcua-pubsub-connection`,
`opcua-publisher`, `opcua-subscriber`).
Once v1.0.0 is released:

- Field **names**, **types**, and **directions** (in / out / both) are stable
  and will not change without a major version bump.
- Optional fields may gain new accepted values; required fields will not be
  added.
- Output fields will not be removed; new output fields may be added (additive).
- During the v0.x series, field renames are still possible but will be
  explicitly called out in `CHANGELOG.md` for the release that introduces them.

---

## Direction & Required conventions used in tables

| Value | Meaning |
|---|---|
| `in` | The node reads this field from the input message. |
| `out` | The node writes this field to the output message. |
| `both` | Read from input and (typically transformed) written to output. |
| `required` | The node throws or errors if the field is absent. |
| `optional` | The node has a fallback (default value, alternative field, or node config). |
| `conditional` | Required only for a specific operation/command — see Description. |

**Source citations name the enclosing file and function**, not a line number.
Earlier revisions of this document cited line numbers; a repository-wide
formatting pass invalidated every one of them at once, so the citations are
now anchored to symbols that survive reformatting. Grep for the function name
to find the code.

---

## Nodes

### opcua-endpoint (config)

This is a **configuration node**. It does not process `msg` objects at
runtime — it manages the shared TCP connection (via `OpcUaClientManager`) and
registers HTTP-admin routes for editor-side certificate upload. Worker nodes
referencing this endpoint do their own `msg` handling.

No runtime `msg.*` fields are read or written by `opcua-endpoint` itself.
See `nodes/opcua-endpoint.js` for the configuration and admin-route logic.

---

### opcua-client

The all-in-one client. Dispatches on `msg.operation` (or the configured
default operation). All output assignments are merged onto `msg` via
`Object.assign(msg, result)` in the node's `node.on("input")` handler.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.operation` | in | String | optional | Dispatch key. One of: `read`, `readmultiple`, `write`, `writemultiple`, `subscribe`, `unsubscribe`, `browse`, `method`, `history`, `getendpoints`, `readattribute`, `registernodes`, `unregisternodes`, `translatebrowsepath`. Falls back to the node's configured default operation, then to `read`. Echoed back on the output so downstream nodes can branch. | `opcua-client.js` · `node.on("input")` |
| `msg.topic` | in | String | optional | Target NodeId (legacy field). Accepted as an alias for `msg.nodeId` on read / write / subscribe / browse / method / history / readattribute / registernodes / translatebrowsepath. | `opcua-client.js` · `handleRead()`, `handleWrite()`, `handleBrowse()`, `handleMethod()`, `handleHistory()`, `handleReadAttribute()`, `handleSubscribe()`, `handleTranslateBrowsePath()` |
| `msg.nodeId` | both | String | optional | Target NodeId (preferred). On read / subscribe / browse / method / history outputs, the canonical NodeId of the request is echoed back. **Subscription value-change messages carry `msg.nodeId`, not `msg.topic`** — see the notes below. | `opcua-client.js` · `handleRead()`, `handleWrite()`, `handleBrowse()`, `handleHistory()`, `handleReadAttribute()`, `handleSubscribe()` |
| `msg.payload` | both | any | conditional | **In:** value to write (for `write`); array or object form for `readmultiple` / `writemultiple` shorthands; method input arguments fallback. **Out:** read value, browse references array, method output values, endpoint list, history values, etc. — whatever the operation produces. | `opcua-client.js` · `handleRead()`, `handleReadMultiple()`, `handleWrite()`, `handleWriteMultiple()`, `handleMethod()`, `handleHistory()`, `handleGetEndpoints()` |
| `msg.items` | both | Array | optional | Batch list `[{ nodeId, value?, datatype?, … }, …]`. **Presence forces batch mode** — a `read` becomes `readmultiple`, a `write` becomes `writemultiple`. On `readmultiple` / `writemultiple` output, the per-item results are returned in the same array. | `opcua-client.js` · `handleRead()`, `handleReadMultiple()`, `handleWrite()`, `handleWriteMultiple()`, `handleRegisterNodes()` |
| `msg.datatype` | in | String | optional | Single-write datatype hint (e.g. `Int32`, `Double`, `String`, `Boolean`, `ExtensionObject`). Auto-detected from the JS type when absent. A hint that does not match the variable's declared type is rejected by the server with `BadTypeMismatch` — it is not coerced. | `opcua-client.js` · `handleWrite()` |
| `msg.dataTypeNodeId` | in | String | conditional | DataType definition NodeId — required when writing an `ExtensionObject` so the structured type can be resolved. | `opcua-client.js` · `handleWrite()` |
| `msg.arrayType` | in | String | optional | Variant array type hint for a write (`Scalar` / `Array` / `Matrix`). | `opcua-client.js` · `handleWrite()` |
| `msg.objectNodeId` | in | String | required (`method`) | Owning object NodeId for `method` operation. Falls back to `msg.topic`. | `opcua-client.js` · `handleMethod()` |
| `msg.methodNodeId` | in | String | required (`method`) | Method NodeId for `method` operation. | `opcua-client.js` · `handleMethod()` |
| `msg.inputArguments` | in | Array | optional | Method input arguments. Falls back to `msg.payload` if absent. | `opcua-client.js` · `handleMethod()` |
| `msg.startTime` | in | Date \| String | conditional | History read start time. Falls back to `msg.payload.startTime`, then to "1 hour ago". | `opcua-client.js` · `handleHistory()` |
| `msg.endTime` | in | Date \| String | conditional | History read end time. Falls back to `msg.payload.endTime`, then to "now". | `opcua-client.js` · `handleHistory()` |
| `msg.maxValues` | in | Number | optional | History read sample-count cap (default `1000`). | `opcua-client.js` · `handleHistory()` |
| `msg.endpointUrl` | in | String | optional (`getendpoints`) | Endpoint URL to query. Falls back to `msg.payload`, then to the configured endpoint. | `opcua-client.js` · `handleGetEndpoints()` |
| `msg.attributeId` | in | String \| Number | optional (`readattribute`) | Attribute name or numeric id (default `Value`). Examples: `BrowseName`, `DisplayName`, `Description`. | `opcua-client.js` · `handleReadAttribute()` |
| `msg.startNodeId` | in | String | optional (`translatebrowsepath`) | Browse-path starting NodeId (default `i=84` — RootFolder). Also accepted as `msg.topic`. | `opcua-client.js` · `handleTranslateBrowsePath()` |
| `msg.browsePath` | in | String \| Array | required (`translatebrowsepath`) | Browse path expression, e.g. `/1:TestData`. The namespace index in each path segment must match the server's — a mismatch yields `BadNoMatch` with an empty target list, not an error. Falls back to `msg.payload`. | `opcua-client.js` · `handleTranslateBrowsePath()` |
| `msg.recursive` | in | Boolean | optional (`browse`) | Set `true` to recurse into child references (also configurable in node UI). | `opcua-client.js` · browse path |
| `msg.interval` | in | Number | optional (`subscribe`) | Subscription publishing interval in ms (default `1000`). | `opcua-client.js` · `handleSubscribe()` |
| `msg.queueSize` | in | Number | optional (`subscribe`) | Per-monitored-item queue size (default `10`). | `opcua-client.js` · `handleSubscribe()` |
| `msg.unwrapSingle` | in | Boolean | optional | Deliver the scalar value in `msg.payload` when a read resolves to exactly one item, instead of a one-element array. Also a node-level option. | `opcua-client.js` · `OpcUaClientNode()`, `handleReadMultiple()` |
| `msg.statusCode` | out | String | — | OPC UA status code, e.g. `"Good (0x00000000)"`, on read / write / subscribe / method / history. **A Bad status is reported here, not thrown** — see the notes below. | `opcua-client.js` · `handleRead()`, `handleWrite()`, `handleMethod()`, `handleHistory()`, `handleSubscribe()` |
| `msg.sourceTimestamp` | out | Date | — | DataValue `sourceTimestamp` echoed on read / subscribe results. Comes from the OPC UA server's view of when the value was sampled. | `opcua-client.js` · `handleRead()`, `handleSubscribe()`; `lib/opcua-client-manager.js` · `read()`, `readMultiple()` |
| `msg.serverTimestamp` | out | Date | — | DataValue `serverTimestamp` echoed on read / subscribe results. Comes from the OPC UA server's clock when the value was placed on the wire. | `opcua-client.js` · `handleRead()`, `handleSubscribe()`; `lib/opcua-client-manager.js` · `read()`, `readMultiple()` |
| `msg.count` | out | Number | — | Number of items in the result (set by `readmultiple`, `writemultiple`, `browse`, `getendpoints`, `history`). | `opcua-client.js` · `handleReadMultiple()`, `handleWriteMultiple()`, `handleBrowse()`, `handleGetEndpoints()`, `handleHistory()` |
| `msg.references` | out | Array | — | Raw `ReferenceDescription` objects on `browse`, alongside the simplified `msg.payload` list. | `opcua-client.js` · `handleBrowse()` |
| `msg.browseResult` | out | Object | — | Raw browse-result object on `browse` (referenced by the in-tree browse helpers). | `opcua-client.js` · browse path |
| `msg.recursiveResult` | out | Array | — | Recursive `browse` traversal result (set when `msg.recursive === true`). | `opcua-client.js` · browse path |
| `msg.outputArguments` | out | Array | — | Raw `Variant` array of method outputs (in addition to the simplified `msg.payload` value list). | `opcua-client.js` · `handleMethod()` |
| `msg.methodResult` | out | Object | — | Full method-call result object from node-opcua: `{ statusCode, outputArguments, inputArgumentResults, … }`. | `opcua-client.js` · `handleMethod()` |
| `msg.error` | out | Object | — | Error object from `lib/opcua-utils.js::createError(message, error)` of shape `{ message, error, stack }`, set on every error path. | `opcua-client.js` · `node.on("input")` |

**Notes:**

- A `read` or `write` operation is silently upgraded to `readmultiple` /
  `writemultiple` whenever a non-empty `msg.items` array is present. Plan for
  this when chaining `opcua-item` collectors.
- **Subscription value-change messages carry `msg.nodeId` but not
  `msg.topic`.** The `"Subscribed"` / `"Already subscribed"` acknowledgements
  spread the triggering message and therefore *do* keep `msg.topic`. Route on
  `msg.nodeId` when one client subscribes to several NodeIds. (`opcua-event`
  differs — it sets `msg.topic` on every event delivery.)
- **A Bad OPC UA status is not an error.** Reading an unknown NodeId returns a
  message with `msg.statusCode === "BadNodeIdUnknown (0x80340000)"` and
  `msg.payload === null`; `msg.error` stays unset and no Catch node fires.
  Check `msg.statusCode` when a Bad status must branch the flow. `msg.error`
  is reserved for transport, session and argument-validation failures.
- An array-typed variable is delivered as the **typed array** node-opcua
  produces (`Int32Array`, `Float64Array`, …), not a plain `Array`. `Boolean`
  and `String` arrays do arrive as plain arrays. `JSON.stringify` renders a
  typed array as an object — use `Array.from()` before serializing.

---

### opcua-server

Embedded OPC UA server. Address-space mutation and event raising are driven
by `msg.command` plus per-command parameter fields.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.command` | in | String | required | Address-space command. One of: `addFolder`, `addVariable`, `addObject`, `addMethod`, `setValue`, `setWritable`, `deleteNode`, `getServerInfo`, `getNamespaceIndex`, `raiseEvent`. Also accepted as `msg.payload.command`. An unknown command raises `Unknown command: <name>`. | `opcua-server.js` · `node.on("input")` |
| `msg.folderName` | in | String | conditional | Required for `addFolder`. | `opcua-server.js` · `handleAddFolder()` |
| `msg.parentNodeId` | in | String | conditional | Parent NodeId for `addFolder` / `addVariable` / `addObject` (default `ObjectsFolder`). **Required** for `addMethod` and must reference an Object node (e.g. one created via `addObject`) — OPC UA does not allow methods directly under the standard Objects folder. | `opcua-server.js` · `handleAddFolder()`, `handleAddVariable()`, `handleAddMethod()`, `handleAddObject()` |
| `msg.variableName` | in | String | conditional | Required for `addVariable`. | `opcua-server.js` · `handleAddVariable()` |
| `msg.datatype` | in | String | optional | Variable datatype for `addVariable` (default `Double`), and an explicit type override for `setValue`. **Optional on `setValue` since 0.2.0** — the variable's own declared DataType is used when it is absent (before 0.2.0 a missing `msg.datatype` silently coerced the write to `Double`, which failed on every non-`Double` variable). | `opcua-server.js` · `handleAddVariable()`, `resolveSetValueDataType()` |
| `msg.initialValue` | in | any | optional | Initial value for `addVariable`. | `opcua-server.js` · `handleAddVariable()` |
| `msg.objectName` | in | String | conditional | Required for `addObject`. | `opcua-server.js` · `handleAddObject()` |
| `msg.methodName` | in | String | conditional | Required for `addMethod`. | `opcua-server.js` · `handleAddMethod()` |
| `msg.inputArguments` | in | Array | optional | Argument list for `addMethod` registration: `[{ name, dataType, valueRank, … }]`. | `opcua-server.js` · `handleAddMethod()` |
| `msg.outputArguments` | in | Array | optional | Output-argument list for `addMethod` registration. | `opcua-server.js` · `handleAddMethod()` |
| `msg.func` | in | String | conditional (`addMethod`) | **DANGER — opt-in since 0.2.0.** JavaScript function body string used by `addMethod`. The server evaluates it via `new Function(...)`, so it is rejected unless *Allow method code from `msg.func`* is enabled on the server node. Only accept this from trusted flow authors; treat any inbound flow that supplies `msg.func` as a privileged path. The body is called as `(inputArguments, context, Variant, DataType, StatusCodes)` and must return `{ statusCode, outputArguments }`. | `opcua-server.js` · `OpcUaServerNode()`, `handleAddMethod()` |
| `msg.nodeId` | both | String | conditional | **In:** target NodeId for `setValue`, `setWritable`, `deleteNode`, `raiseEvent`; or explicit NodeId override on `addFolder` / `addVariable` / `addObject`. **Out:** the NodeId of the node just created or addressed. Also accepted as `msg.topic` on commands that look up by `msg.nodeId \|\| msg.topic`. | `opcua-server.js` · `handleAddFolder()`, `handleAddVariable()`, `handleAddObject()`, `handleSetValue()`, `handleSetWritable()`, `handleDeleteNode()` |
| `msg.topic` | in | String | optional | Alias for `msg.nodeId` on `setValue`, `setWritable` and `deleteNode`. | `opcua-server.js` · `handleSetValue()`, `handleSetWritable()`, `handleDeleteNode()` |
| `msg.payload` | both | any | conditional | **In:** new value for `setValue`; also a fallback for parameter fields (`msg.payload.command`, `msg.payload.folderName`, `msg.payload.variableName`, etc.). **Out:** the created NodeId string on the `add*` commands, the written value on `setValue`, a server-info object on `getServerInfo`, and an error envelope on the error path. | `opcua-server.js` · `node.on("input")`, `handleAddVariable()`, `handleSetValue()` |
| `msg.namespaceIndex` | out | Number | — | Own-namespace index, returned by `getNamespaceIndex`. This command sets `msg.namespaceIndex` **only** — unlike the other commands it leaves `msg.payload` untouched. | `opcua-server.js` · `node.on("input")` |
| `msg.eventType` | in | String | optional (`raiseEvent`) | Event type NodeId or BrowseName (default `BaseEventType`). | `opcua-server.js` · `handleRaiseEvent()` |
| `msg.sourceNodeId` | in | String | conditional (`raiseEvent`) | Source-node NodeId of the raised event. | `opcua-server.js` · `handleRaiseEvent()` |
| `msg.message` | in | String | optional (`raiseEvent`) | Human-readable event message text. | `opcua-server.js` · `handleRaiseEvent()` |
| `msg.severity` | in | Number | optional (`raiseEvent`) | Event severity (default `100`). | `opcua-server.js` · `handleRaiseEvent()` |
| `msg.statusCode` | out | String | — | `"Good (0x00000000)"` after a successful `setValue`. | `opcua-server.js` · `handleSetValue()` |
| `msg.error` | out | String | — | Set with the error message on any failure path; `msg.payload` is also set to `{ error }` for downstream debug nodes. | `opcua-server.js` · `node.on("input")` |

**Notes:**

- Several command parameters accept a fallback chain
  `msg.<field> || msg.payload?.<field>` to support flows that bundle the
  entire command in `msg.payload`. Both styles are first-class.
- `msg.itemName` is **not** a field this node reads; see `opcua-item` below.
- See `## Trust note: msg.func` at the end of this file.

---

### opcua-item

Item collector. Defines a single OPC UA item and either appends it to
`msg.items` (collector mode, default) or sets it on `msg.topic` /
`msg.nodeId` / `msg.datatype` (legacy mode).

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.payload` | in | any | optional | Used as the value for the item when `msg.operation` is `write` or `writemultiple`. | `opcua-item.js` · `node.on("input")` |
| `msg.operation` | in | String | optional | Read to decide whether to attach `msg.payload` as `item.value`. | `opcua-item.js` · `node.on("input")` |
| `msg.items` | both | Array | optional | **Collector mode (default):** the item is appended to this array (created if missing). **Legacy mode:** read but not written. | `opcua-item.js` · `node.on("input")` |
| `msg.unwrapSingle` | out | Boolean | — | Set when the node's *Unwrap single value* option is on, so the downstream client delivers a scalar for a one-item read. | `opcua-item.js` · `node.on("input")` |
| `msg.topic` | out | String | — | **Legacy mode only:** set to the item's NodeId. | `opcua-item.js` · `node.on("input")` |
| `msg.nodeId` | out | String | — | **Legacy mode only:** set to the item's NodeId. | `opcua-item.js` · `node.on("input")` |
| `msg.datatype` | out | String | — | **Legacy mode only:** set to the item's datatype if defined. | `opcua-item.js` · `node.on("input")` |
| `msg.itemName` | out | String | — | **Legacy mode only:** set to the item's friendly name if defined. | `opcua-item.js` · `node.on("input")` |

**Notes:**

- Chain pattern: multiple `opcua-item` nodes in series each append one entry
  to `msg.items`. The downstream `opcua-client` receives the full batch.
- In collector mode the node never sets `msg.topic` / `msg.nodeId` /
  `msg.datatype` — those outputs are exclusive to legacy mode.

---

### opcua-event

Subscribes to OPC UA events / alarms on a source node.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.action` | in | String | optional | `"subscribe"` (default) or `"unsubscribe"`. Falls back to `msg.operation`. | `opcua-event.js` · `node.on("input")` |
| `msg.operation` | both | String | optional | **In:** alias for `msg.action`. **Out:** set to `"event"` on event-delivery messages (assembled in the event payload). | `opcua-event.js` · `node.on("input")` |
| `msg.sourceNodeId` | in | String | optional | Source node to monitor. Falls back to `msg.topic`, then to the node's configured source NodeId. | `opcua-event.js` · `node.on("input")` |
| `msg.topic` | both | String | optional | **In:** alias for `msg.sourceNodeId`. **Out:** set to the source NodeId on event-delivery messages. | `opcua-event.js` · `node.on("input")` |
| `msg.eventType` | in | String | optional | Event-type filter NodeId (e.g. `BaseEventType`, `AlarmConditionType`). Falls back to node config. | `opcua-event.js` · `node.on("input")` |
| `msg.interval` | in | Number | optional | Subscription / sampling interval in ms (default `500`). | `opcua-event.js` · `node.on("input")` |
| `msg.payload` | out | Object \| String | — | **Subscribe acknowledgement:** a status string. **Per-event delivery:** an object with `{ eventId, eventType, sourceNode, sourceName, time, receiveTime, message, severity, … }` — i.e. the decoded event field map. | `opcua-event.js` · `node.on("input")`, event delivery |
| `msg.message` | out | String | — | Convenience copy of the event message text (sub-field of the event payload, surfaced for debug nodes). | `opcua-event.js` · event delivery |
| `msg.severity` | out | Number | — | Event severity (sub-field of the event payload, surfaced for debug nodes). | `opcua-event.js` · event delivery |
| `msg.error` | out | Object | — | Error object from `createError()`. | `opcua-event.js` · `node.on("input")` |

**Notes:**

- `msg.message` and `msg.severity` are part of the event payload object; they
  are listed here as top-level fields because they are surfaced as message
  properties for downstream nodes.
- A successful subscribe on a server that never raises an event produces the
  acknowledgement message and nothing further. Silence is not a failure.

---

### opcua-method

Calls a method on the OPC UA server.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.methodNodeId` | in | String | required | Method NodeId. Falls back to node config. | `opcua-method.js` · `node.on("input")` |
| `msg.objectNodeId` | in | String | required | Owning object NodeId. Falls back to node config, then to `msg.topic`. | `opcua-method.js` · `node.on("input")` |
| `msg.topic` | in | String | optional | Alias for `msg.objectNodeId` when neither the message nor the node config supplies one. | `opcua-method.js` · `node.on("input")` |
| `msg.inputArguments` | in | Array | optional | Method input arguments. Falls back to `msg.payload` (treated as the input array). | `opcua-method.js` · `node.on("input")` |
| `msg.payload` | both | any | optional | **In:** fallback for `msg.inputArguments`. **Out:** simplified array of output-argument values. | `opcua-method.js` · `node.on("input")` |
| `msg.methodResult` | out | Object | — | Full result object from `node-opcua` `methodCall` (incl. `inputArgumentResults`, `outputArguments`, `statusCode`). | `opcua-method.js` · `node.on("input")` |
| `msg.statusCode` | out | StatusCode | — | OPC UA status code of the method call. | `opcua-method.js` · `node.on("input")` |
| `msg.error` | out | Object | — | Error object from `createError()`. | `opcua-method.js` · `node.on("input")` |

---

### opcua-browser

Browses the OPC UA address space starting from a given NodeId.

**Since 0.2.0** a browse follows `HierarchicalReferences` only — the same filter
the editor tree and node-opcua's own default use. Before that it returned *every*
reference type, mixing `HasTypeDefinition` / `HasSubtype` links into the children
of an address-space browse.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.topic` | in | String | optional | Starting NodeId. Falls back to `msg.nodeId`, then to `config.startNodeId`, then to `RootFolder`. | `opcua-browser.js` · `node.on("input")` |
| `msg.nodeId` | both | String | optional | **In:** alias for `msg.topic`. **Out:** set to the NodeId actually browsed. | `opcua-browser.js` · `node.on("input")` |
| `msg.recursive` | in | Boolean | optional | Recurse into child references when `true`. Also configurable in node UI. | `opcua-browser.js` · `node.on("input")` |
| `msg.startNodeId` | in | String | optional | Alternative starting-NodeId field (read by the underlying browse helper). Equivalent to `msg.topic` for the basic browse flow. | `opcua-client.js` · `handleTranslateBrowsePath()` (browse helper shared with `opcua-browser`) |
| `msg.payload` | out | Array | — | Array of browse references: `[{ browseName, nodeId, nodeClass, typeDefinition, isForward }, …]`. **Since 0.2.0** `nodeClass` is the readable name (`"Variable"`, `"Object"`), not the raw `NodeClass` enum number. | `opcua-browser.js` · `node.on("input")` |
| `msg.browseResult` | out | Object | — | Raw browse-result object from `node-opcua`. | `opcua-browser.js` · `node.on("input")` |
| `msg.recursiveResult` | out | Array | — | Recursive traversal result when `msg.recursive === true`. Before 0.2.0 the `children` arrays were always empty. | `opcua-browser.js` · `node.on("input")` |
| `msg.error` | out | String | — | Error message string. | `opcua-browser.js` · `node.on("input")` |

---

### opcua-browse-client

Interactive browser with editor tree-view selection. At runtime, dispatches
on `msg.operation` (or the configured mode) and emits read or subscribe
results.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.operation` | both | String | optional | **In:** runtime override — `read` / `readmultiple` / `subscribe` / `unsubscribe`. Falls back to the node's configured mode. **Out:** echoed as `"readmultiple"` after a read. | `opcua-browse-client.js` · `node.on("input")` |
| `msg.nodeId` | in | String | optional | Optional NodeId override for the underlying client manager. | `opcua-browse-client.js` · read/subscribe path |
| `msg.interval` | in | Number | optional | Subscribe publishing interval in ms. | `opcua-browse-client.js` · subscribe path |
| `msg.queueSize` | in | Number | optional | Subscribe per-item queue size. | `opcua-browse-client.js` · subscribe path |
| `msg.payload` | out | any | — | **Read:** array of enriched values. **Subscribe ack:** status string. **Unsubscribe ack:** `"Unsubscribed"`. | `opcua-browse-client.js` · `node.on("input")` |
| `msg.count` | out | Number | — | Item count after a read. | `opcua-browse-client.js` · `node.on("input")` |
| `msg.statusCode` | out | StatusCode | — | OPC UA status code (per emitted item, on subscription value-change messages). | `opcua-browse-client.js` · subscription delivery path |
| `msg.sourceTimestamp` | out | Date | — | DataValue source timestamp (per emitted item, on subscription value-change messages). | `lib/opcua-client-manager.js` · `readMultiple()`, subscription delivery |
| `msg.serverTimestamp` | out | Date | — | DataValue server timestamp (per emitted item, on subscription value-change messages). | `lib/opcua-client-manager.js` · `readMultiple()`, subscription delivery |
| `msg.error` | out | Object | — | Error object from `createError()`. | `opcua-browse-client.js` · `node.on("input")` |

---

### opcua-pubsub-connection (config)

This is a **configuration node**. It owns the shared, ref-counted PubSub
transport (UDP multicast socket or MQTT client) and the PublisherId. It does
not process `msg` objects at runtime — the `opcua-publisher` and
`opcua-subscriber` worker nodes reference it and do their own `msg` handling.

No runtime `msg.*` fields are read or written by `opcua-pubsub-connection`
itself. See `nodes/opcua-pubsub-connection.js` and `lib/transports/` for the
transport lifecycle.

---

### opcua-publisher

Publishes a DataSet as a UADP or JSON NetworkMessage over the referenced
`opcua-pubsub-connection`.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.payload` | both | Object | optional | **In:** field map `{ <fieldName>: <rawValue> }`. Each declared PublishedDataSet field present in the map becomes a Variant in one keyframe; **missing fields are omitted, never fabricated**. A non-object payload is treated as an empty map. **Out:** the inbound message is passed through unchanged. | `opcua-publisher.js` · `node.on("input")` |

**Notes:**

- **Acyclic mode** (default): one inbound `msg` produces exactly one outbound
  NetworkMessage.
- **Cyclic mode**: inbound values are merged into the node's latest-value
  snapshot and published every `publishingInterval` ms — a keyframe when a
  value changed since the last tick, a **KeepAlive** NetworkMessage when
  nothing changed. Allow at least one full interval before asserting that a
  KeepAlive arrived.
- The node passes the inbound message through on its output in both modes; the
  NetworkMessage itself goes to the transport, not to the wire.
- Everything else — encoding, PublisherId, WriterGroup id, DataSetWriter list,
  publishing interval, MTU — is node/connection configuration, not message
  fields.

---

### opcua-subscriber

Receives NetworkMessages from the referenced `opcua-pubsub-connection` and
emits **one `msg` per matched DataSetMessage**. It has no input; every field
below is an output.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.payload` | out | Object | — | `{ [fieldName]: value }` — the decoded DataSetMessage field map with Variant / DataValue wrappers removed. | `opcua-subscriber.js` · `handleNetworkMessage()` |
| `msg.publisherId` | out | String \| Number | — | PublisherId of the source connection. | `opcua-subscriber.js` · `handleNetworkMessage()` |
| `msg.writerGroupId` | out | UInt16 | — | WriterGroup id. **`undefined` for JSON encoding** — JSON NetworkMessages carry no `groupHeader`. | `opcua-subscriber.js` · `handleNetworkMessage()` |
| `msg.dataSetWriterId` | out | UInt16 | — | DataSetWriter id. | `opcua-subscriber.js` · `handleNetworkMessage()` |
| `msg.sequenceNumber` | out | UInt32 | — | NetworkMessage sequence number, falling back to the DataSetMessage's own sequence number (JSON). | `opcua-subscriber.js` · `handleNetworkMessage()` |
| `msg.timestamp` | out | Date | — | DataSetMessage timestamp, falling back to the NetworkMessage timestamp, then to `new Date()`. | `opcua-subscriber.js` · `handleNetworkMessage()` |
| `msg.statusCode` | out | Number | — | 16-bit DataSetMessage **status summary** (`0` = Good) per Part 14 §7.2.4.5.2 — **not** a full 32-bit OPC UA StatusCode. Do not compare it against `StatusCodes` constants. | `opcua-subscriber.js` · `handleNetworkMessage()` |
| `msg.encoding` | out | String | — | `"uadp"` or `"json"`. | `opcua-subscriber.js` · `handleNetworkMessage()` |
| `msg.transport` | out | String | — | `"udp"` or `"mqtt"`. | `opcua-subscriber.js` · `handleNetworkMessage()` |
| `msg.topic` | out | String | — | Source MQTT topic. **MQTT only — the field is omitted entirely for UDP**, not set to `undefined`. | `opcua-subscriber.js` · `handleNetworkMessage()` |

**Notes:**

- A matched DataSetMessage whose ConfigurationVersion differs from the
  optional `expectedConfigVersion` raises a visible `node.error()` and is
  dropped from the output — it is never silently swallowed.
- A decode failure is reported via `node.error()` and never thrown out of the
  transport callback, so a malformed datagram cannot take down the shared
  transport or sibling subscribers.

---

## Trust note: msg.func

The `opcua-server` node reads `msg.func` for the `addMethod` command and
evaluates its body via `new Function(...)`. This is **arbitrary code
execution by design** — the node ships an embedded OPC UA server and the
`addMethod` command exists to let flow authors define server methods at
deploy time.

Unlike a Function node, that body arrives with the **message**, not from the
editor, so an `http in` / MQTT / TCP source upstream turns it into a remote
code execution path into the Node-RED process.

**Since 0.2.0 it is opt-in per server node.** Enable *Allow method code from
`msg.func`* under **Security** in the node configuration; with the option off
(the default) `addMethod` rejects a message carrying `msg.func` with an
explanatory error. `addMethod` without `msg.func` is unaffected. Treat any flow
path that can supply `msg.func` from outside the trusted flow author as a
privileged surface.

---

## Coverage cross-check

The acceptance grep:

```bash
grep -rhnE "msg\.[a-zA-Z_]+" nodes/*.js lib/*.js | grep -oE "msg\.[a-zA-Z_]+" | sort -u
```

…enumerates the following 45 distinct field names:

`msg.action`, `msg.arrayType`, `msg.attributeId`, `msg.browsePath`,
`msg.browseResult`, `msg.command`, `msg.count`, `msg.dataTypeNodeId`,
`msg.datatype`, `msg.endTime`, `msg.endpointUrl`, `msg.error`,
`msg.eventType`, `msg.folderName`, `msg.func`, `msg.initialValue`,
`msg.inputArguments`, `msg.interval`, `msg.itemName`, `msg.items`,
`msg.maxValues`, `msg.message`, `msg.methodName`, `msg.methodNodeId`,
`msg.methodResult`, `msg.nodeId`, `msg.objectName`, `msg.objectNodeId`,
`msg.operation`, `msg.outputArguments`, `msg.parentNodeId`, `msg.payload`,
`msg.queueSize`, `msg.recursive`, `msg.recursiveResult`,
`msg.sequenceNumber`, `msg.severity`, `msg.sourceNodeId`, `msg.startNodeId`,
`msg.startTime`, `msg.statusCode`, `msg.timestamp`, `msg.topic`,
`msg.unwrapSingle`, `msg.variableName`

**The grep alone is not sufficient.** It only finds `msg.<field>` member
expressions, so it misses fields introduced as object-literal keys on a
message that is built and then sent. The `opcua-subscriber` output message is
built that way, so `msg.publisherId`, `msg.writerGroupId`,
`msg.dataSetWriterId`, `msg.encoding` and `msg.transport` do **not** appear in
the grep output — likewise `msg.sourceTimestamp`, `msg.serverTimestamp`,
`msg.references` and `msg.namespaceIndex`, which are assembled into result
objects and merged onto `msg` via `Object.assign`. All of them are documented
in the per-node tables above. When adding a field, add it to the table
directly; do not rely on the grep to discover it.

---

*Document version: v1.1 (2026-08-28). Supersedes v1.0 (2026-05-08), which
covered eight nodes and cited source line numbers. See `CHANGELOG.md` for any
field renames during the v0.x series.*
