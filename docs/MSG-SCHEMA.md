# OPC UA Suite — Message Schema Reference

**Version:** v1.0 (2026-05-08)
**Scope:** Existing eight nodes (v0.0.7 and later)

This document is the authoritative reference for every `msg.*` field that the
eight nodes in this package read from input messages or write to output
messages. Use it before adding a new field — both to discover what is already
there and to avoid silent collisions with planned PubSub fields (see
`## Reserved for v0.1.0 (PubSub)` at the end).

The breakdown was derived by reading the source files referenced in each
`Source` column and cross-checking with:

```bash
grep -rhnE "msg\.[a-zA-Z_]+" nodes/*.js lib/*.js | grep -oE "msg\.[a-zA-Z_]+" | sort -u
```

---

## v1.0 Stability Statement

The fields listed below are the **v1.0 message contract** for the eight
existing nodes (`opcua-endpoint`, `opcua-client`, `opcua-server`, `opcua-item`,
`opcua-event`, `opcua-method`, `opcua-browser`, `opcua-browse-client`).
Once v1.0.0 is released:

- Field **names**, **types**, and **directions** (in / out / both) are stable
  and will not change without a major version bump.
- Optional fields may gain new accepted values; required fields will not be
  added.
- Output fields will not be removed; new output fields may be added (additive).
- During the v0.x series, field renames are still possible but will be
  explicitly called out in `CHANGELOG.md` for the release that introduces them.

The `## Reserved for v0.1.0 (PubSub)` section at the bottom lists fields that
are **reserved** for the upcoming PubSub work. They are guaranteed to mean
what is written there once introduced — no existing v1.0 node will overload
those names.

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

Source citations refer to lines in the linked file at the time of v1.0; minor
line-number drift across patch releases is expected and not a contract change.

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
`Object.assign(msg, result)` at `nodes/opcua-client.js:244`.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.operation` | in | String | optional | Dispatch key. One of: `read`, `readmultiple`, `write`, `writemultiple`, `subscribe`, `unsubscribe`, `browse`, `method`, `history`, `getendpoints`, `readattribute`, `registernodes`, `translatebrowsepath`. Falls back to the node's configured default operation. | nodes/opcua-client.js:214 |
| `msg.topic` | in | String | optional | Target NodeId (legacy field). Accepted as an alias for `msg.nodeId` on read / write / subscribe / browse / method / history / readattribute / translatebrowsepath. | nodes/opcua-client.js:301, 384, 496, 550, 566, 615, 647, 690 |
| `msg.nodeId` | both | String | optional | Target NodeId (preferred). On read/subscribe/browse/method/history outputs, the canonical NodeId of the request is echoed back. | nodes/opcua-client.js:301, 384, 496, 535, 550, 647 |
| `msg.payload` | both | any | conditional | **In:** value to write (for `write`); array or object form for `readmultiple` / `writemultiple` shorthands; method input arguments fallback. **Out:** read value, browse references array, method output values, endpoint list, history values, etc. — whatever the operation produces. | nodes/opcua-client.js:325, 389, 416, 606, 641, 698 |
| `msg.items` | both | Array | optional | Batch list `[{ nodeId, value?, datatype?, … }, …]`. **Presence forces batch mode** — a `read` becomes `readmultiple`, a `write` becomes `writemultiple`. On `readmultiple` / `writemultiple` output, the per-item results are returned in the same array. | nodes/opcua-client.js:296–297, 325, 379–380, 664, 677 |
| `msg.datatype` | in | String | optional | Single-write datatype hint (e.g. `Int32`, `Double`, `String`, `Boolean`, `ExtensionObject`). Auto-detected from the JS type when absent. | nodes/opcua-client.js:400 |
| `msg.dataTypeNodeId` | in | String | conditional | DataType definition NodeId — required when writing an `ExtensionObject` so the structured type can be resolved. | nodes/opcua-client.js:401 |
| `msg.objectNodeId` | in | String | required (`method`) | Owning object NodeId for `method` operation. | nodes/opcua-client.js:588 |
| `msg.methodNodeId` | in | String | required (`method`) | Method NodeId for `method` operation. | nodes/opcua-client.js:589 |
| `msg.inputArguments` | in | Array | optional | Method input arguments. Falls back to `msg.payload` if absent. | nodes/opcua-client.js:598 |
| `msg.startTime` | in | Date \| String | conditional | History read start time. Falls back to `msg.payload.startTime`, then to "1 hour ago". | nodes/opcua-client.js:621 |
| `msg.endTime` | in | Date \| String | conditional | History read end time. Falls back to `msg.payload.endTime`, then to "now". | nodes/opcua-client.js:622 |
| `msg.maxValues` | in | Number | optional | History read sample-count cap (default `1000`). | nodes/opcua-client.js:625 |
| `msg.endpointUrl` | in | String | optional (`getendpoints`) | Endpoint URL to query. Falls back to `msg.payload`, then to the configured endpoint. | nodes/opcua-client.js:639 |
| `msg.attributeId` | in | String | optional (`readattribute`) | Attribute name (default `Value`). Examples: `BrowseName`, `DisplayName`, `Description`. | nodes/opcua-client.js:652 |
| `msg.startNodeId` | in | String | optional (`translatebrowsepath`) | Browse-path starting NodeId (default `i=84` — RootFolder). Also accepted as `msg.topic`. | nodes/opcua-client.js:690 |
| `msg.browsePath` | in | String \| Array | required (`translatebrowsepath`) | Browse path expression. Falls back to `msg.payload`. | nodes/opcua-client.js:691 |
| `msg.recursive` | in | Boolean | optional (`browse`) | Set `true` to recurse into child references (also configurable in node UI). | nodes/opcua-client.js (browse path) |
| `msg.interval` | in | Number | optional (`subscribe`) | Subscription publishing interval in ms (default `1000`). | nodes/opcua-client.js:502 |
| `msg.queueSize` | in | Number | optional (`subscribe`) | Per-monitored-item queue size (default `10`). | nodes/opcua-client.js:503 |
| `msg.statusCode` | out | String | — | OPC UA status code, e.g. `"Good (0x00000000)"`, on read / write / subscribe / method / history. | nodes/opcua-client.js:312, 405, 535, 608, 630, 656, 698 |
| `msg.sourceTimestamp` | out | Date | — | DataValue `sourceTimestamp` echoed on read / subscribe results. Comes from the OPC UA server's view of when the value was sampled. | nodes/opcua-client.js:313, 536; lib/opcua-client-manager.js:440, 506, 558, 740 |
| `msg.serverTimestamp` | out | Date | — | DataValue `serverTimestamp` echoed on read / subscribe results. Comes from the OPC UA server's clock when the value was placed on the wire. | nodes/opcua-client.js:314, 537; lib/opcua-client-manager.js:441, 507, 559, 741 |
| `msg.count` | out | Number | — | Number of items in the result (set by `readmultiple`, `writemultiple`, `browse`, `getendpoints`, `history`). | nodes/opcua-client.js:372, 481, 581, 632, 641 |
| `msg.browseResult` | out | Object | — | Raw browse-result object on `browse` (referenced by the in-tree browse helpers). | (browse path of `nodes/opcua-client.js`; see also nodes/opcua-browser.js:83) |
| `msg.recursiveResult` | out | Array | — | Recursive `browse` traversal result (set when `msg.recursive === true`). | (recursive browse path of `nodes/opcua-client.js`; see also nodes/opcua-browser.js:89) |
| `msg.outputArguments` | out | Array | — | Raw `Variant` array of method outputs (in addition to the simplified `msg.payload` value list). Set on the `method` operation. | nodes/opcua-client.js (method path; see also nodes/opcua-server.js:315 for the addMethod input-side parameter list) |
| `msg.methodResult` | out | Object | — | Full method-call result object from node-opcua: `{ statusCode, outputArguments, inputArgumentResults, … }`. | nodes/opcua-client.js:607 |
| `msg.error` | out | Object | — | Error object from `lib/opcua-utils.js::createError(message, error)` of shape `{ message, error, stack }`, set on every error path. | nodes/opcua-client.js:251 |

**Notes:**

- The `Source` lines reference the canonical read-site (for `in`) or
  write-site (for `out`) of each field. Some fields have multiple sites; one
  representative line per direction is cited — not every occurrence.
- A `read` or `write` operation is silently upgraded to `readmultiple` /
  `writemultiple` whenever a non-empty `msg.items` array is present. Plan for
  this when chaining `opcua-item` collectors.

---

### opcua-server

Embedded OPC UA server. Address-space mutation and event raising are driven
by `msg.command` plus per-command parameter fields.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.command` | in | String | required | Address-space command. One of: `addFolder`, `addVariable`, `addObject`, `addMethod`, `setValue`, `setWritable`, `deleteNode`, `getServerInfo`, `raiseEvent`. Also accepted as `msg.payload.command`. | nodes/opcua-server.js:83 |
| `msg.folderName` | in | String | conditional | Required for `addFolder`. | nodes/opcua-server.js:166 |
| `msg.parentNodeId` | in | String | conditional | Parent NodeId for `addFolder` / `addVariable` / `addObject` (default `ObjectsFolder`). **Required** for `addMethod` and must reference an Object node (e.g. one created via `addObject`) — OPC UA does not allow methods directly under the standard Objects folder. | nodes/opcua-server.js:167, 187, 278, 363 |
| `msg.variableName` | in | String | conditional | Required for `addVariable`. | nodes/opcua-server.js:186 |
| `msg.datatype` | in | String | optional | Variable datatype for `addVariable` (default `Double`). | nodes/opcua-server.js:188 |
| `msg.initialValue` | in | any | optional | Initial value for `addVariable`. | nodes/opcua-server.js:189 |
| `msg.objectName` | in | String | conditional | Required for `addObject`. | nodes/opcua-server.js:362 |
| `msg.methodName` | in | String | conditional | Required for `addMethod`. | nodes/opcua-server.js:277 |
| `msg.inputArguments` | in | Array | optional | Argument list for `addMethod` registration: `[{ name, dataType, valueRank, … }]`. | nodes/opcua-server.js:309 |
| `msg.outputArguments` | in | Array | optional | Output-argument list for `addMethod` registration. | nodes/opcua-server.js:315 |
| `msg.func` | in | String | conditional (`addMethod`) | **DANGER:** JavaScript function body string used by `addMethod`. Server evaluates it via `new Function(...)` — only accept this from trusted flow authors. Treat any inbound flow that supplies `msg.func` as a privileged path. The body is called as `(inputArguments, context, Variant, DataType, StatusCodes)` and must return `{ statusCode, outputArguments }`. | nodes/opcua-server.js:328 |
| `msg.nodeId` | in | String | conditional | Target NodeId for `setValue`, `setWritable`, `deleteNode`, `raiseEvent`; or explicit NodeId override on `addFolder` / `addVariable` / `addObject`. Also accepted as `msg.topic` on commands that look up by `msg.nodeId \|\| msg.topic`. | nodes/opcua-server.js:175, 210, 224, 257, 323, 372, 398 |
| `msg.topic` | in | String | optional | Alias for `msg.nodeId` on `setValue` and `deleteNode`. | nodes/opcua-server.js:224, 257, 398 |
| `msg.payload` | both | any | conditional | **In:** new value for `setValue`; also a fallback for parameter fields (`msg.payload.command`, `msg.payload.folderName`, `msg.payload.variableName`, etc.). **Out:** server-info object on `getServerInfo`; error envelope on the error path. | nodes/opcua-server.js:83, 138, 225 |
| `msg.eventType` | in | String | optional (`raiseEvent`) | Event type NodeId or BrowseName (default `BaseEventType`). | nodes/opcua-server.js:420 |
| `msg.sourceNodeId` | in | String | conditional (`raiseEvent`) | Source-node NodeId of the raised event. | nodes/opcua-server.js:421 |
| `msg.message` | in | String | optional (`raiseEvent`) | Human-readable event message text. | nodes/opcua-server.js:422 |
| `msg.severity` | in | Number | optional (`raiseEvent`) | Event severity (default `100`). | nodes/opcua-server.js:423 |
| `msg.error` | out | String \| Object | — | Set with the error message on any failure path; `msg.payload` is also set to `{ error }` for downstream debug nodes. | nodes/opcua-server.js:137–138 |

**Notes:**

- Several command parameters accept a fallback chain `msg.<field> || msg.payload?.<field>` to support flows that bundle the entire command in `msg.payload`. Both styles are first-class.
- `msg.itemName` is **not** a field this node reads; see `opcua-item` below.
- See `## Trust note: msg.func` at the end of this file.

---

### opcua-item

Item collector. Defines a single OPC UA item and either appends it to
`msg.items` (collector mode, default) or sets it on `msg.topic` /
`msg.nodeId` / `msg.datatype` (legacy mode).

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.payload` | in | any | optional | Used as the value for the item when `msg.operation` is `write` or `writemultiple`. | nodes/opcua-item.js:55–60 |
| `msg.operation` | in | String | optional | Read to decide whether to attach `msg.payload` as `item.value`. | nodes/opcua-item.js:56–57 |
| `msg.items` | both | Array | optional | **Collector mode (default):** the item is appended to this array (created if missing). **Legacy mode:** read but not written. | nodes/opcua-item.js:65–70 |
| `msg.topic` | out | String | — | **Legacy mode only:** set to the item's NodeId. | nodes/opcua-item.js:75 |
| `msg.nodeId` | out | String | — | **Legacy mode only:** set to the item's NodeId. | nodes/opcua-item.js:76 |
| `msg.datatype` | out | String | — | **Legacy mode only:** set to the item's datatype if defined. | nodes/opcua-item.js:77 |
| `msg.itemName` | out | String | — | **Legacy mode only:** set to the item's friendly name if defined. | nodes/opcua-item.js:78 |

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
| `msg.action` | in | String | optional | `"subscribe"` (default) or `"unsubscribe"`. Falls back to `msg.operation`. | nodes/opcua-event.js:54 |
| `msg.operation` | both | String | optional | **In:** alias for `msg.action`. **Out:** set to `"event"` on event-delivery messages (assembled in the event payload). | nodes/opcua-event.js:54 |
| `msg.sourceNodeId` | in | String | optional | Source node to monitor. Falls back to `msg.topic`, then to the node's configured source NodeId. | nodes/opcua-event.js:75 |
| `msg.topic` | both | String | optional | **In:** alias for `msg.sourceNodeId`. **Out:** set to the source NodeId on event-delivery messages. | nodes/opcua-event.js:75 |
| `msg.eventType` | in | String | optional | Event-type filter NodeId (e.g. `BaseEventType`, `AlarmConditionType`). Falls back to node config. | nodes/opcua-event.js:76 |
| `msg.interval` | in | Number | optional | Subscription / sampling interval in ms (default `500`). | nodes/opcua-event.js:82, 107 |
| `msg.payload` | out | Object \| String | — | **Subscribe acknowledgement:** a status string. **Per-event delivery:** an object with `{ eventId, eventType, sourceNode, sourceName, time, receiveTime, message, severity, … }` — i.e. the decoded event field map. | nodes/opcua-event.js:68, 130 |
| `msg.message` | out | String | — | Convenience copy of the event message text (sub-field of the event payload, surfaced for debug nodes). | nodes/opcua-event.js (event delivery payload assembly) |
| `msg.severity` | out | Number | — | Event severity (sub-field of the event payload, surfaced for debug nodes). | nodes/opcua-event.js (event delivery payload assembly) |
| `msg.error` | out | Object | — | Error object from `createError()`. | nodes/opcua-event.js:137 |

**Notes:**

- `msg.message` and `msg.severity` are part of the event payload object; they
  are listed here as top-level fields because they are surfaced as message
  properties for downstream nodes.

---

### opcua-method

Calls a method on the OPC UA server.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.methodNodeId` | in | String | required | Method NodeId. Falls back to node config. | nodes/opcua-method.js:54 |
| `msg.objectNodeId` | in | String | required | Owning object NodeId. Falls back to node config, then to `msg.topic`. | nodes/opcua-method.js:55 |
| `msg.topic` | in | String | optional | Alias for `msg.objectNodeId` when neither the message nor the node config supplies one. | nodes/opcua-method.js:55 |
| `msg.inputArguments` | in | Array | optional | Method input arguments. Falls back to `msg.payload` (treated as the input array). | nodes/opcua-method.js:66 |
| `msg.payload` | both | any | optional | **In:** fallback for `msg.inputArguments`. **Out:** simplified array of output-argument values. | nodes/opcua-method.js:66, 75 |
| `msg.methodResult` | out | Object | — | Full result object from `node-opcua` `methodCall` (incl. `inputArgumentResults`, `outputArguments`, `statusCode`). | nodes/opcua-method.js:76 |
| `msg.statusCode` | out | StatusCode | — | OPC UA status code of the method call. | nodes/opcua-method.js:77 |
| `msg.error` | out | Object | — | Error object from `createError()`. | nodes/opcua-method.js:84 |

---

### opcua-browser

Browses the OPC UA address space starting from a given NodeId.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.topic` | in | String | optional | Starting NodeId. Falls back to `msg.nodeId`, then to `config.startNodeId`, then to `RootFolder`. | nodes/opcua-browser.js:58 |
| `msg.nodeId` | both | String | optional | **In:** alias for `msg.topic`. **Out:** set to the NodeId actually browsed. | nodes/opcua-browser.js:58, 84 |
| `msg.recursive` | in | Boolean | optional | Recurse into child references when `true`. Also configurable in node UI. | nodes/opcua-browser.js:87 |
| `msg.startNodeId` | in | String | optional | Alternative starting-NodeId field (read by the underlying browse helper). Equivalent to `msg.topic` for the basic browse flow. | nodes/opcua-client.js:690 (browse helper shared with opcua-browser) |
| `msg.payload` | out | Array | — | Array of browse references: `[{ browseName, nodeId, nodeClass, typeDefinition, … }, …]`. | nodes/opcua-browser.js:82 |
| `msg.browseResult` | out | Object | — | Raw browse-result object from `node-opcua`. | nodes/opcua-browser.js:83 |
| `msg.recursiveResult` | out | Array | — | Recursive traversal result when `msg.recursive === true`. | nodes/opcua-browser.js:89 |
| `msg.error` | out | String | — | Error message string. | nodes/opcua-browser.js:97 |

---

### opcua-browse-client

Interactive browser with editor tree-view selection. At runtime, dispatches
on `msg.operation` (or the configured mode) and emits read or subscribe
results.

| Field | Direction | Type | Required | Description | Source |
|---|---|---|---|---|---|
| `msg.operation` | both | String | optional | **In:** runtime override — `read` / `readmultiple` / `subscribe` / `unsubscribe`. Falls back to the node's configured mode. **Out:** echoed as `"readmultiple"` after a read. | nodes/opcua-browse-client.js:627, 648 |
| `msg.nodeId` | in | String | optional | Optional NodeId override for the underlying client manager. | nodes/opcua-browse-client.js (read/subscribe path) |
| `msg.interval` | in | Number | optional | Subscribe publishing interval in ms. | nodes/opcua-browse-client.js (subscribe path) |
| `msg.queueSize` | in | Number | optional | Subscribe per-item queue size. | nodes/opcua-browse-client.js (subscribe path) |
| `msg.payload` | out | any | — | **Read:** array of enriched values. **Subscribe ack:** status string. **Unsubscribe ack:** `"Unsubscribed"`. | nodes/opcua-browse-client.js:647, 654, 674 |
| `msg.count` | out | Number | — | Item count after a read. | nodes/opcua-browse-client.js:649 |
| `msg.statusCode` | out | StatusCode | — | OPC UA status code (per emitted item, on subscription value-change messages). | nodes/opcua-browse-client.js (subscription delivery path) |
| `msg.sourceTimestamp` | out | Date | — | DataValue source timestamp (per emitted item, on subscription value-change messages). | lib/opcua-client-manager.js:506, 558 |
| `msg.serverTimestamp` | out | Date | — | DataValue server timestamp (per emitted item, on subscription value-change messages). | lib/opcua-client-manager.js:507, 559 |
| `msg.error` | out | Object | — | Error object from `createError()`. | nodes/opcua-browse-client.js:683 |

---

## Reserved for v0.1.0 (PubSub)

> **Added in v0.1.0 (PubSub).** The following field names are **reserved** for
> the upcoming Publisher / Subscriber nodes. No node in v1.0 reads or writes
> them. Once introduced they will mean exactly what is listed below — they
> will not collide with any v1.0 field documented above.

| Field | Direction | Type | Description |
|---|---|---|---|
| `msg.dataSet` | out | Object | Subscriber: decoded `DataSetMessage` field map |
| `msg.publisherId` | in/out | String \| UInt | Pub: target publisher / Sub: source publisher |
| `msg.writerGroupId` | in/out | UInt16 | WriterGroup identifier |
| `msg.dataSetWriterId` | in/out | UInt16 | DataSetWriter identifier |
| `msg.sequenceNumber` | out | UInt32 | Subscriber: per-DataSetReader sequence |
| `msg.encoding` | out | String | `'uadp'` \| `'json'` |
| `msg.transport` | out | String | `'udp'` \| `'mqtt'` \| `'amqp'` |

---

## Trust note: msg.func

The `opcua-server` node reads `msg.func` for the `addMethod` command and
evaluates its body via `new Function(...)`. This is **arbitrary code
execution by design** — the node ships an embedded OPC UA server and the
`addMethod` command exists to let flow authors define server methods at
deploy time. Treat any flow path that can supply `msg.func` from outside the
trusted flow author as a privileged surface. v1.0 does not change this
behaviour; the security boundary is the flow definition itself.

---

## Coverage cross-check

The acceptance grep:

```bash
grep -rhnE "msg\.[a-zA-Z_]+" nodes/*.js lib/*.js | grep -oE "msg\.[a-zA-Z_]+" | sort -u
```

…enumerates the following 39 distinct field names plus the two timestamp
fields surfaced by the client manager (`msg.serverTimestamp`,
`msg.sourceTimestamp`):

`msg.action`, `msg.attributeId`, `msg.browsePath`, `msg.browseResult`,
`msg.command`, `msg.count`, `msg.dataTypeNodeId`, `msg.datatype`,
`msg.endTime`, `msg.endpointUrl`, `msg.error`, `msg.eventType`,
`msg.folderName`, `msg.func`, `msg.initialValue`, `msg.inputArguments`,
`msg.interval`, `msg.itemName`, `msg.items`, `msg.maxValues`, `msg.message`,
`msg.methodName`, `msg.methodNodeId`, `msg.methodResult`, `msg.nodeId`,
`msg.objectName`, `msg.objectNodeId`, `msg.operation`, `msg.outputArguments`,
`msg.parentNodeId`, `msg.payload`, `msg.queueSize`, `msg.recursive`,
`msg.recursiveResult`, `msg.serverTimestamp`, `msg.severity`,
`msg.sourceNodeId`, `msg.sourceTimestamp`, `msg.startNodeId`, `msg.startTime`,
`msg.statusCode`, `msg.topic`, `msg.variableName`.

Each of the above appears at least once in the per-node tables in this
document.

---

*Document version: v1.0 (2026-05-08). See `CHANGELOG.md` for any field
renames during the v0.x series.*
