# node-red-contrib-opcua-suite

A modern, high-performance OPC UA suite for Node-RED — built for real industrial use.

## Why This Instead of node-red-contrib-opcua?

| Feature | node-red-contrib-opcua | **opcua-suite** |
|---|---|---|
| **Connection Sharing** | Each node = own TCP connection | All nodes share ONE connection per endpoint (ref-counted) |
| **Batch Read/Write** | One message per variable | Single OPC UA service call via `msg.items` or payload object |
| **Item Collector** | Not available | Chain `opcua-item` nodes visually for batch operations |
| **Certificate Upload** | Manual file paths only | **Drag & drop** upload in the editor UI |
| **Reconnect** | Basic retry | `keepSessionAlive` + `after_reconnection` session recovery + `connection_failed` fallback (same as node-opcua internally) |
| **Architecture** | Separate nodes per operation | All-in-One client + dedicated Browser/Method/Event nodes |
| **msg.payload Object Format** | Not supported | `{"Temperature": "ns=1;s=Temp"}` for reads, `{"ns=1;s=Temp": {value: 25.5}}` for writes |
| **Method Calls** | Basic | Full typed input/output arguments with auto-detection |
| **History Read** | Limited | Full time-range queries with `maxValues` |
| **Discovery** | Not available | `getendpoints`, `registernodes`, `unregisternodes`, `translatebrowsepath` |
| **Status Propagation** | Per-node | Shared endpoint broadcasts connected/disconnected/reconnecting to ALL nodes |
| **Node Count** | 6+ nodes for basic ops | 7 focused nodes covering everything |

### Connection Sharing in Detail

With `node-red-contrib-opcua`, 9 OPC UA nodes = 9 TCP connections to your server. With this suite, 9 nodes referencing the same endpoint = **1 TCP connection**, ref-counted. The endpoint config node manages the shared `OpcUaClientManager`. When the last node closes, the connection is released.

```
[Client: Read] ──┐
[Client: Write] ──┤
[Client: Sub]   ──┤── Endpoint (1 shared connection) ──► OPC UA Server
[Browser]       ──┤
[Method]        ──┤
[Event]         ──┘
```

## Installation

```bash
cd ~/.node-red
npm install node-red-contrib-opcua-suite
```

## Nodes

### opcua-endpoint (Config Node)

Shared connection configuration. All client/browser/method/event nodes referencing the same endpoint share ONE TCP connection.

| Field | Description |
|---|---|
| Endpoint URL | `opc.tcp://localhost:4840` |
| Security Mode | None, Sign, SignAndEncrypt |
| Security Policy | None, Basic128Rsa15, Basic256, Basic256Sha256, Aes128/Aes256 |
| Username / Password | Optional credentials |
| Certificates | Drag & drop upload for client cert, private key, CA cert, X509 user token |

### opcua-client (All-in-One)

Single node for all OPC UA operations. Set via `msg.operation` or default in config.

#### Read

```js
msg.operation = "read";
msg.nodeId = "ns=2;s=Temperature";  // or msg.topic
// Output: msg.payload = value, msg.statusCode, msg.sourceTimestamp
```

#### Read Multiple (Batch)

```js
// Array format
msg.operation = "readmultiple";
msg.items = [
    { nodeId: "ns=2;s=Var1", name: "Temperature" },
    { nodeId: "ns=2;s=Var2", name: "Pressure" }
];

// Object format (friendly names as keys)
msg.operation = "readmultiple";
msg.payload = {
    "Temperature": "ns=1;s=Scalar.Double",
    "Counter": "ns=1;s=Scalar.Int32"
};
// Output: msg.payload = [{nodeId, value, dataType, statusCode, itemName}, ...]
```

#### Write

```js
msg.operation = "write";
msg.nodeId = "ns=2;s=Temperature";
msg.payload = 25.5;
msg.datatype = "Double";  // optional: auto-detected from JS type
```

#### Write ExtensionObject

```js
// Write a structured type (ExtensionObject) to a variable.
// Requires datatype = "ExtensionObject" and dataTypeNodeId pointing to the DataType definition.
msg.operation = "write";
msg.nodeId = "ns=2;s=MyStructVariable";
msg.datatype = "ExtensionObject";
msg.dataTypeNodeId = "ns=2;i=3003";  // NodeId of the DataType definition
msg.payload = {
    temperature: 25.5,
    unit: "°C",
    timestamp: "2026-03-16T12:00:00Z"
};
```

#### Write Multiple (Batch)

```js
// Array format
msg.operation = "writemultiple";
msg.items = [
    { nodeId: "ns=2;s=Var1", value: 25.5, datatype: "Double" },
    { nodeId: "ns=2;s=Var2", value: true, datatype: "Boolean" }
];

// Object format (nodeIds as keys)
msg.operation = "writemultiple";
msg.payload = {
    "ns=1;s=Scalar.Double": { value: 42.0, datatype: "Double" },
    "ns=1;s=Scalar.Int32": { value: 100, datatype: "Int32" }
};

// Batch write with ExtensionObjects
msg.operation = "writemultiple";
msg.items = [
    {
        nodeId: "ns=2;s=MyStructVariable",
        datatype: "ExtensionObject",
        dataTypeNodeId: "ns=2;i=3003",
        value: { temperature: 25.5, unit: "°C" }
    },
    {
        nodeId: "ns=2;s=AnotherStruct",
        datatype: "ExtensionObject",
        dataTypeNodeId: "ns=2;i=3010",
        value: { x: 1.0, y: 2.0, z: 3.0 }
    }
];
```

#### Subscribe / Unsubscribe

```js
msg.operation = "subscribe";
msg.nodeId = "ns=2;s=Temperature";
msg.interval = 500;  // sampling interval ms (default: 1000)

msg.operation = "unsubscribe";
msg.nodeId = "ns=2;s=Temperature";
```

#### Browse / Method / History / Discovery

```js
msg.operation = "browse";       // Browse address space
msg.operation = "method";       // Call OPC UA method
msg.operation = "history";      // Read historical values
msg.operation = "getendpoints"; // Discover server endpoints
msg.operation = "readattribute";       // Read BrowseName, DisplayName, etc.
msg.operation = "registernodes";       // Register nodes for fast access
msg.operation = "unregisternodes";     // Unregister nodes
msg.operation = "translatebrowsepath"; // Translate browse path to NodeId
```

### opcua-item (Item Collector)

Chain multiple items in series before a client node for visual batch operations.

```
[Inject] → [Item: Temp] → [Item: Pressure] → [Item: Speed] → [Client (readmultiple)]
```

Each item adds `{nodeId, datatype, itemName}` to `msg.items`. The client reads/writes all items in a single OPC UA service call.

### opcua-browser

Dedicated browse node with optional recursive browsing. References an endpoint directly.

### opcua-method

Dedicated method call node. Object/Method NodeIds configurable or via msg. References an endpoint directly.

### opcua-event

Subscribes to OPC UA events (BaseEventType, AlarmConditionType, etc.). References an endpoint directly.

### opcua-server

Embedded OPC UA server. Create address space at runtime via `msg.command`: `addVariable`, `addFolder`, `addObject`, `addMethod`, `setValue`, `setWritable`, `raiseEvent`, `getServerInfo`.

## NodeId Formats

| Format | Example |
|---|---|
| String | `ns=2;s=MyVariable` |
| Numeric | `ns=2;i=1234` |
| GUID | `ns=2;g=550e8400-e29b-...` |
| Short | `i=84`, `s=MyVar` (ns=0) |
| Well-known | `RootFolder`, `ObjectsFolder`, `TypesFolder`, `Server` |

## DataType Auto-Detection

| JS Type | OPC UA DataType |
|---|---|
| `boolean` | Boolean |
| integer `number` | Int32 |
| float `number` | Double |
| `string` | String |
| `Date` | DateTime |

Explicit override: `msg.datatype = "UInt16"` or in item config.

## Docker

```bash
docker compose up -d          # Start Node-RED + OPC UA test server
# Node-RED: http://localhost:1881
# Test server: opc.tcp://localhost:4841

docker compose build --no-cache && docker compose up -d --force-recreate  # Rebuild
```

## Testing

```bash
npm test                  # 120 unit tests
node test/live-integration.js  # 36 live integration tests (requires Docker)
```

## License

MIT

## Author

blanpa
