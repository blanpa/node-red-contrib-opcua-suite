# OPC UA Client / Server / Editor — Skeptical Code Review

**Reviewed:** 2026-08-28
**Scope:** Client, Server, Endpoint, Browser, Browse Client, Event, Method, Item
nodes plus `lib/opcua-client-manager.js`, `lib/opcua-pool.js`,
`lib/opcua-utils.js`, `lib/cert-store.js`.
The PubSub layer is covered separately by `REVIEW.md`.
**Method:** Full read, plus executed probes against the real `node-opcua`
library (session-leak counter with a stubbed `OPCUAClient`, a live
`OPCUAServer` for the `setValue` path, `parseNodeId` and enum-name checks).
**Status:** All findings below are **FIXED** in 0.2.0 unless marked otherwise.

Findings marked ✅ were reproduced by execution, not only by reading.

---

## Critical

### C-01 — Sessions leak on every redeploy until the server refuses connections (issue #17) — FIXED ✅

**Files:** `lib/opcua-client-manager.js:253` (`connect`), `nodes/opcua-client.js:148`,
`nodes/opcua-browse-client.js`, `nodes/opcua-browser.js`, `nodes/opcua-event.js`,
`nodes/opcua-method.js`

`connect()` was the only lifecycle method without a single-flight lock —
`reconnect()` has had one since DEBT-01. But *every* consumer node calls
`connect()` on the **shared** manager when its flow is deployed:
`opcua-client` connects proactively (`autoConnect`), the others lazily via
`if (!isConnected) await connect()`.

With N client nodes on one endpoint, N calls run in the same tick. All see
`isConnected === false` and all proceed:

```js
this.client = OPCUAClient.create(clientOptions);   // overwrites this.client
await this.client.connect(url);
this.session = await this.client.createSession(userIdentity);  // overwrites this.session
```

Only the last assignment survives. The earlier client/session pairs are
**orphaned**: connected server-side, actively kept alive by
`keepSessionAlive: true`, and unreachable for `disconnect()` — which only knows
`this.client` / `this.session`. Each redeploy adds another round.

**Reproduced** with a stubbed `OPCUAClient` counting sessions:

```
after deploy:            clients created = 3 | sessions opened = 3
after redeploy/close:    sessions closed  = 1
=> LEAKED sessions still open on server: 2
```

Which is exactly the reporter's symptom: >10 sessions with `poolSize: 2`
configured, ending in `connection was rejected by the server`. `poolSize` was
never the problem — `PooledClientManager` correctly creates exactly N managers;
the leak is one level below, per manager.

Same race, editor side: `getBrowseConnection()` had no guard either, and the
address-space tree fires parallel expand requests.

**Fix:** single-flight lock in `connect()` (mirroring `reconnect()`);
`disconnect()` awaits an in-flight connect so a redeploy mid-connect cannot
leave the new session behind; a session refused *after* the secure channel is up
now tears that channel down; `after_reconnection` closes the session it
replaces; `getBrowseConnection()` is single-flighted per endpoint, does not
cache a failed connect, and closes on runtime stop.

**Regression test:** `test/connect-single-flight.test.js`,
`test/node-reconnect-resilience.test.js`.

---

## High

### H-01 — `setValue` only ever worked on `Double` variables — FIXED ✅

**File:** `nodes/opcua-server.js` (`handleSetValue`)

```js
const datatype = msg.datatype || node.dataType;   // NodeId object
const dataType = DataType[datatype] || DataType.Double;
```

`UAVariable.dataType` is a `NodeId`, so `DataType[…]` is **always** `undefined`
and the fallback is **always** `Double`. Against a real Boolean variable:

```
UAVariable.setValueFromSource … the expected dataType is Boolean, the actual is Double
```

`docs/MSG-SCHEMA.md` did not even list `msg.datatype` for `setValue`, so per the
documented contract the command was broken for every non-`Double` variable. Both
shipped examples happen to pass `datatype: "Double"`, which is why no test caught it.

**Fix:** resolve the variable's declared type via
`addressSpace.findCorrespondingBasicDataType(node.dataType)`, with inference from
the JS value as a last resort. An explicit `msg.datatype` still wins.

**Regression test:** `test/opcua-server-setvalue.test.js` (real server,
Boolean / Int32 / String / Double).

### H-02 — Every HTTP admin route was reachable unauthenticated — FIXED

**Files:** `lib/cert-store.js` (3 routes × 2 prefixes), `nodes/opcua-browse-client.js` (2 routes)

`grep -rn needsPermission nodes lib` returned nothing. With `adminAuth`
configured, these routes stayed open: certificate upload (no extension check on
write — only listing filtered), listing (absolute paths), deletion, and OPC UA
browsing / connection setup against any configured endpoint.

**Fix:** `RED.auth.needsPermission("flows.write")` on writes,
`"flows.read"` on reads, with a pass-through where `RED.auth` is unavailable
(test harnesses, very old Node-RED). Uploads now enforce the extension
whitelist. `sanitiseFilename` normalises a bare `..` / `.` to a real file name
(traversal was already impossible — `/` and `\` are replaced — but both resolved
to a *directory*).

### H-03 — `msg.func` is a message-driven `new Function()` — FIXED (breaking)

**File:** `nodes/opcua-server.js` (`handleAddMethod`)

`addMethod` compiles a JavaScript body carried **in the message**. Unlike a
Function node, that body is not authored in the editor, so an `http in` upstream
is a remote-code-execution path. The risk was already documented in
`docs/MSG-SCHEMA.md` ("Trust note: msg.func") — documented is not the same as
safe by default.

**Fix:** opt-in per server node (**Allow method code from `msg.func`** under
*Security*, off by default) with an explanatory error when disabled. `addMethod`
without `msg.func` is unaffected.

### H-04 — The issue-#15 fix was never applied to two other nodes — FIXED

**Files:** `nodes/opcua-browse-client.js`, `nodes/opcua-event.js`

`opcua-client` handles `session_recreated` and replays its subscriptions. The
Browse Client and Event nodes never handled it. After a server-side session
timeout (the Siemens S7 ~60 s case from issue #15) both keep a
`ClientSubscription` bound to the dead session, `setupSubscriptions()`
early-returns because the stale handle is still truthy, and the node silently
stops delivering. The Event node additionally did not clear its handles on
`disconnected`.

**Fix:** both drop stale handles and rebuild on the fresh session. The Event node
remembers its request for replay, sends event messages via `node.send()` (they
are produced long after the originating message was acknowledged), and stops
replaying after an explicit `unsubscribe`.

### H-05 — A fast redeploy could leave the server port bound — FIXED

**File:** `nodes/opcua-server.js`

`startServer()` was fire-and-forget and `node.on('close')` did not await it. A
close landing between `new OPCUAServer()` and `await server.start()` made
`shutdown()` fail (logged and swallowed) while `start()` went on to bind the
port — with no reference left to release it. Next deploy: `EADDRINUSE`.

**Fix:** the start promise is tracked and awaited in `close()`, and a start that
completes after a close was requested shuts itself down immediately.

### H-06 — Real private keys committed to the repository — FIXED (rotate!)

`data/opcua-certs/client-key.pem`, `client-key.der` and `user-key.pem` were
tracked RSA private keys (PKCS#8) for the dev container. They are removed from
tracking and git-ignored, together with `data/flows_cred.json` and
`data/.config.*`.

> ⚠️ **They remain in the git history.** If those keys were ever used outside
> the local dev container, rotate them. Purging history (`git filter-repo`) is a
> separate, force-push-requiring decision and was left to the maintainer.

---

## Medium

### M-01 — Recursive browsing produced no children, and would have exploded once fixed — FIXED

**Files:** `nodes/opcua-browser.js` (`browseRecursive`), `lib/opcua-client-manager.js` (`browse`)

Two defects that masked each other:

1. `ref.nodeClass === 'Object'` compares against a `NodeClass` **enum value**, so
   it was always false — `children` was always `[]`. (The Browse Client node
   resolves the name correctly via `resolveNodeClassName()`.)
2. `manager.browse()` passes a BrowseDescription **object**, which bypasses
   node-opcua's `referenceTypeId: "HierarchicalReferences"` default (that only
   applies to the string form — verified in
   `node_modules/node-opcua-client/dist/private/client_session_impl.js:43-52`)
   and yields `null` = **all** reference types.

Fixing (1) alone would have sent the walk through `HasTypeDefinition` /
`HasSubtype` into the type system, unbounded, to `maxDepth: 10`.

**Fix:** `nodeClassName()` helper on both nodes, `browse()` defaults to
`HierarchicalReferences` (opt out with `{ referenceTypeId: null }` /
`msg.referenceTypeId`), and `browseRecursive` carries a visited set.

### M-02 — Browse Client in subscribe mode never connected — FIXED

Subscriptions were only set up when already connected at construction time or in
reaction to a `connected` event, and nothing triggered a connect. A flow whose
only OPC UA node is a subscribe-mode Browse Client stayed at *"not connected"*
forever. Now it connects proactively, like `opcua-client`'s `autoConnect`.

### M-03 — `parseNodeId` truncated String identifiers containing `;` — FIXED ✅

`parseNodeId("ns=2;s=Line1;Motor")` returned `Line1` — the parser split on every
`;` and took `parts[1]`. Only the first separator is significant now, and a
non-numeric namespace is rejected instead of producing `NaN`.

### M-04 — `getDefaultValue` did not know `SByte` / `Byte` — FIXED ✅

The `switch` used `DataType.Int8` / `DataType.UInt8`, which do not exist in
node-opcua (`undefined`), so `addVariable` with those types produced
`Variant(Scalar<Byte>, value: <null>)` instead of `0`.

### M-05 — `subscribe` did not serialise ExtensionObjects — FIXED

`read` and `readMultiple` route values through `_serializeValue`; the Browse
Client serialises in its `changed` handler; `opcua-client`'s `handleSubscribe`
passed the raw node-opcua struct through. A struct variable therefore had a
different payload shape depending on the operation. `readAttribute` had the same
gap.

### M-06 — Editor browse connections: no single-flight, no shutdown cleanup — FIXED

See C-01. Additionally the entry carried a `refCount` in its comment that the
code never implemented.

### M-07 — `after_reconnection` replaced the session without closing the old one — FIXED

After a channel loss the old session is gone anyway, but when only the session
timed out on an otherwise healthy channel it lingered until the server reaped it.

### M-08 — `getEndpoints()` leaked its discovery channel on failure — FIXED

`await client.disconnect()` sat on the happy path instead of in a `finally`.

### M-09 — `operationTimeout` was an unreachable config value — FIXED

The manager read `config.operationTimeout`, but `nodes/opcua-endpoint.js` never
passed it, so the 10 s default could not be changed. A slow batch read on a PLC
exceeding it marks the connection dead and tears down an otherwise healthy
session on the next message. Now exposed in the endpoint UI.

### M-10 — `npm run lint` never ran — FIXED

```
ESLint couldn't find a configuration file.
```

No `.eslintrc*` / `eslint.config.js` existed. The glob also only covered
`lib/*.js`, silently skipping `lib/transports/`. Added a flat config
(`eslint.config.js`, ESLint 9) over `nodes/`, `lib/` and `test/` and fixed the
~35 findings it surfaced.

### M-11 — `PooledClientManager.write()` silently dropped array writes — FIXED

The delegation forwarded four of the manager's five parameters, so with
`poolSize > 1` every `arrayType: "Array"` write degraded to a scalar.

---

## Low

### L-01 — `forceReconnect()` was dead code — FIXED
Defined in `nodes/opcua-client.js` and never called; the input handler drives
`clientManager.reconnect()` directly.

### L-02 — `isValidEndpointUrl` / `parseDataType` were test-only — PARTLY FIXED
`isValidEndpointUrl` is now used to validate the endpoint URL at deploy time.
`parseDataType` remains unused by production code (left in place; it is exported
API).

### L-03 — `readAttribute` skipped `_serializeValue` — FIXED (see M-05)

### L-04 — Unsubscribing the last item left an empty subscription — FIXED
The server kept publishing keep-alives for it until its lifetime expired.

### L-05 — One unescaped interpolation in the browse tree — FIXED
`displayClass` was the only value in `nodes/opcua-browse-client.html` inserted
without the file's own `$("<span>").text(x).html()` idiom. Not exploitable (the
value comes from `NodeClass[…]`), fixed for consistency.

### L-06 — Operation timeouts cost one message — FIXED
`_withTimeout` marks the connection dead, but `Operation timed out after …`
matched none of the connection-lost patterns, so the retry loop skipped the
reconnect and failed the message; the *next* message reconnected and succeeded.

### L-07 — `serializeExtensionObject` had no cycle or depth guard — FIXED
It walks decoded network input; unbounded recursion would take the process down
with a stack overflow rather than yielding a bad message. Cap: 32 levels, plus a
`WeakSet` cycle guard.

### L-08 — `nodeClass` was emitted as a raw enum number — FIXED
`opcua-client` and `opcua-browser` emitted the number, the Browse Client the
name.

### L-09 — Managers without an `error` listener turned errors into throws — FIXED
An `EventEmitter` with no `error` listener **throws** the emitted error at the
`emit()` call site. Inside `connect()`'s catch that silently skipped the
`scheduleReconnect()` on the next line; inside the async `after_reconnection`
handler it would have become an unhandled rejection. The manager now attaches a
no-op listener in its constructor; consumers that care still attach their own.

### L-10 — Browser / Event / Method nodes dropped the connection error — FIXED
They received the error object in their status callback and ignored it, leaving
a red dot with no explanation anywhere.

---

## Checked and found SAFE (no change needed)

- **Reference counting in `opcua-endpoint`.** `getSharedManager()` /
  `releaseSharedManager()` are correctly paired in all six consumer nodes, every
  `close` handler calls `done()` on all paths, and the endpoint's own `close`
  handler is idempotent against a client close arriving after it. The reporter's
  leak was *not* a refcount bug.
- **Editor tree XSS.** `nodes/opcua-browse-client.html` consistently escapes
  server-provided strings via `$("<span>").text(x).html()`; only `displayClass`
  was missed (L-05) and it is not attacker-controlled.
- **Path traversal in the cert store.** `sanitiseFilename` replaces `/` and `\`,
  so `path.join` cannot escape the certs directory.
- **npm packaging.** `.npmignore` correctly excludes `data/`, `test/`, `docs/`
  and the Docker files; the tarball is 50 files / 126 kB.
- **`_isConnectionLostError` exact-match patterns.** `"Session is no longer
  valid"` and `"Not connected"` are only ever thrown by `_ensureConnected()`,
  which every operation calls *before* its `try`, so they propagate unwrapped and
  the exact comparison holds.
- **`handleSetWritable` assigning `accessLevel` directly.** `accessLevel` is a
  plain field on `UAVariableImpl`, so direct assignment works.
- **The default `addMethod` handler's arity.** `bindMethod` callbackifies
  handlers by arity, so the two unused parameters are load-bearing — an initial
  lint cleanup that removed them broke an existing test, which is what the test
  was there for.

---

## Priority summary

| ID | Severity | Status |
|----|----------|--------|
| C-01 | critical | FIXED — connect() single-flight; sessions no longer orphaned per redeploy (issue #17) |
| H-01 | high | FIXED — setValue resolves the variable's real DataType; worked only for Double before |
| H-02 | high | FIXED — admin permission guards on all six HTTP routes |
| H-03 | high | FIXED — msg.func code evaluation is opt-in per server node |
| H-04 | high | FIXED — session_recreated handling for Browse Client and Event nodes |
| H-05 | high | FIXED — close() awaits the in-flight server start; no more EADDRINUSE |
| H-06 | high | FIXED — dev private keys untracked and ignored (⚠️ still in history) |
| M-01 | medium | FIXED — recursive browse actually recurses, hierarchically, with a visited set |
| M-02 | medium | FIXED — subscribe-mode Browse Client connects on deploy |
| M-03 | medium | FIXED — parseNodeId keeps ';' inside String identifiers |
| M-04 | medium | FIXED — SByte/Byte default to 0 |
| M-05 | medium | FIXED — subscribe/readAttribute serialise ExtensionObjects |
| M-06 | medium | FIXED — editor browse connections single-flighted and closed on stop |
| M-07 | medium | FIXED — replaced session is closed |
| M-08 | medium | FIXED — getEndpoints disconnects in a finally |
| M-09 | medium | FIXED — operationTimeout configurable from the endpoint node |
| M-10 | medium | FIXED — ESLint config added; lint gate runs |
| M-11 | medium | FIXED — pool forwards arrayType |
| L-01…L-10 | low | FIXED (L-02 partly) |
