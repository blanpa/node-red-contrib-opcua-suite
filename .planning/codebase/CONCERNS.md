# Codebase Concerns

**Analysis Date:** 2026-05-08

**Project version:** v0.0.7 (pre-1.0). API and on-disk formats are still subject to change without semver guarantees.

This document inventories technical debt, fragile areas, security/perf considerations, and test gaps. A planned **OPC UA PubSub** milestone (Subscriber + Publisher nodes) will inherit several of these concerns — items marked **[PubSub-impacted]** should be addressed or carefully accounted for as part of that work.

---

## Tech Debt

### Reconnect logic is split between two layers
- Issue: Reconnect concerns are duplicated across `OpcUaClientManager` (the connector) and the `opcua-client` node (the consumer). The manager has its own `scheduleReconnect()` / `connectionStrategy` (file `lib/opcua-client-manager.js:243-259`, `lib/opcua-client-manager.js:118-122`), but `opcua-client` re-implements its own retry loop with exponential backoff in `forceReconnect()` / `_doForceReconnect()` (`nodes/opcua-client.js:179-210`). Both paths mutate `clientManager.isConnected` and `clientManager.reconnectAttempts` from outside the manager.
- Files: `lib/opcua-client-manager.js:51-57`, `lib/opcua-client-manager.js:154-204`, `lib/opcua-client-manager.js:243-259`, `nodes/opcua-client.js:167-210`
- Impact: Makes reasoning about state hard. A second consumer node sharing the manager (e.g. `opcua-browse-client`, `opcua-event`, `opcua-method`, `opcua-browser`) does **not** get the same retry semantics — only `opcua-client` has the `forceReconnect` / `isConnectionLostError` guard, so other nodes simply fail on the first session-loss error.
- Fix approach: Move the retry loop and "single-flight reconnect" lock (`reconnectPromise`) into `OpcUaClientManager` so every consumer benefits. Remove direct mutations of `isConnected` from `opcua-client.js`. **[PubSub-impacted]** — a PubSub Subscriber node will need the same retry semantics; consolidate first to avoid a third copy.

### `clientManager` internals reached into from node code
- Issue: Node-level code calls private/internal APIs of the manager: `clientManager._toOpcUaNodeId()` in `opcua-event.js:103` and `opcua-client.js:524`, plus direct mutation of `clientManager.isConnected` / `clientManager.reconnectAttempts` from `opcua-client.js`.
- Files: `nodes/opcua-event.js:103`, `nodes/opcua-client.js:524`, `nodes/opcua-client.js:169`, `nodes/opcua-client.js:190-191`, `nodes/opcua-client.js:206-207`
- Impact: Encapsulation broken — refactoring `_toOpcUaNodeId` or the connection-state model will silently break consumers. Also blocks future locking around `isConnected`.
- Fix approach: Promote `_toOpcUaNodeId` to a public `toOpcUaNodeId` (or expose it via `lib/opcua-utils.js`) and add `markDisconnected()` / `resetReconnect()` methods to the manager.

### Subscription handling lives in the consumer, not the manager
- Issue: `OpcUaClientManager.createSubscription()` returns a raw `ClientSubscription` (`lib/opcua-client-manager.js:759-787`), but every monitored item is created in node code (`nodes/opcua-client.js:526-543`, `nodes/opcua-browse-client.js:561-607`, `nodes/opcua-event.js:100-127`). Each consumer duplicates: `ClientMonitoredItem.create`, `changed` handler, ExtensionObject serialization, and terminate-on-close logic.
- Files: `lib/opcua-client-manager.js:759-787`, `nodes/opcua-client.js:485-545`, `nodes/opcua-browse-client.js:540-617`, `nodes/opcua-event.js:74-127`
- Impact: Three near-identical `monitorItem.on('changed', ...)` blocks; bug fixes (e.g. ExtensionObject serialization) must be applied N times. The `opcua-browse-client` only handles ExtensionObjects in its subscription path (`opcua-browse-client.js:574-586`); `opcua-client` does **not** serialize ExtensionObjects in its own subscribe path (`opcua-client.js:532-541`) — a latent bug.
- Fix approach: Add `manager.subscribeNode(nodeId, opts, onChanged)` and `manager.unsubscribeNode(...)` methods that own the `ClientMonitoredItem`, perform serialization, and resubscribe automatically after reconnect. **[PubSub-impacted]** — Subscriber nodes are essentially "subscriptions to DataSetReaders"; without a unified subscription API in the manager, PubSub will become a fourth duplicate.

### Inline `require('node-opcua')` inside hot paths
- Issue: `node-opcua` is a heavy module; several files re-`require()` it inside the input handler instead of at top-of-file:
  - `nodes/opcua-server.js:381` — `require('node-opcua').AccessLevelFlag` inside `handleSetWritable()`
  - `nodes/opcua-event.js:92-93` — `AttributeIds, ClientMonitoredItem, constructEventFilter` inside `node.on('input')`
  - `nodes/opcua-client.js:523` — `ClientMonitoredItem` inside `handleSubscribe()`
- Files: `nodes/opcua-server.js:381`, `nodes/opcua-event.js:92-93`, `nodes/opcua-client.js:523`
- Impact: Marginal repeat-cost (Node caches modules), but obscures dependencies and complicates static analysis / tree-shaking.
- Fix approach: Hoist all `node-opcua` destructures to the top of each module.

### Browse connection cache is module-scoped global state
- Issue: `nodes/opcua-browse-client.js:22` declares `const browseConnections = new Map()` at module scope. This is shared across ALL endpoint instances and across editor reloads while Node-RED is running. There is also no upper bound on map size — a busy editor with many endpoints could keep accumulating entries until idle timers fire.
- Files: `nodes/opcua-browse-client.js:22-81`
- Impact: Hard to test; survives flow redeploy; the 60s idle timer is per-entry but there is no LRU cap or hard timeout.
- Fix approach: Cap the map (e.g. 8 entries), surface size as a metric, and add a hook so endpoint `close` invalidates matching browse connections.

### Two ClientManager instances per endpoint when browse-client is used
- Issue: `opcua-browse-client.js:47-66` creates its own `OpcUaClientManager` for the editor browse cache, separate from the runtime shared manager from `endpointConfig.getSharedManager()`. Same endpoint URL ⇒ two TCP connections, two sessions, two cert reads.
- Files: `nodes/opcua-browse-client.js:47-67`
- Impact: Doubles the number of OPC UA sessions visible to the server; makes server session-limit tuning confusing for users.
- Fix approach: Reuse the shared manager for editor browse when it is already connected. Fall back to a dedicated short-lived client only if the runtime manager is not yet built.

### Standalone `opcua-browser` node duplicates `opcua-client` browse logic
- Issue: `nodes/opcua-browser.js` (149 lines) provides browsing functionality that already exists as the `browse` operation of `opcua-client` (`nodes/opcua-client.js:565-583`). It also adds a recursive variant (`browseRecursive`) that has no test coverage and silently swallows errors per-level (`opcua-browser.js:143-145`).
- Files: `nodes/opcua-browser.js:116-146`
- Impact: Two paths to maintain; recursive browse is a quiet no-op on any sub-tree error, hiding network/permission failures.
- Fix approach: Either delete `opcua-browser` in favour of `opcua-client { operation: 'browse' }`, or move recursive browse into the manager and have both nodes call it.

### Pervasive silent `catch { /* ignore */ }`
- Issue: 18+ instances of empty/`/* ignore */` catch blocks across the codebase swallow errors during cleanup, reconnect, and best-effort teardown.
- Files: `lib/opcua-client-manager.js:88-90`, `lib/opcua-client-manager.js:215-216,224-225,233-234`, `nodes/opcua-endpoint.js:16,181,190`, `nodes/opcua-client.js:264,273,286`, `nodes/opcua-browse-client.js:39,78,662,670,696,705,717`, `nodes/opcua-event.js:144-145,150`, `nodes/opcua-method.js:96`, `nodes/opcua-browser.js:109`
- Impact: Real bugs (e.g. session.close() throwing because of a protocol error) become invisible; debugging requires editing the source.
- Fix approach: Convert silent `catch` to `node.debug(...)` or behind a `verboseLog` flag. Add a single `safeAwait(promise, ctx)` helper in `lib/opcua-utils.js` so cleanup paths log uniformly.

---

## Known Bugs

### `opcua-client` subscribe path does NOT serialize ExtensionObjects
- Symptoms: When subscribing to an ExtensionObject variable through `opcua-client { operation: 'subscribe' }`, `msg.payload` is the raw `node-opcua` typed object (not the JSON form documented in `README.md:206-218`). Read/readMultiple/write paths *do* serialize via `_serializeValue` (`lib/opcua-client-manager.js:366-391`), creating an inconsistency.
- Files: `nodes/opcua-client.js:532-541` (no serialization), `nodes/opcua-browse-client.js:574-586` (correct), `lib/opcua-client-manager.js:366-391` (helper exists but is not used here)
- Trigger: Subscribe to a structured-type variable on a server.
- Workaround: Use `opcua-browse-client` in subscribe mode instead.

### Recursive browse swallows per-branch errors
- Symptoms: `msg.recursiveResult` for a deep tree may silently miss sub-trees the user lacks permission to read; the call returns `[]` for the failing branch with no warning.
- Files: `nodes/opcua-browser.js:143-145`
- Trigger: Set `config.recursive = true` against a server with mixed-permission nodes.
- Workaround: Use the editor browser (`opcua-browse-client`) which surfaces errors per request.

### `subscription` reference passed by value, mutation via callback
- Symptoms: `handleSubscribe` receives `subscription` as a parameter and `setSubscription` callback (`nodes/opcua-client.js:487-511`). The local `subscription` parameter shadows the outer scope; mutating it inside the function does not update the closure unless `setSubscription` is called. The current code is correct but the indirection is fragile and unintuitive.
- Files: `nodes/opcua-client.js:487-511`
- Trigger: Refactor risk. No active bug today.
- Workaround: Move `subscription` and `monitorItems` into the node closure and stop passing them as args.

### `msg.payload` mutated as both input and output for write
- Symptoms: `handleWrite` returns `{ payload: value, ... }` (`nodes/opcua-client.js:403-407`) — the same value the user sent. Subsequent flow nodes cannot tell input from output. For `writemultiple`, `payload` gets overwritten with the result array (`nodes/opcua-client.js:478-482`), losing the original write payload.
- Files: `nodes/opcua-client.js:403-407`, `nodes/opcua-client.js:478-482`
- Workaround: Save the input on `msg.input` before calling the client.

### `_serializeValue` array detection misses OpaqueStructure-only arrays
- Symptoms: In `lib/opcua-client-manager.js:382-389`, the array branch checks `value[0].schema || value[0] instanceof OpaqueStructure` — but when `OpaqueStructure` is `null` (sub-package import failed at line 33-39), `instanceof OpaqueStructure` throws `TypeError: Right-hand side of instanceof is not callable`.
- Files: `lib/opcua-client-manager.js:33-39`, `lib/opcua-client-manager.js:382-389`
- Trigger: Server returns an array of opaque-only structures **and** the optional `node-opcua-extension-object` sub-package is missing.
- Workaround: Ensure `node-opcua-extension-object` is installed alongside `node-opcua`.
- Fix approach: Guard the `instanceof` like the single-value branch already does (`lib/opcua-client-manager.js:373-380`).

---

## Security Considerations

### Certificate upload accepts any base64 content as a `.pem|.der|.crt|.key|.pfx|.p12` file
- Risk: The HTTP endpoint `POST /opcua-endpoint/upload-cert` (`nodes/opcua-endpoint.js:23-38`) accepts arbitrary base64 content with only filename sanitisation (`replace(/[^a-zA-Z0-9._\-]/g, '_')`). No size limit, no MIME / DER / PEM validation. An attacker with admin access to the Node-RED editor can upload up to disk-full and write arbitrary bytes into `<userDir>/opcua-certs/<sanitised-name>`.
- Files: `nodes/opcua-endpoint.js:23-38`, `nodes/opcua-endpoint.js:14-17`
- Current mitigation: Filename sanitisation prevents path traversal. Upload only via authenticated `RED.httpAdmin`.
- Recommendations:
  - Cap content size (e.g. 64 KiB).
  - Validate that decoded content parses as PEM/DER (e.g. `-----BEGIN`).
  - Set explicit file mode `0o600` after `writeFileSync` so other Unix users cannot read private keys.
  - Reject upload if no extension matches the cert/key whitelist.

### Private key files read with default umask
- Risk: `fs.writeFileSync(destPath, content)` (`nodes/opcua-endpoint.js:33`) writes private keys with the process's default file mode (typically `0o644`). Any local user on the host can read them.
- Files: `nodes/opcua-endpoint.js:33`
- Current mitigation: Files live under `<userDir>/opcua-certs/` which Node-RED users typically own.
- Recommendations: Pass `{ mode: 0o600 }` to `writeFileSync`; chmod the directory itself to `0o700`. Document the threat model in `README.md`.

### Username / password stored as Node-RED credentials, but logged via shared manager
- Risk: The endpoint declares `password: { type: 'password' }` on its `credentials` (`nodes/opcua-endpoint.js:200-203`, `nodes/opcua-endpoint.html:16-18`), so the value is encrypted at rest by Node-RED. However, `node._sharedManager` keeps a plaintext copy in `managerConfig.password` (`nodes/opcua-endpoint.js:124-136`) for the lifetime of the process. Any heap dump / `node --inspect` / `util.inspect(node)` from a function node reveals the password.
- Files: `nodes/opcua-endpoint.js:124-136`, `nodes/opcua-endpoint.js:199-204`, `lib/opcua-client-manager.js:277-282`
- Current mitigation: `password` is a `credentials` field (encrypted in `flows_cred.json`).
- Recommendations: Build the user identity object lazily (already done in `_buildUserIdentity`) and avoid keeping `password` as a long-lived field on `this.config`. After session creation, scrub it.

### `new Function(...)` in `opcua-server.addMethod`
- Risk: `methodOpts.onCall = new Function('inputArguments', 'context', funcBody)` (`nodes/opcua-server.js:310`) executes arbitrary JavaScript supplied via `msg.func` or `msg.payload.func`. Any flow that injects user-controlled data into `msg.func` becomes RCE.
- Files: `nodes/opcua-server.js:308-311`
- Current mitigation: Only flows authored by the Node-RED admin can reach this code path.
- Recommendations: Document that `msg.func` is admin-only; alternatively gate behind a node config checkbox `Allow dynamic code` (default off) and refuse non-admin updates. Consider a sandbox (`vm` module with limited globals) at minimum.

### Subscription IDs / NodeIds reflected verbatim in `node.error` / `msg.error`
- Risk: User-supplied NodeIds and server messages flow into `node.error()` and `msg.error.message` unmasked. In a multi-tenant deployment, this can leak internal node names to the debug sidebar.
- Files: `lib/opcua-utils.js:155-161`, `nodes/opcua-client.js:251`, `nodes/opcua-event.js:135-138`
- Current mitigation: None.
- Recommendations: This is acceptable for v0.x but document it. **[PubSub-impacted]** — PubSub will surface DataSetWriter / WriterGroup IDs the same way; consider a single sanitisation helper.

### TLS / cert verification of the OPC UA server certificate
- Risk: `clientOptions.endpointMustExist = false` (`lib/opcua-client-manager.js:127`) and the server certificate is only optionally pinned via `caCertificateFile`. With `securityMode = None` (the default — `nodes/opcua-endpoint.js:74`), credentials transit unencrypted.
- Files: `lib/opcua-client-manager.js:115-128`, `nodes/opcua-endpoint.js:74-75`
- Current mitigation: User can opt in to `Sign` / `SignAndEncrypt`.
- Recommendations: Surface a non-dismissible warning in the editor when `securityMode = None` AND a username/password is configured. Document that `endpointMustExist=false` skips endpoint validation.

---

## Performance Bottlenecks

### Shared connection ref-count is correct but coarse
- Problem: The endpoint's `_refCount` (`nodes/opcua-endpoint.js:88,116-185`) only tears down the shared connection when the last consumer closes. Redeploys that detach and reattach in a different order can briefly bring the count to 0 and force an immediate disconnect/reconnect.
- Files: `nodes/opcua-endpoint.js:86-185`
- Cause: No grace period before disconnect; no ref-count fixed-time hysteresis.
- Improvement path: When `_refCount` reaches 0, schedule the disconnect with `setTimeout(...,500ms)` and cancel it if a new `getSharedManager()` arrives. **[PubSub-impacted]** — PubSub Subscriber will register itself as another ref-holder; the same hysteresis will benefit it.

### `readMultiple` / `writeMultiple` bound to `operationTimeout` per call
- Problem: Batch operations share a single 10s default timeout (`lib/opcua-client-manager.js:56`). For very large batches (hundreds of nodes) on slow servers, the call may time out, get marked disconnected (`_withTimeout` in `lib/opcua-client-manager.js:64-78` flips `isConnected = false`), and trigger a reconnect — even though the operation was simply slow.
- Files: `lib/opcua-client-manager.js:56`, `lib/opcua-client-manager.js:64-78`, `lib/opcua-client-manager.js:516-568`
- Cause: Timeout is fixed; reconnect is too aggressive.
- Improvement path: Scale timeout with batch size (e.g. `max(operationTimeout, items * 50ms)`); only mark disconnected for connection-level timeouts, not slow reads. Allow per-call timeout override via `msg.timeout`.

### Browse cache idle timer reset on every browse, not on inactivity
- Problem: `getBrowseConnection` (`nodes/opcua-browse-client.js:24-68`) resets the 60s idle timer on EVERY tree expansion. A user actively browsing for 10 minutes keeps the connection open — desired. But if the editor crashes mid-session, the connection survives until the next 60s tick after the timer last fired, with no upper bound.
- Files: `nodes/opcua-browse-client.js:24-68`
- Cause: Idle-only invalidation; no absolute TTL.
- Improvement path: Track `createdAt` and force-invalidate after e.g. 15 minutes regardless of activity.

### Recursive browse fans out without parallelism
- Problem: `browseRecursive` (`nodes/opcua-browser.js:116-146`) iterates references serially and calls `manager.browse()` for each child. A 5-deep, 10-wide tree = 100k sequential round-trips.
- Files: `nodes/opcua-browser.js:116-146`
- Cause: Sequential `for ... of` with `await` per child.
- Improvement path: `Promise.all(children.map(...))` with a small concurrency cap (e.g. 8). Better: drop the recursive node entirely (see "Standalone opcua-browser node duplicates" above).

### ExtensionObject `constructExtensionObject` round-trip per write
- Problem: For `writeMultiple` with N ExtensionObject items, `_createExtensionObjectVariant` (`lib/opcua-client-manager.js:356-359`) is awaited N times in `Promise.all` (`lib/opcua-client-manager.js:610-627`). Each call internally talks to the server's DataType manager. No caching of constructed type templates.
- Files: `lib/opcua-client-manager.js:327-359`, `lib/opcua-client-manager.js:606-647`
- Cause: No memoisation of resolved DataType constructors.
- Improvement path: Cache `dataTypeNodeId -> constructor` per session lifetime.

---

## Fragile Areas

### Reconnect logic — strings as control flow
- Files: `nodes/opcua-client.js:155-165`, `lib/opcua-client-manager.js:154-188`
- Why fragile: `isConnectionLostError(error)` matches by `error.message` substring (`Session is no longer valid`, `Not connected`, `premature disconnection`, `Secure Channel Closed`, `connection may have been rejected`, `Server end point`, `socket has been disconnected`). Each `node-opcua` minor version can rephrase any of these and silently break retry. The list grew from issue #9 (v0.0.5) → v0.0.6, suggesting it will continue to grow.
- Safe modification: Add a new substring to the OR chain in `isConnectionLostError` AND to the test cases (`test/opcua-client-retry.test.js`). Run integration tests against a real server (`test/integration-session-retry.test.js`).
- Test coverage: Good for the messages currently listed; nothing detects a phrase-rename until users report it. **[PubSub-impacted]** — PubSub Subscriber will see additional new error strings (DataSetReader-specific). A type-based detection (using `node-opcua` error codes / `StatusCode` constants) would be more robust.

### `hasBeenClosed` polymorphism (function vs property)
- Files: `lib/opcua-client-manager.js:397-405`
- Why fragile: The fix from v0.0.5 (commit 52dc434) checks `typeof this.session.hasBeenClosed === "function"` and falls back to property access. This straddles two `node-opcua` API generations. If the property branch is ever taken with a function reference, the function (truthy) makes every session look closed (the original bug from v0.0.5).
- Safe modification: Pin the minimum `node-opcua` version that exposes `hasBeenClosed()` as a method, and remove the property fallback.
- Test coverage: `test/opcua-client-manager.test.js:217-247` exercises both branches.

### ExtensionObject serialization (depth, schema discovery, OpaqueStructure)
- Files: `lib/opcua-utils.js:172-253`, `lib/opcua-client-manager.js:33-39`, `lib/opcua-client-manager.js:366-391`, `nodes/opcua-browse-client.js:233-318`
- Why fragile:
  - Depth is unbounded (`serializeExtensionObject` recurses without a depth cap). A circular schema would stack-overflow.
  - The `OpaqueStructure` import (`lib/opcua-client-manager.js:35`) targets a sub-package — if upstream renames or drops it, the fallback duck-type (`constructor.name === 'OpaqueStructure'`) is the only safety net.
  - Editor browse (`nodes/opcua-browse-client.js:233-318`) walks the Structure supertype chain by hand up to depth 5 (`opcua-browse-client.js:382-401`); this re-implements logic that node-opcua exposes through `dataTypeManager`.
  - Field discovery via `Object.keys(extObj) ∪ schema.fields` (`lib/opcua-utils.js:227-235`) silently drops fields whose names start with `_`.
- Safe modification: Add a depth cap (e.g. 16); introduce a regression test with a self-referential schema; consolidate the supertype walk into one helper.
- Test coverage: `test/opcua-client-manager.test.js:248-360` (only inside the `serializeExtensionObject` block) — does not cover the editor-browse value-extraction path nor the `OpaqueStructure-import-failed` fallback.

### Status callback set is a `Set` of closures with no identity check
- Files: `nodes/opcua-endpoint.js:89,162-168`, `nodes/opcua-client.js:51-69,279-281`
- Why fragile: Each consumer registers its own `statusCallback` closure and unregisters it on close. If a node throws before `registerStatusCallback`, the unregister call silently does nothing. If the same closure is registered twice (re-deploy race), only one removal succeeds.
- Safe modification: Have `registerStatusCallback` return a disposer function and require consumers to call it exclusively.
- Test coverage: `test/connection-sharing.test.js:171-213` covers happy paths only.

### Subscription survival across reconnect
- Files: `lib/opcua-client-manager.js:50,167-182,212-219`, `nodes/opcua-browse-client.js:513-517,540-617`
- Why fragile: When the manager reconnects (via `after_reconnection`), it recreates the session but does NOT recreate any `ClientSubscription` objects stored in `this.subscriptions`. Existing `monitorItems` are bound to the old subscription/session. On `disconnected`, `opcua-browse-client` clears `monitorItems` and `subscription` (`opcua-browse-client.js:513-517`); on `connected` (after reconnect), it calls `setupSubscriptions()` again — but `opcua-client`'s subscribe path only clears in `statusCallback` (`opcua-client.js:56-59`) and does NOT re-subscribe automatically.
- Impact: After a server restart, an `opcua-client` subscribe flow goes silent until the user re-injects a `subscribe` message.
- Safe modification: Add `manager.on('connected', resubscribe)` per node, OR (better) have the manager track active monitored items and re-create them itself. **[PubSub-impacted]** — same problem applies to PubSub DataSetReaders.
- Test coverage: None. The retry tests only exercise read/write retry, not subscription survival.

### `opcua-server` start failure is unrecoverable
- Files: `nodes/opcua-server.js:34-74,144-147`
- Why fragile: `startServer()` is called once at construction (`opcua-server.js:145`). If the port is in use, `node.error` is logged but the node never retries; the only path to recovery is redeploy. There is no input message that triggers a restart.
- Safe modification: Add a `restart` command, or schedule a backoff retry on EADDRINUSE.

---

## Scaling Limits

### Single shared session per endpoint
- Current capacity: One OPC UA session per endpoint config node. All consumer nodes (read/write/subscribe/browse/method/event) multiplex through it.
- Limit: For very high read/write rates the single session becomes a serialization bottleneck (`session.read` / `session.write` are processed in order per session).
- Scaling path: Allow N parallel sessions per endpoint and round-robin operations. **[PubSub-impacted]** — PubSub does not use sessions, so this limit does not apply to PubSub itself, but a hybrid flow (PubSub + classic) will still bottleneck on session ops.

### Embedded `opcua-server` accepts hard-coded `maxAllowedSessionNumber=10` default
- Current capacity: 10 sessions, 10 connections per endpoint by default (`nodes/opcua-server.js:23-24`).
- Limit: Sufficient for prototyping; insufficient for any deployment with > 10 clients.
- Scaling path: Already user-configurable via the editor; document recommended values.

### `subscriptions: Map` and `monitorItems: Map` grow without GC
- Current capacity: Unbounded. Each subscribe adds an entry; unsubscribe removes one. A buggy flow that subscribes in a loop without unsubscribing leaks entries until disconnect.
- Files: `lib/opcua-client-manager.js:50`, `nodes/opcua-client.js:43`, `nodes/opcua-browse-client.js:497`
- Scaling path: Add an upper bound + warn on growth.

---

## Dependencies at Risk

### `node-opcua` ^2.115.0
- Risk: Single critical dependency (`package.json:34-36`). Any breaking change in 2.x (or a forced 3.0 upgrade) ripples through every node.
- Impact: Reconnect string detection, `hasBeenClosed` shape, ExtensionObject schema fields, `OpaqueStructure` location — all coupled to internals.
- Migration plan: Pin a tested minor range; introduce a thin adapter file (`lib/node-opcua-adapter.js`) that re-exports a stable subset and contains the version-specific shims. **[PubSub-impacted]** — PubSub support in `node-opcua` is a separate sub-package; choose its version carefully.

### Optional `node-opcua-extension-object` import
- Risk: `lib/opcua-client-manager.js:33-39` does a try/catch require. If installed by `node-opcua` as a transitive but later removed, the duck-type fallback is the only path.
- Migration plan: Add `node-opcua-extension-object` to direct `dependencies` in `package.json`.

### Pre-1.0 versioning state
- Risk: At v0.0.7, the public API (msg.\* fields, node config schema) is not under semver. The v0.0.6 → v0.0.7 transition added `verboseLog`, `retryAttempts`, and changed `port` coercion behaviour (`CHANGELOG.md`). Users have no contract preventing breaking changes.
- Impact: Each minor release can break flow JSON.
- Migration plan: Before adding PubSub, freeze the existing `msg.*` fields and node config schema; document them as the 1.0 API; add migration tests for legacy flows. **[PubSub-impacted]** — PubSub introduces an entirely new node type plus likely new top-level `msg.*` fields (e.g. `msg.dataSet`, `msg.writerGroup`); doing this on a stable 1.0 base avoids compounding the schema churn.

---

## Missing Critical Features

### No automatic re-subscription after reconnect
- Problem: Subscriptions silently die after a server restart for `opcua-client` (`nodes/opcua-client.js:51-69`). Only `opcua-browse-client` re-subscribes (`opcua-browse-client.js:540-617`).
- Blocks: Long-running monitoring flows.
- See: "Subscription survival across reconnect" above. **[PubSub-impacted]**

### No connection diagnostics surface
- Problem: There is no node or HTTP endpoint that reports current ref-count, connected-since, last error, or active monitored items per endpoint. Users have to read `node.log` from Node-RED's stderr.
- Blocks: Debugging in production.
- Suggestion: `opcua-server.getServerInfo` exists (`nodes/opcua-server.js:354-367`). Add an analogous `opcua-endpoint.getDiagnostics` HTTP route or an `opcua-status` node.

### No example / docs for cert-based authentication end-to-end
- Problem: `README.md:81` mentions cert drag-and-drop but there is no example flow that demonstrates `userCertificateFile` + `userPrivateKeyFile` (`lib/opcua-client-manager.js:264-275`).
- Blocks: Adoption in security-conscious environments.

### No rate limiting on `setValue` for embedded server
- Problem: A flow that calls `opcua-server { command: 'setValue' }` at high frequency will flood the server's address space without backpressure. There is no per-node debounce.
- Files: `nodes/opcua-server.js:223-254`
- Suggestion: Document the limit; consider an opt-in `coalesce` flag.

---

## Test Coverage Gaps

### `opcua-browse-client` runtime + editor browse
- What's not tested: The 725-line file has zero unit tests. Editor HTTP routes (`POST /opcua-browse-client/browse`, `POST /opcua-browse-client/disconnect`) are uncovered, the structured-type supertype walk (`opcua-browse-client.js:382-401`) is uncovered, and the runtime `setupSubscriptions` path is uncovered.
- Files: `nodes/opcua-browse-client.js`
- Risk: Highest-risk gap — most complex file, most server-specific quirks, no safety net.
- Priority: **High**

### Subscription survival / re-subscribe after reconnect
- What's not tested: No test kills the server while a `subscribe` is active and asserts that messages resume.
- Files: integration tests cover read/readMultiple/write retry only (`test/integration-session-retry.test.js:97-369`)
- Risk: Production regressions silently kill monitoring flows.
- Priority: **High**

### `opcua-server` `addMethod` / `raiseEvent` / `setWritable`
- What's not tested: `nodes/opcua-server.js:276-429` (method, event, writable) has no direct tests. Only `addVariable` and port coercion are covered (`test/opcua-nodes.test.js:271-503`).
- Files: `nodes/opcua-server.js:276-429`
- Risk: Method / event functionality may regress unnoticed.
- Priority: **Medium**

### ExtensionObject write path and OpaqueStructure-fallback
- What's not tested: `_createExtensionObjectVariant`, `constructExtensionObject`, `writeMultiple` with ExtensionObjects are not exercised end-to-end. `_serializeValue` array branch with `OpaqueStructure === null` is uncovered.
- Files: `lib/opcua-client-manager.js:327-391,572-647`
- Risk: ExtensionObject writes silently fail or produce wrong type encoding.
- Priority: **Medium**

### Cert upload HTTP API
- What's not tested: `POST/GET/DELETE /opcua-endpoint/upload-cert(s)` are uncovered. Filename sanitisation, missing-content rejection, oversize content all unverified.
- Files: `nodes/opcua-endpoint.js:23-62`
- Risk: Security regression goes unnoticed.
- Priority: **Medium**

### Recursive browse
- What's not tested: `browseRecursive` (`nodes/opcua-browser.js:116-146`) is uncovered. `maxDepth`, error swallowing, and node-class filtering are unverified.
- Files: `nodes/opcua-browser.js`
- Risk: Recursive browse silently wrong.
- Priority: **Low**

### History read continuation
- What's not tested: `historyRead` (`lib/opcua-client-manager.js:713-755`) returns `continuationPoint` but no test exercises pagination.
- Files: `lib/opcua-client-manager.js:713-755`, `nodes/opcua-client.js:614-633`
- Risk: Large history reads truncated at `numValuesPerNode` (default 1000) without surfacing.
- Priority: **Low**

### Concurrent reconnect lock (`reconnectPromise`)
- What's not tested: The single-flight reconnect lock from v0.0.6 (`nodes/opcua-client.js:177-187`) has no targeted concurrency test. Tests cover sequential retry but not "10 messages arrive while reconnect is in progress".
- Files: `nodes/opcua-client.js:177-210`
- Risk: Race regression brings back the v0.0.5 stale-session bug.
- Priority: **Medium**

---

## Maintenance Burden

### Two `node-opcua` API surfaces (top-level + sub-packages)
- The codebase imports from `node-opcua` (15+ symbols) and `node-opcua-extension-object` (one symbol, optionally). Each upstream release requires a quick audit of both.

### Mixed code style across files
- `nodes/opcua-endpoint.js`, `nodes/opcua-event.js`, `nodes/opcua-method.js`, `nodes/opcua-browser.js`, `nodes/opcua-server.js` use single quotes and 4-space indent.
- `nodes/opcua-client.js`, `nodes/opcua-browse-client.js`, `lib/opcua-client-manager.js`, `lib/opcua-utils.js` use double quotes and 2-space indent.
- Prettier is configured (`package.json:30`) but not enforced via pre-commit. Mixed style means cosmetic noise on every PR.
- Fix: Run `npm run format` once and add a CI check.

### HTML editor files duplicate dropzone logic
- `nodes/opcua-endpoint.html` (463 lines) contains setup for 4 different cert dropzones via `setupCertUpload()`. The same drag-drop pattern is reimplemented in `nodes/opcua-browse-client.html` (1049 lines — the largest file in the project).
- Fix: Extract a shared client-side helper into a static asset. **[PubSub-impacted]** — PubSub will likely add another config node with cert support; consolidating now avoids three copies.

### Test infrastructure mocks Node-RED by hand
- Each test file (`test/connection-sharing.test.js`, `test/opcua-client-retry.test.js`, `test/opcua-nodes.test.js`, `test/integration-session-retry.test.js`) re-implements its own `createRED()` mock with `nodes.createNode`, `registerType`, and `getNode`. The implementations differ subtly (e.g. event registration, status stubbing).
- Fix: Extract `test/helpers/mock-red.js` and import it everywhere. Consider `node-red-node-test-helper` for the registration/wiring tests.

### `live-integration.js` and `run-examples.js` are runner scripts, not Mocha tests
- They are invoked manually (`README.md:250`). Not part of `npm test`. Coverage from these is invisible to CI.
- Fix: Wrap them in a Mocha `describe` with a `before` that boots the test server, or document them as a separate `npm run test:live` target (currently `test:integration` points at `test-server/test-client.js`, not `live-integration.js`).

---

## PubSub Milestone — Inherited / Amplified Concerns

The upcoming PubSub milestone (Subscriber + Publisher nodes for UDP/MQTT/AMQP transport) will inherit or amplify the following concerns. Address them before or as part of that work:

1. **Reconnect logic duplication** (Tech Debt §1) — A PubSub Subscriber needs reconnect/resubscribe semantics distinct from the classic Client/Server session model. Without consolidation in the manager, expect a third copy of retry code in a `pubsub-subscriber.js` node. **Fix first.**
2. **Subscription handling lives in the consumer** (Tech Debt §3) — DataSetReader monitoring is conceptually identical to ClientMonitoredItem. The fourth duplicate is avoidable by introducing a unified subscription API on the manager (or a sibling `OpcUaPubSubManager`) before PubSub work starts.
3. **Cert handling duplication** (Maintenance §3) — PubSub uses the same security policies and certs as classic OPC UA. Consolidate the editor dropzone + the file-system writer into a shared module so PubSub's config node uses one path.
4. **Error-message string matching** (Fragile §1) — PubSub will introduce new error phrases (e.g. `DataSet decode failed`, `WriterGroup unreachable`). Move from substring matching to status-code-based detection now.
5. **Subscription survival across reconnect** (Fragile §5) — Identical problem applies to DataSetReaders. Solve once for both.
6. **Shared connection ref-count hysteresis** (Performance §1) — A PubSub node is another ref-holder; redeploy churn will cause extra disconnect storms without a grace period.
7. **Pre-1.0 schema churn** (Dependencies §3) — Freeze the v1.0 `msg.*` and config schema BEFORE adding PubSub. Otherwise PubSub-related schema additions compound with breaking changes from existing nodes.
8. **Diagnostics surface** (Missing Features §2) — PubSub adds another moving part (network discovery, multicast, transport state); a unified diagnostics endpoint becomes more valuable, not less.

---

*Concerns audit: 2026-05-08*
