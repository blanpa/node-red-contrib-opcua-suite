---
phase: 01-pre-work
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - lib/cert-store.js
  - nodes/opcua-endpoint.js
  - nodes/opcua-endpoint.html
  - test/cert-store.test.js
autonomous: true
requirements:
  - DEBT-02

must_haves:
  truths:
    - "lib/cert-store.js exists and exports the six functions listed in D-06"
    - "nodes/opcua-endpoint.js no longer contains inline POST/GET/DELETE route registration; it calls registerCertRoutes() once"
    - "nodes/opcua-endpoint.html builds all upload URLs from a single CERT_ROUTE_PREFIX constant"
    - "A unit test can call registerCertRoutes(mockRED, '/test-prefix', tmpDir) and verify three routes registered"
    - "Full Mocha suite passes (npm test) after all commits in this plan"
  artifacts:
    - path: "lib/cert-store.js"
      provides: "Pure-function cert helper: sanitiseFilename, getCertsDir, listCerts, uploadCert, deleteCert, registerCertRoutes"
      exports: ["sanitiseFilename", "getCertsDir", "listCerts", "uploadCert", "deleteCert", "registerCertRoutes"]
    - path: "nodes/opcua-endpoint.js"
      provides: "Calls registerCertRoutes(RED, '/opcua-endpoint', getCertsDir(RED)) instead of inline route block"
      contains: "registerCertRoutes("
    - path: "nodes/opcua-endpoint.html"
      provides: "Single CERT_ROUTE_PREFIX constant; all fetch URLs built from it"
      contains: "CERT_ROUTE_PREFIX"
    - path: "test/cert-store.test.js"
      provides: "Unit tests: three routes registered, upload writes file, list returns names, delete removes file, sanitiseFilename, missing-content 400, file-not-found 404"
  key_links:
    - from: "nodes/opcua-endpoint.js module body"
      to: "lib/cert-store.js::registerCertRoutes"
      via: "require('../lib/cert-store')"
      pattern: "registerCertRoutes\\(RED"
    - from: "nodes/opcua-endpoint.html uploadFile()"
      to: "CERT_ROUTE_PREFIX constant"
      via: "CERT_ROUTE_PREFIX + '/upload-cert'"
      pattern: "CERT_ROUTE_PREFIX"
---

<objective>
Extract certificate filesystem operations and HTTP-route registration from nodes/opcua-endpoint.js into a new lib/cert-store.js module with a parameterised prefix factory, so the upcoming opcua-pubsub-connection config node can reuse it without copy-paste.

Purpose: DEBT-02 — enables PubSub cert UI reuse; eliminates the cert-upload test gap identified in CONCERNS.md; does not change any user-visible behaviour of the existing endpoint config node.
Output: lib/cert-store.js (new file); refactored nodes/opcua-endpoint.js and nodes/opcua-endpoint.html; test/cert-store.test.js (new file).
</objective>

<execution_context>
@/home/la/private/node-red-contrib-opcua-suite/.planning/phases/01-pre-work/01-CONTEXT.md
</execution_context>

<context>
@/home/la/private/node-red-contrib-opcua-suite/.planning/PROJECT.md
@/home/la/private/node-red-contrib-opcua-suite/.planning/ROADMAP.md
@/home/la/private/node-red-contrib-opcua-suite/.planning/phases/01-pre-work/01-SPEC.md

<interfaces>
<!-- Current inline cert code being extracted. Source: nodes/opcua-endpoint.js:7-62. -->

Existing logic to move verbatim into lib/cert-store.js:

```js
// cert directory creation (line 14-17)
const certsDir = path.join((RED.settings && RED.settings.userDir) || '/data', 'opcua-certs');
if (!fs.existsSync(certsDir)) {
    try { fs.mkdirSync(certsDir, { recursive: true }); } catch (e) { /* ignore in test */ }
}

// filename sanitisation (lines 30, 51 — same regex both places)
(data.filename || 'cert.pem').replace(/[^a-zA-Z0-9._\-]/g, '_')

// POST upload-cert (lines 23-38): reads data.content (base64), writes to certsDir
// GET  certs       (lines 40-46): readdirSync + extension filter
// DELETE upload-cert/:filename (lines 49-62): unlink or 404
```

Locked exported API shape (D-06):
```js
module.exports = {
  sanitiseFilename,        // (string) => string
  getCertsDir,             // (RED) => string  (creates dir if absent)
  listCerts,               // (certsDir) => Promise<string[]>
  uploadCert,              // (certsDir, filename, base64Content) => Promise<{path, bytes}>
  deleteCert,              // (certsDir, filename) => Promise<void>
  registerCertRoutes,      // (RED, prefix, certsDir) => void
};
```

Locked route table (D-08):
```
POST   <prefix>/upload-cert        body: { filename, content (base64) }
GET    <prefix>/certs
DELETE <prefix>/upload-cert/:name
```

Locked error shapes (D-09):
- 400 — missing fields, invalid filename
- 404 — file not found (delete only)
- 500 — filesystem error
All error bodies: { error: <string> }

Locked extension whitelist for listCerts (D-07):
  /\.(pem|der|crt|key|pfx|p12)$/i  (uploads accept any extension)

Locked conditional guard (per CONTEXT.md established patterns):
  registerCertRoutes must check `if (!RED.httpAdmin) return;` at the top (same pattern as nodes/opcua-endpoint.js:19)

Locked HTML constant (D-11):
  const CERT_ROUTE_PREFIX = '/opcua-endpoint';   // near top of <script> block
  All $.ajax url fields become: CERT_ROUTE_PREFIX + '/upload-cert' etc.
  (No slash before CERT_ROUTE_PREFIX — Node-RED httpAdmin routes are relative, matching current 'opcua-endpoint/upload-cert' pattern)

Existing cert list response shape from nodes/opcua-endpoint.js:43:
  files.map(f => ({ name: f, path: path.join(certsDir, f) }))
  — preserve this shape exactly so editor-side code that parses it continues to work.

Reuse from lib/opcua-utils.js (per CONTEXT.md reusable assets):
  const { createError } = require('./opcua-utils');  // for error construction in HTTP handlers
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create lib/cert-store.js and test/cert-store.test.js</name>
  <files>lib/cert-store.js, test/cert-store.test.js</files>
  <behavior>
    - sanitiseFilename('my cert.pem') === 'my_cert.pem'
    - sanitiseFilename('../../evil') === '.._..evil'  (path traversal chars replaced)
    - getCertsDir(RED) returns path ending in 'opcua-certs'; creates the dir if absent
    - uploadCert(dir, 'test.pem', base64str) writes the file and returns { path, bytes }
    - uploadCert rejects with a 400-style error if base64Content is falsy
    - listCerts(dir) resolves to array of filenames with allowed extensions only (*.txt excluded)
    - deleteCert(dir, 'test.pem') removes the file; deleteCert on a non-existent file rejects with a 404-style error
    - registerCertRoutes(stubRED, '/test-prefix', tmpDir) calls stubRED.httpAdmin.post, .get, and .delete exactly once each
    - POST /test-prefix/upload-cert with { filename: 'a.pem', content: base64 } writes file to tmpDir
    - GET /test-prefix/certs returns array of objects with name/path fields
    - DELETE /test-prefix/upload-cert/:filename removes the file; returns 404 when file absent
    - Missing 'content' field in POST body returns 400
    - registerCertRoutes returns immediately (no route registration) when RED.httpAdmin is falsy
  </behavior>
  <action>
    Write test/cert-store.test.js first (RED phase), then implement lib/cert-store.js (GREEN phase).

    Test file structure:
    - "use strict"; Chai expect; sinon; fs; os; path. 2-space indent, double quotes.
    - Use os.tmpdir() + '/cert-store-test' as tmpDir. Create in before(), remove in after().
    - afterEach: clean tmpDir contents but keep the dir.
    - For HTTP handler tests: create a mock RED with sinon:
      ```js
      function makeMockRED(tmpDir) {
        const routes = {};
        const httpAdmin = {
          post:   (path, fn) => { routes["POST " + path] = fn; },
          get:    (path, fn) => { routes["GET "  + path] = fn; },
          delete: (path, fn) => { routes["DEL "  + path] = fn; },
        };
        const settings = { userDir: require("os").tmpdir() };
        return { httpAdmin, routes, settings };
      }
      ```
    - For simulating req/res: use sinon stubs for res.json, res.status (chained: res.status.returns({ json: sinon.stub() })).
    - Section dividers: // ─── sanitiseFilename ─── // ─── getCertsDir ─── // ─── uploadCert ─── etc.

    Implementation lib/cert-store.js:
    - File-level JSDoc banner summarising purpose.
    - 2-space indent, double quotes, semicolons, trailing commas (match lib/ convention).
    - Imports: fs, path (built-ins only — no new runtime deps, per phase constraint).
    - Do NOT import opcua-utils; keep cert-store.js dependency-free for reuse by future non-OPC nodes.
    - All async functions use async/await.
    - getCertsDir(RED): reads RED.settings.userDir or falls back to '/data'; appends 'opcua-certs'; calls fs.mkdirSync({ recursive: true }) guarded by try/catch (existing pattern).
    - listCerts(certsDir): fs.readdirSync filtered by extension whitelist from D-07. Returns Promise (wrap sync call in async function).
    - uploadCert(certsDir, filename, base64Content): validate base64Content present; sanitise filename; write Buffer.from(base64Content, 'base64'); return { path: destPath, bytes: buf.length }.
    - deleteCert(certsDir, filename): sanitise filename; check fs.existsSync; unlink; throw { status: 404 } if not found.
    - registerCertRoutes(RED, prefix, certsDir): guard `if (!RED || !RED.httpAdmin) return;`; register three routes using uploadCert/listCerts/deleteCert; handle errors per D-09 error shape. Response success shape must match the existing nodes/opcua-endpoint.js shape exactly (see interfaces above) so existing editor JS continues to work.

    Run npm test after implementation.
  </action>
  <verify>
    <automated>cd /home/la/private/node-red-contrib-opcua-suite && npm test 2>&1 | tail -20</automated>
  </verify>
  <done>npm test passes; lib/cert-store.js exports all six functions; test/cert-store.test.js has ≥12 passing assertions covering all six functions and the guard behaviour.</done>
</task>

<task type="auto">
  <name>Task 2: Refactor nodes/opcua-endpoint.js and nodes/opcua-endpoint.html to consume lib/cert-store.js</name>
  <files>nodes/opcua-endpoint.js, nodes/opcua-endpoint.html</files>
  <action>
    In nodes/opcua-endpoint.js:
    1. Add require at the top: `const { registerCertRoutes, getCertsDir } = require('../lib/cert-store');`
    2. Delete the entire inline cert block (lines 13-64: the certsDir construction, mkdirSync, and all three RED.httpAdmin.post/get/delete registrations + the surrounding if/else).
    3. Replace with a single call, placed before the OpcUaEndpointNode function definition (same lifecycle — module load):
       ```js
       registerCertRoutes(RED, '/opcua-endpoint', getCertsDir(RED));
       ```
    4. Preserve the existing `const fs = require('fs');` and `const path = require('path');` imports only if they are still used elsewhere in the file (check before removing — they are used for cert file existence checks in getSharedManager). If used elsewhere, keep them; do not add them to cert-store.js.
    5. Verify no other references to the deleted inline logic remain. Run npm test.

    In nodes/opcua-endpoint.html (editor-side `<script>` block):
    1. Add near the top of the `<script>` block (before the RED.nodes.registerType call), as the first statement inside the script:
       ```js
       var CERT_ROUTE_PREFIX = 'opcua-endpoint';
       ```
       (Note: no leading slash — matches the existing $.ajax url: 'opcua-endpoint/upload-cert' pattern in line 117. This keeps the behaviour identical while naming the prefix explicitly.)
    2. Find every hard-coded 'opcua-endpoint/upload-cert' or 'opcua-endpoint/certs' string in the $.ajax / fetch calls within setupCertUpload and replace with the CERT_ROUTE_PREFIX variable:
       - url: 'opcua-endpoint/upload-cert'  →  url: CERT_ROUTE_PREFIX + '/upload-cert'
       - Any corresponding GET or DELETE paths if present.
    3. Verify the HTML file has exactly one occurrence of the literal string 'opcua-endpoint/upload-cert' (zero — it should now use CERT_ROUTE_PREFIX). Use grep to confirm:
       `grep -c "opcua-endpoint/upload-cert" nodes/opcua-endpoint.html`
       Expected: 0

    Run npm test after both file edits. The cert-store.test.js route-registration tests now also verify the real behaviour path indirectly.

    Commit message: `refactor(DEBT-02): extract cert routes to lib/cert-store.js; parameterise HTML prefix`
  </action>
  <verify>
    <automated>cd /home/la/private/node-red-contrib-opcua-suite && grep -c "RED.httpAdmin.post\|RED.httpAdmin.get\|RED.httpAdmin.delete" nodes/opcua-endpoint.js && echo "FAIL: inline routes still present" || true; grep -n "registerCertRoutes(" nodes/opcua-endpoint.js; grep -n "CERT_ROUTE_PREFIX" nodes/opcua-endpoint.html; npm test 2>&1 | tail -20</automated>
  </verify>
  <done>grep for RED.httpAdmin.post/get/delete in nodes/opcua-endpoint.js returns zero hits; grep for registerCertRoutes( returns exactly one hit; grep for CERT_ROUTE_PREFIX in opcua-endpoint.html returns ≥1 hit; no hard-coded 'opcua-endpoint/upload-cert' literals remain in HTML; npm test passes.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Browser (Node-RED editor) → RED.httpAdmin routes | Cert upload/list/delete endpoints accept user-controlled filename and base64 content. |
| cert-store.js → filesystem | Writes decoded base64 bytes to certsDir; only filename sanitisation is the guard against path traversal. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-01 | Tampering | sanitiseFilename regex | mitigate | Verbatim copy of existing production regex — no regression. Test asserts path-traversal characters are replaced. |
| T-02-02 | Denial of Service | uploadCert: no size limit | accept | Existing behaviour — no size limit today. CONCERNS.md §Security notes this; adding a size cap is a future hardening task outside DEBT-02 scope. |
| T-02-03 | Information Disclosure | listCerts returns full path in response body | accept | Existing behaviour (same { name, path } shape preserved). Path is within userDir, accessible to Node-RED admin only. |
| T-02-04 | Spoofing | registerCertRoutes prefix parameter | accept | prefix is always hardcoded at call sites (never user-supplied); misuse requires intentional code change. |
</threat_model>

<verification>
After all tasks in this plan are committed:

```bash
cd /home/la/private/node-red-contrib-opcua-suite

# AC-5: lib/cert-store.js exports all six functions
node -e "const cs = require('./lib/cert-store'); console.log(Object.keys(cs).join(', '))"
# Expected: sanitiseFilename, getCertsDir, listCerts, uploadCert, deleteCert, registerCertRoutes

# AC-6: opcua-endpoint.js no longer has inline routes
grep -n "RED.httpAdmin.post\|RED.httpAdmin.get\|RED.httpAdmin.delete" nodes/opcua-endpoint.js
# Expected: zero output

grep -n "registerCertRoutes(" nodes/opcua-endpoint.js
# Expected: one hit

# AC-7: HTML prefix variable
grep -n "CERT_ROUTE_PREFIX" nodes/opcua-endpoint.html
# Expected: ≥2 hits (declaration + usage)

grep -c "opcua-endpoint/upload-cert" nodes/opcua-endpoint.html
# Expected: 0

# AC-8: unit test passes
npm test
```
</verification>

<success_criteria>
- `lib/cert-store.js` exists and exports exactly: sanitiseFilename, getCertsDir, listCerts, uploadCert, deleteCert, registerCertRoutes.
- `nodes/opcua-endpoint.js` has zero `RED.httpAdmin.post/get/delete` calls; has exactly one `registerCertRoutes(` call.
- `nodes/opcua-endpoint.html` has `CERT_ROUTE_PREFIX` declared and zero hard-coded `'opcua-endpoint/upload-cert'` literals.
- `test/cert-store.test.js` has ≥12 passing assertions.
- `npm test` passes (no regressions in nodes-registration.test.js or connection-sharing.test.js).
- No changes to `package.json` dependencies.
- Commits produced: ≥3 (cert-store.js + tests, opcua-endpoint.js refactor, opcua-endpoint.html parameterise).
</success_criteria>

<output>
After completion, create `.planning/phases/01-pre-work/01-02-SUMMARY.md` using the template at `@$HOME/.claude/get-shit-done/templates/summary.md`.
</output>
