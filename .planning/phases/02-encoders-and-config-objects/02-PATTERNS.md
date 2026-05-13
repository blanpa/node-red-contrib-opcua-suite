# Phase 2: Encoders and Config Objects — Pattern Map

**Mapped:** 2026-05-13
**Files analyzed:** 7 new files
**Analogs found:** 6 / 7 (1 novel pattern — validate+factory hybrid)

---

## File Classification

| New / Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---------------------|------|-----------|----------------|---------------|
| `lib/uadp-encoder.js` | utility (encoder) | transform | `lib/opcua-utils.js` | role-match (pure lib, named-exports) |
| `lib/json-encoder.js` | utility (encoder) | transform | `lib/opcua-utils.js` | role-match (pure lib, named-exports; `serializeExtensionObject` pattern) |
| `lib/pubsub-config.js` | utility (config/validator) | transform | `lib/cert-store.js` | role-match (pure lib, named-exports, JSDoc banner) |
| `test/uadp-encoder.test.js` | test | — | `test/cert-store.test.js` | exact (Mocha + Chai, describe/it, local helpers) |
| `test/json-encoder.test.js` | test | — | `test/cert-store.test.js` | exact |
| `test/pubsub-config.test.js` | test | — | `test/cert-store.test.js` | exact |
| `test/fixtures/uadp-vectors.js` | fixture | — | none (first fixture file in repo) | novel — see No Analog section |
| `test-server/capture-open62541-vectors.js` | runnable script | — | `test-server/server.js` | role-match (manual script, `if (require.main === module) main()` pattern) |

---

## Pattern Assignments

### `lib/uadp-encoder.js` (utility, transform)

**Analog:** `lib/opcua-utils.js`
**Secondary analog:** `lib/cert-store.js` (file-level JSDoc banner)

**File-level JSDoc banner pattern** — `lib/cert-store.js` lines 1–21:
```js
/**
 * Certificate Store
 *
 * Pure-function helpers and an Express-route factory for OPC UA certificate
 * management. Designed for reuse: no dependency on any other lib/ module so it
 * can be required by any Node-RED config node ...
 *
 * Exports:
 *   sanitiseFilename(name)                 -> string
 *   getCertsDir(RED)                       -> string
 *   ...
 */

"use strict";
```
Apply: open `lib/uadp-encoder.js` with a banner that names all four exported functions and their signatures. Include `"use strict";` immediately after.

**Named-exports pattern** — `lib/opcua-utils.js` lines 255–263:
```js
module.exports = {
  parseNodeId,
  nodeIdToString,
  parseDataType,
  createError,
  isValidEndpointUrl,
  serializeExtensionObject,
  WELL_KNOWN_NODES,
};
```
Apply: end `lib/uadp-encoder.js` with a single `module.exports = { encodeNetworkMessage, decodeNetworkMessage, encodeDataSetMessage, decodeDataSetMessage };` block — no default export, no barrel.

**`createError` usage for structured errors** — `lib/opcua-utils.js` lines 155–161:
```js
function createError(message, error = null) {
  return {
    message: message,
    error: error ? error.message : undefined,
    stack: error ? error.stack : undefined,
  };
}
```
Apply: require `createError` from `../lib/opcua-utils` and throw `createError(...)` on decode failures (e.g. truncated buffer, unknown flag byte values). Do NOT `throw new Error(...)` raw strings — use `createError` for consistency (D-21).

**Section divider style** — `lib/cert-store.js` uses none, but `lib/opcua-client-manager.js` and all newer test files use the box-drawing style. Apply to UADP encoder for readability across the large file:
```js
// ─── BinaryStream (private) ───
// ─── Flag Helpers ───
// ─── NetworkMessage Encode ───
// ─── NetworkMessage Decode ───
// ─── DataSetMessage Encode ───
// ─── DataSetMessage Decode ───
```

**Private file-local class pattern** — no existing lib file has a private class, but `lib/opcua-client-manager.js` demonstrates private state via closure variables and internal `_`-prefixed methods (CONVENTIONS.md lines 49–50). The `BinaryStream` class is file-local (not in `module.exports`). Declare it before the exported functions; it is never imported by any other module (D-02).

**JSDoc on every exported function** — `lib/cert-store.js` lines 33–38, 43–48, 64–67, 78–82, 97–103:
```js
/**
 * Replaces every character outside [a-zA-Z0-9._-] with an underscore.
 * Mirrors the existing inline regex in nodes/opcua-endpoint.js ...
 */
function sanitiseFilename(name) {
```
Apply: each of the four exported functions in `lib/uadp-encoder.js` gets a JSDoc block with `@param` and `@returns` describing types. Mention `opts` as reserved (D-04): `@param {object} [opts] Reserved for future extension (security, MTU). Unused in Phase 2.`

---

### `lib/json-encoder.js` (utility, transform)

**Analog:** `lib/opcua-utils.js` (primary — reused helpers), `lib/cert-store.js` (file structure)

**Named-exports pattern** — same as `lib/opcua-utils.js` lines 255–263 above. End with:
```js
module.exports = {
  encodeNetworkMessage,
  decodeNetworkMessage,
};
```

**`nodeIdToString` reuse** — `lib/opcua-utils.js` lines 107–132:
```js
function nodeIdToString(nodeId) {
  if (!nodeId) return "";
  const ns = nodeId.namespaceIndex !== undefined ? nodeId.namespaceIndex : 0;
  let identifier = "";
  if (nodeId.identifierType === "Guid") {
    identifier = `g=${nodeId.value}`;
  } else if (nodeId.identifierType === "ByteString") {
    identifier = `b=${nodeId.value}`;
  } else if (nodeId.identifierType === "String" || typeof nodeId.value === "string") {
    identifier = `s=${nodeId.value}`;
  } else if (nodeId.identifierType === "Numeric" || typeof nodeId.value === "number") {
    identifier = `i=${nodeId.value}`;
  } else {
    identifier = `s=${nodeId.value}`;
  }
  return `ns=${ns};${identifier}`;
}
```
Apply: require `{ nodeIdToString, parseNodeId, createError }` from `"../lib/opcua-utils"` at the top of `lib/json-encoder.js`. Use `nodeIdToString` for Variant fields whose value is a NodeId. Note from RESEARCH.md open question 2: `nodeIdToString` produces namespace-index form (`ns=X;...`), not namespace-URI form — this is acceptable for Phase 2; add a comment near the call-site flagging the limitation.

**`serializeExtensionObject` type-dispatch pattern** — `lib/opcua-utils.js` lines 181–252 — shows the idiom for checking `instanceof Date`, `Buffer.isBuffer()`, then falling through to object recursion:
```js
if (extObj instanceof Date) {
  return extObj.toISOString();
}
if (Buffer.isBuffer(extObj)) {
  return extObj.toString("base64");
}
```
Apply: use the same `instanceof Date → .toISOString()` and `Buffer.isBuffer → .toString("base64")` checks inside the JSON encoder's per-field value converter (D-05/D-07). These two built-in conversions are already proven in the codebase.

**Structured decoder error (D-08)** — novel shape, but mirrors `createError` return shape. Throw via:
```js
const err = createError(`Required field '${path}' is missing`);
err.code = "JSON_DECODE_MISSING_FIELD";
err.path = path;
throw err;
```
This extends `createError`'s `{message, error, stack}` shape with `code` and `path` fields (consistent with D-14 Issue shape used in `pubsub-config.js`).

---

### `lib/pubsub-config.js` (utility, transform)

**Analog:** `lib/cert-store.js` (structure, JSDoc banner, named-exports)

**File-level JSDoc banner** — `lib/cert-store.js` lines 1–21. Apply the same multiline banner pattern listing all exported symbols and their signatures:
```js
/**
 * PubSub Configuration Objects
 *
 * Pure validators and frozen-object factories for OPC UA PubSub
 * configuration: WriterGroup, DataSetWriter, PublishedDataSet, DataSetReader.
 *
 * Exports:
 *   validateWriterGroup(cfg)      -> { valid: boolean, errors: Issue[] }
 *   WriterGroup(cfg)              -> Readonly<WriterGroupConfig>  (throws on invalid)
 *   validateDataSetWriter(cfg)    -> { valid: boolean, errors: Issue[] }
 *   DataSetWriter(cfg)            -> Readonly<DataSetWriterConfig>
 *   validatePublishedDataSet(cfg) -> { valid: boolean, errors: Issue[] }
 *   PublishedDataSet(cfg)         -> Readonly<PublishedDataSetConfig>
 *   validateDataSetReader(cfg)    -> { valid: boolean, errors: Issue[] }
 *   DataSetReader(cfg)            -> Readonly<DataSetReaderConfig>
 */

"use strict";
```

**Named-exports pattern** — `lib/opcua-utils.js` lines 255–263. Apply at file end:
```js
module.exports = {
  validateWriterGroup,
  WriterGroup,
  validateDataSetWriter,
  DataSetWriter,
  validatePublishedDataSet,
  PublishedDataSet,
  validateDataSetReader,
  DataSetReader,
};
```

**`createError` for factory throw** — `lib/opcua-utils.js` lines 155–161. Factories call:
```js
const { valid, errors } = validateWriterGroup(cfg);
if (!valid) {
  throw createError(errors[0].message);
}
```
The thrown object has `{ message, error: undefined, stack: undefined }` shape — consistent with existing error propagation in `nodes/opcua-client.js` (CONVENTIONS.md line 172).

**Validate + factory hybrid** — novel pattern in this codebase (D-13). No existing analog. Design from scratch per CONTEXT.md D-13/D-14/D-15/D-16. See RESEARCH.md Pattern 4 (lines 308–349) for the reference implementation sketch.

**`Object.freeze` on factory return** — no existing codebase usage, but standard JS. Apply per D-16:
```js
return Object.freeze(result);
```

**`parseDataType` reuse** — `lib/opcua-utils.js` lines 137–150. Require and use inside `validatePublishedDataSet` when checking field type declarations against abstract-type and array-dimension constraints (PITFALLS Pitfall 2 / D-15 RawData validation).

---

### `test/uadp-encoder.test.js` (test)

**Analog:** `test/cert-store.test.js` (exact structural match)

**File header and strict mode** — `test/cert-store.test.js` lines 1–17:
```js
"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const fs = require("fs");
const os = require("os");
const path = require("path");

const certStore = require("../lib/cert-store");
const {
  sanitiseFilename,
  getCertsDir,
  ...
} = certStore;
```
Apply to `test/uadp-encoder.test.js`:
```js
"use strict";

const { expect } = require("chai");
// const sinon = require("sinon");  // only if stubs needed

const { encodeNetworkMessage, decodeNetworkMessage, encodeDataSetMessage, decodeDataSetMessage } = require("../lib/uadp-encoder");
const vectors = require("./fixtures/uadp-vectors");
```

**Top-of-file local helper pattern** — `test/cert-store.test.js` lines 21–51 (makeMockRED, makeRes, rmrf). Apply: define a local `hexToBuffer(hexStr)` helper that strips spaces and calls `Buffer.from(str, "hex")`.

**Section divider and describe/it structure** — `test/cert-store.test.js` lines 81–113:
```js
// ─── module exports ───

describe("module exports", function () {
  it("exports the six required functions", function () {
    expect(sanitiseFilename).to.be.a("function");
    ...
  });
});

// ─── sanitiseFilename ───

describe("sanitiseFilename", function () {
  it("replaces spaces with underscores", function () {
    expect(sanitiseFilename("my cert.pem")).to.equal("my_cert.pem");
  });
  ...
});
```
Apply: one top-level `describe("uadp-encoder", ...)` with nested `describe` per logical area: `"module exports"`, `"8-combination flag cascade matrix"`, `"round-trip"`, `"PublisherId variants"`, `"chunking"`.

**Async error testing** — `test/cert-store.test.js` lines 153–163 (sync throw):
```js
let caught = null;
try {
  await uploadCert(TMP_DIR, "test.pem", "");
} catch (err) {
  caught = err;
}
expect(caught).to.not.equal(null);
expect(caught.status).to.equal(400);
```
Apply the same pattern for sync throws from `decodeNetworkMessage` on truncated/invalid buffers. For sync throws use `expect(() => decodeNetworkMessage(buf)).to.throw(...)`.

**`deep.equal` for object comparison** — used throughout `test/opcua-utils.test.js` (e.g., lines 47–53):
```js
expect(result).to.deep.equal({
  namespaceIndex: 2,
  identifierType: "String",
  value: "Var"
});
```
Apply: `expect(decoded).to.deep.equal(vec.model)` for decode assertions.

**Hex string comparison** — no existing codebase precedent (first binary encoder). Use:
```js
expect(encoded.toString("hex")).to.equal(vec.hex.replace(/\s/g, ""));
```
This mirrors the "string equality for human-readable values" style seen throughout `test/opcua-utils.test.js`.

---

### `test/json-encoder.test.js` (test)

**Analog:** `test/cert-store.test.js` (identical structure)

Apply the same file header, strict mode, section-divider, describe/it skeleton as `test/uadp-encoder.test.js` above.

**Deterministic field-order verification** — novel assertion. Use:
```js
const json = encodeNetworkMessage(model);
const parsed = JSON.parse(json);
const keys = Object.keys(parsed.Messages[0]);
expect(keys).to.deep.equal(["DataSetWriterId", "SequenceNumber", "Timestamp", "MessageType", "Payload"]);
```
This catches `Object.keys()` non-determinism regressions (D-07 requirement).

**NodeId / DateTime / ByteString type assertions** — use `to.equal` on exact string values:
```js
expect(parsed.Messages[0].Payload["myNode"].Value).to.equal("ns=2;s=Temperature");
expect(parsed.Messages[0].Timestamp).to.match(/^\d{4}-\d{2}-\d{2}T/);  // ISO-8601 prefix
```

---

### `test/pubsub-config.test.js` (test)

**Analog:** `test/cert-store.test.js` (identical structure)

**Validator return-shape assertion pattern** — novel, but follows `deep.equal` style:
```js
const result = validateWriterGroup({ publishingInterval: 100, keepAliveTime: 50 });
expect(result.valid).to.equal(false);
expect(result.errors).to.have.length(1);
expect(result.errors[0]).to.deep.equal({
  path: "keepAliveTime",
  code: "MUST_BE_GTE_PUBLISHING_INTERVAL",
  message: "keepAliveTime must be >= publishingInterval",
});
```

**Factory throw pattern** — mirrors cert-store.test.js `rejects with status 404` pattern (lines 201–211) but for sync throws:
```js
expect(() => WriterGroup({ publishingInterval: -1 })).to.throw();
```

**`Object.freeze` assertion** — no precedent in codebase. Use:
```js
const wg = WriterGroup({ publishingInterval: 100, writerGroupId: 1 });
expect(Object.isFrozen(wg)).to.equal(true);
```

**Default-value assertions** — use `to.equal` on specific fields:
```js
const wg = WriterGroup({ publishingInterval: 100, writerGroupId: 1 });
expect(wg.maxNetworkMessageSize).to.equal(1400);
expect(wg.priority).to.equal(128);
expect(wg.keepAliveTime).to.equal(100);  // defaults to publishingInterval
```

---

### `test-server/capture-open62541-vectors.js` (runnable script)

**Analog:** `test-server/server.js`

**Script header with purpose comment** — `test-server/server.js` lines 1–8:
```js
/**
 * OPC UA Test Server
 * Supports ALL OPC UA authentication methods:
 *   - Anonymous
 *   - Username/Password
 *   - X509 Certificate
 * And all Security Modes / Policies
 */
```
Apply: same multiline JSDoc header describing what the script does, what Docker image is needed, and how to run it.

**Entry-point guard** — `test-server/server.js` (last lines):
```js
startServer().catch((err) => {
  console.error("Fehler beim Starten:", err);
  process.exit(1);
});
```
Apply the D-18 pattern instead (explicit `require.main` check, more portable):
```js
if (require.main === module) main();
```
The `require.main === module` guard is the project convention from CONTEXT.md D-18 and CONVENTIONS.md line 25 (manual-script pattern for `test/live-integration.js`, `test/run-examples.js`).

**No `"use strict"` in script file** — `test-server/server.js` has no `"use strict"` at the top (matches `lib/*.js` pattern — see CONVENTIONS.md line 83). Capture script follows the same convention.

---

## Shared Patterns

### Named-Exports Object
**Source:** `lib/opcua-utils.js` lines 255–263
**Apply to:** `lib/uadp-encoder.js`, `lib/json-encoder.js`, `lib/pubsub-config.js`
```js
module.exports = {
  fn1,
  fn2,
  // ...
};
```
Single `module.exports = { ... }` at the very end of the file. No inline `module.exports.fn = ...` assignments mid-file.

### File-Level JSDoc Banner + `"use strict"`
**Source:** `lib/cert-store.js` lines 1–24
**Apply to:** `lib/uadp-encoder.js`, `lib/json-encoder.js`, `lib/pubsub-config.js`
```js
/**
 * <Module Title>
 *
 * <One-line purpose>. No I/O, no Node-RED coupling.
 *
 * Exports:
 *   fn1(arg) -> ReturnType
 *   fn2(arg) -> ReturnType
 */

"use strict";
```
Note: `lib/*.js` files do NOT have `"use strict"` currently (`cert-store.js` is the exception — it does). Test files all have it. Follow `cert-store.js` and add `"use strict"` to the three new lib files, consistent with D-21's Phase 1 refactor direction.

### `createError` for All Error Construction
**Source:** `lib/opcua-utils.js` lines 155–161
**Apply to:** `lib/uadp-encoder.js`, `lib/json-encoder.js`, `lib/pubsub-config.js`
```js
const { createError, nodeIdToString, parseNodeId, parseDataType } = require("./opcua-utils");
```
All thrown objects originate from `createError(message)` or `createError(message, caughtErr)`. Do not throw plain `new Error(...)` in public functions (D-21 requires consistency with existing `lib/` convention).

### Section Dividers in Source and Test Files
**Source:** `test/cert-store.test.js` lines 81, 94, 116, 142, 173, 195, 217 + `lib/opcua-client-manager.js` (throughout)
**Apply to:** all new `lib/*.js` and `test/*.test.js` files
```js
// ─── Section Name ───
```
Use em-dash box-drawing characters (`─`) for visual separation between logical sections. This is the established style in all newer files.

### Mocha Test File Skeleton
**Source:** `test/cert-store.test.js` lines 1–53 (header + helpers)
**Apply to:** `test/uadp-encoder.test.js`, `test/json-encoder.test.js`, `test/pubsub-config.test.js`
```js
"use strict";

const { expect } = require("chai");
// const sinon = require("sinon");   // only add when stubs are actually needed

const { <exports> } = require("../<path>");

// ─── <local helpers> ───

function helperFn() { ... }

describe("<subject>", function () {

  // ─── <section> ───

  describe("<section>", function () {
    it("should <verb phrase>", function () {
      expect(...).to.equal(...);
    });
  });
});
```
2-space indent, double quotes, `it("should <verb>", ...)` naming. No `this.timeout()` unless the test involves async I/O.

### Double Quotes + 2-Space Indent
**Source:** `lib/opcua-utils.js`, `lib/cert-store.js`, `test/cert-store.test.js`
**Apply to:** all Phase 2 files
CONVENTIONS.md lines 73–76 confirms 2-space + double quotes is the active-refactor style for all new `lib/` and newer test files.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `test/fixtures/uadp-vectors.js` | fixture module | — | No fixture directory exists yet in the codebase. First hex-literal test vector file. Design from scratch per D-17: `"use strict";`, JSDoc banner describing the fixture format, `module.exports = { caseName: { model, hex, flags, provenance, specRef }, ... }`. Use em-dash section dividers per combination group. Hex string format: space-separated byte pairs (`"01 10 00"`) so reviewers can read field boundaries — strips spaces with `vec.hex.replace(/\s/g, "")` in test assertions. |
| validate+factory hybrid in `lib/pubsub-config.js` | utility | — | No existing `validate*() + Factory()` pair in the codebase. Novel per D-13. Design from scratch using the reference sketch in RESEARCH.md Pattern 4 (lines 308–349). Key constraint: `validate*()` collects all errors and returns `{ valid, errors }`; factory calls `validate*()`, throws `createError(errors[0].message)` on first error, applies defaults via `??` nullish coalescing, then `Object.freeze(result)`. |

---

## Key Notes for Planner

1. **`lib/uadp-encoder.js` is the largest and most complex file.** The conditional-serializer `BinaryStream` class is private to the file (not in `module.exports`). Plan its implementation as the first wave — the test fixture file and tests depend on it.

2. **No new `require()` installs needed.** All Phase 2 files import only: `"../lib/opcua-utils"` (project internal) and Node.js built-ins (`buffer` is implicit). The `"use strict"` + CommonJS + 2-space + double-quote rules apply uniformly.

3. **`test/fixtures/` directory is new.** The planner must include a step to create `test/fixtures/` before writing `test/fixtures/uadp-vectors.js`. No other setup needed — Mocha's `test/**/*.test.js` glob picks up new test files automatically.

4. **`test-server/capture-open62541-vectors.js` is NOT picked up by `npm test`.** It does not end in `.test.js`. No change to `package.json` scripts needed. It is invoked manually: `node test-server/capture-open62541-vectors.js`.

5. **`nodeIdToString` produces namespace-index form only** (`ns=X;s=...`). For Phase 2 JSON encoder this is acceptable. Add a `// TODO Phase 3: add namespace-URI form per Part 6 §5.4` comment at the call site (RESEARCH.md open question 2, assumption A4).

---

## Metadata

**Analog search scope:** `lib/`, `test/`, `test-server/`, `.planning/codebase/`
**Files read:** `lib/opcua-utils.js`, `lib/cert-store.js`, `test/cert-store.test.js`, `test/opcua-utils.test.js` (first 80 lines), `test/opcua-client-manager.test.js` (first 50 lines), `test/opcua-client-manager-reconnect.test.js` (first 80 lines), `test-server/server.js` (first 60 + last 20 lines), `.planning/codebase/CONVENTIONS.md`, `.planning/codebase/TESTING.md`
**Files scanned for structure:** `package.json` (scripts section)
**Pattern extraction date:** 2026-05-13
