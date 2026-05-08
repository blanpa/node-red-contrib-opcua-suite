---
phase: 01-pre-work
plan: 03
type: execute
wave: 1
depends_on: []
files_modified:
  - docs/MSG-SCHEMA.md
  - README.md
autonomous: true
requirements:
  - DEBT-03

must_haves:
  truths:
    - "docs/MSG-SCHEMA.md exists at repo root with one table per node covering all msg.* fields found by grep"
    - "The document has a 'v1.0 Stable Fields' / stability statement section"
    - "The document has a 'Added in v0.1.0 (PubSub)' section listing all seven reserved field names"
    - "README.md contains a link to docs/MSG-SCHEMA.md"
    - "No code files are modified"
  artifacts:
    - path: "docs/MSG-SCHEMA.md"
      provides: "Authoritative msg.* field reference for all eight nodes; v1.0 stability statement; PubSub reserved fields"
      contains: "Added in v0.1.0 (PubSub)"
    - path: "README.md"
      provides: "Single reference link to MSG-SCHEMA.md"
      contains: "docs/MSG-SCHEMA.md"
  key_links:
    - from: "README.md"
      to: "docs/MSG-SCHEMA.md"
      via: "Markdown link"
      pattern: "docs/MSG-SCHEMA\\.md"
---

<objective>
Author docs/MSG-SCHEMA.md — a single authoritative table of every msg.* field the existing eight nodes accept or emit — and add a one-line link to it from README.md.

Purpose: DEBT-03 — freezes the v1.0 msg.* contract so PubSub field names cannot collide silently with existing nodes; eliminates the need for contributors to grep source files to understand the message API.
Output: docs/MSG-SCHEMA.md (new file, documentation only); one-line README.md update. Zero code changes.
</objective>

<execution_context>
@/home/la/private/node-red-contrib-opcua-suite/.planning/phases/01-pre-work/01-CONTEXT.md
</execution_context>

<context>
@/home/la/private/node-red-contrib-opcua-suite/.planning/PROJECT.md
@/home/la/private/node-red-contrib-opcua-suite/.planning/ROADMAP.md
@/home/la/private/node-red-contrib-opcua-suite/.planning/phases/01-pre-work/01-SPEC.md

<interfaces>
<!-- Complete msg.* field inventory found by:
     grep -rhnE "msg\.[a-zA-Z_]+" nodes/*.js lib/*.js | grep -oE "msg\.[a-zA-Z_]+" | sort -u
     Result (43 distinct field references): -->

msg.action          msg.attributeId    msg.browsePath
msg.browseResult    msg.command        msg.count
msg.dataTypeNodeId  msg.datatype       msg.endTime
msg.endpointUrl     msg.error          msg.eventType
msg.folderName      msg.func           msg.initialValue
msg.inputArguments  msg.interval       msg.itemName
msg.items           msg.maxValues      msg.message
msg.methodName      msg.methodNodeId   msg.methodResult
msg.nodeId          msg.objectName     msg.objectNodeId
msg.operation       msg.outputArguments msg.parentNodeId
msg.payload         msg.queueSize      msg.recursive
msg.recursiveResult msg.severity       msg.sourceNodeId
msg.startNodeId     msg.startTime      msg.statusCode
msg.topic           msg.variableName   msg.serverTimestamp
msg.sourceTimestamp

<!-- Confirmed SPEC.md acceptance criterion: every field from this grep list must appear
     in the document tables. Fields msg.serverTimestamp and msg.sourceTimestamp are in
     SPEC.md but not surfaced by the grep (they are in lib/ — confirm with:
     grep -n "serverTimestamp\|sourceTimestamp" lib/opcua-client-manager.js ) -->

<!-- Locked document structure (D-12): one section per node — 8 sections:
     1. opcua-endpoint (config) — no runtime msg fields; document HTTP-admin routes only if relevant, else skip
     2. opcua-client
     3. opcua-server
     4. opcua-item
     5. opcua-event
     6. opcua-method
     7. opcua-browser
     8. opcua-browse-client

     Each section table columns (D-12):
     | Field | Direction | Type | Required | Description | Source |
     Direction values: in | out | both
     Source: nodes/<file>:<line> for the canonical read/write site
-->

<!-- Locked trailing section (D-13): "## Reserved for v0.1.0 (PubSub)" -->

<!-- Locked stability statement (D-14): top-level "v1.0 Stability Statement" -->

<!-- Locked README insertion point (D-15):
     Under "## Reference" (line 182 of current README.md), add one line before the
     first sub-heading "### NodeId Formats":
       See [docs/MSG-SCHEMA.md](docs/MSG-SCHEMA.md) for the full message field reference.
-->

<!-- Node-by-node field breakdown derived from source reading:

opcua-client (nodes/opcua-client.js):
  IN:  msg.operation, msg.topic, msg.nodeId, msg.payload, msg.datatype, msg.dataTypeNodeId,
       msg.items, msg.inputArguments, msg.startTime, msg.endTime, msg.maxValues,
       msg.browsePath, msg.recursive, msg.objectNodeId, msg.methodNodeId, msg.attributeId,
       msg.queueSize, msg.interval
  OUT: msg.payload, msg.statusCode, msg.sourceTimestamp, msg.serverTimestamp, msg.nodeId,
       msg.error, msg.count, msg.browseResult, msg.recursiveResult, msg.outputArguments,
       msg.methodResult, msg.items (writemultiple: results back on items)

opcua-server (nodes/opcua-server.js):
  IN:  msg.command, msg.folderName, msg.variableName, msg.datatype, msg.initialValue,
       msg.objectName, msg.objectNodeId, msg.parentNodeId, msg.methodName, msg.func,
       msg.nodeId, msg.payload (setValue), msg.startNodeId, msg.itemName
  OUT: msg.payload (getServerInfo), msg.error

opcua-item (nodes/opcua-item.js):
  IN:  msg.items (existing array, appended to)
  OUT: msg.items (with new item appended), msg.topic (legacy mode), msg.datatype (legacy mode)

opcua-event (nodes/opcua-event.js):
  IN:  msg.action (subscribe/unsubscribe), msg.sourceNodeId, msg.eventType, msg.interval
  OUT: msg.payload (event field map), msg.topic (source NodeId), msg.operation ('event'),
       msg.error

opcua-method (nodes/opcua-method.js):
  IN:  msg.objectNodeId, msg.methodNodeId, msg.inputArguments (or msg.payload as fallback)
  OUT: msg.payload (output argument values), msg.statusCode, msg.methodResult, msg.error

opcua-browser (nodes/opcua-browser.js):
  IN:  msg.topic, msg.nodeId, msg.recursive, msg.startNodeId
  OUT: msg.payload (browse references array), msg.recursiveResult (if recursive), msg.error

opcua-browse-client (nodes/opcua-browse-client.js):
  IN:  msg.nodeId, msg.operation, msg.interval, msg.queueSize
  OUT: msg.payload, msg.nodeId, msg.statusCode, msg.sourceTimestamp, msg.serverTimestamp,
       msg.error

opcua-endpoint (config node — nodes/opcua-endpoint.js):
  No runtime msg fields. Config-node only; drives connection settings not message fields.
  → Section notes: "This is a configuration node. It does not process msg objects at runtime."
-->
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create docs/ directory and author docs/MSG-SCHEMA.md</name>
  <files>docs/MSG-SCHEMA.md</files>
  <action>
    Create the docs/ directory and the file docs/MSG-SCHEMA.md. This is a documentation-only task — no code changes.

    Document structure (follow D-12, D-13, D-14 exactly):

    ```
    # OPC UA Suite — Message Schema Reference

    **Version:** v1.0 (2026-05-08)
    **Scope:** Existing eight nodes (v0.0.7 and later)

    ## v1.0 Stability Statement
    [D-14 text: the fields in this document are the v1.0 contract; field renames in v0.x are possible but called out in CHANGELOG]

    ## Nodes

    ### opcua-endpoint (config)
    [note: config node, no runtime msg fields]

    ### opcua-client
    [table with all in/out fields]

    ### opcua-server
    [table]

    ### opcua-item
    [table]

    ### opcua-event
    [table]

    ### opcua-method
    [table]

    ### opcua-browser
    [table]

    ### opcua-browse-client
    [table]

    ## Reserved for v0.1.0 (PubSub)
    [D-13 table: the seven reserved field names with type and description]
    ```

    For each node section, write a Markdown table with columns:
    | Field | Direction | Type | Required | Description | Source |

    Key field details to include accurately (derived from source reading in interfaces above):

    **opcua-client key fields:**
    - msg.operation (in) String optional — dispatch key: "read", "readmultiple", "write", "writemultiple", "subscribe", "unsubscribe", "browse", "method", "history", "getendpoints", "registernodes", "translatebrowsepath". Default from node config. Source: nodes/opcua-client.js
    - msg.topic / msg.nodeId (in) String optional — target NodeId; msg.topic is the legacy name, msg.nodeId is preferred. Both accepted.
    - msg.payload (both) any — input value for write; output value/result for read/subscribe/browse/method/history.
    - msg.items (in) Array optional — batch array from opcua-item collector; triggers batch mode automatically.
    - msg.statusCode (out) String — OPC UA status code string e.g. "Good (0x00000000)".
    - msg.sourceTimestamp / msg.serverTimestamp (out) Date — from DataValue on read/subscribe.
    - msg.error (out) Object — { message, error, stack } on error paths. Shape from lib/opcua-utils.js createError().

    **opcua-server key fields:**
    - msg.command (in) String required — address-space command: "addFolder", "addVariable", "addObject", "addMethod", "setValue", "setWritable", "deleteNode", "getServerInfo", "raiseEvent".
    - msg.func (in) String conditional — JavaScript function body string for addMethod (DANGER: eval'd via new Function).

    **opcua-item key fields:**
    - msg.items (both) Array — collector mode: appended to and passed on. Legacy mode: not used.
    - msg.topic (out) String — legacy mode only: NodeId of first item.

    **opcua-event key fields:**
    - msg.action (in) String optional — "subscribe" (default) or "unsubscribe". Also accepts msg.operation.
    - msg.payload (out) Object — event field map: { eventId, eventType, sourceNode, sourceName, time, receiveTime, message, severity }.

    **opcua-method key fields:**
    - msg.inputArguments (in) Array optional — preferred field for method input args. Falls back to msg.payload if absent.
    - msg.outputArguments (out) Array — raw output argument Variant array.
    - msg.methodResult (out) Object — full method call result object from node-opcua.

    For source file:line references, provide the actual file paths (e.g. "nodes/opcua-client.js:212", "lib/opcua-client-manager.js:366"). Use approximate line numbers where exact values are known from reading the source; note "approx." for estimates.

    For the Reserved section, use exactly the table from D-13:
    | Field | Direction | Type | Description |
    |---|---|---|---|
    | msg.dataSet | out | Object | Subscriber: decoded DataSetMessage field map |
    | msg.publisherId | in/out | String\|UInt | Pub: target publisher / Sub: source publisher |
    | msg.writerGroupId | in/out | UInt16 | WriterGroup identifier |
    | msg.dataSetWriterId | in/out | UInt16 | DataSetWriter identifier |
    | msg.sequenceNumber | out | UInt32 | Subscriber: per-DataSetReader sequence |
    | msg.encoding | out | String | 'uadp' \| 'json' |
    | msg.transport | out | String | 'udp' \| 'mqtt' \| 'amqp' |

    After writing the file, run the acceptance grep to verify coverage:
    ```bash
    grep -rhnE "msg\.[a-zA-Z_]+" nodes/*.js lib/*.js | grep -oE "msg\.[a-zA-Z_]+" | sort -u
    ```
    For each field in the output, confirm it appears somewhere in docs/MSG-SCHEMA.md. Fields that are purely internal local variables (e.g. `msg.message` inside an event payload assembly — already documented as part of the event payload object description, not a top-level msg field) should be noted in a "Notes" subsection of the relevant node section.

    Commit message: `docs(DEBT-03): add docs/MSG-SCHEMA.md — v1.0 msg.* field reference`
  </action>
  <verify>
    <automated>cd /home/la/private/node-red-contrib-opcua-suite && test -f docs/MSG-SCHEMA.md && echo "FILE EXISTS" || echo "MISSING"; grep -c "Added in v0.1.0 (PubSub)" docs/MSG-SCHEMA.md; grep -c "v1.0 Stab" docs/MSG-SCHEMA.md</automated>
  </verify>
  <done>docs/MSG-SCHEMA.md exists; contains "Added in v0.1.0 (PubSub)" section with all seven reserved fields; contains a v1.0 stability statement; has one table per node (8 sections); every distinct msg.* field from the grep scan appears at least once in the document.</done>
</task>

<task type="auto">
  <name>Task 2: Add MSG-SCHEMA.md link to README.md</name>
  <files>README.md</files>
  <action>
    Edit README.md to add a single line referencing docs/MSG-SCHEMA.md, per D-15.

    Insertion point: under the `## Reference` heading (currently at line 182), before the first sub-heading `### NodeId Formats`. Insert:

    ```
    See [docs/MSG-SCHEMA.md](docs/MSG-SCHEMA.md) for the full message field reference.
    ```

    Add a blank line before `### NodeId Formats` if one is not already present, so the paragraph renders properly.

    No other README changes in this plan (D-15 is explicit: no further README changes this phase).

    Verify the link renders by checking the Markdown syntax is correct (opening `[` closed with `]`, `(` closed with `)`).

    Commit message: `docs(DEBT-03): link MSG-SCHEMA.md from README Reference section`
  </action>
  <verify>
    <automated>cd /home/la/private/node-red-contrib-opcua-suite && grep -n "docs/MSG-SCHEMA.md" README.md</automated>
  </verify>
  <done>grep finds exactly one occurrence of "docs/MSG-SCHEMA.md" in README.md; the line is a valid Markdown link; no other README content changed.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| docs/MSG-SCHEMA.md → readers | Documentation-only; no code paths. No trust boundary changes in this plan. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-01 | Information Disclosure | msg.func (opcua-server addMethod) | accept | Document the danger (eval risk) in the MSG-SCHEMA.md opcua-server section with a DANGER note. This is an existing code behaviour; DEBT-03 is documentation-only. |
</threat_model>

<verification>
After all tasks in this plan are committed:

```bash
cd /home/la/private/node-red-contrib-opcua-suite

# AC-9: docs/MSG-SCHEMA.md exists
test -f docs/MSG-SCHEMA.md && echo "OK" || echo "MISSING"

# AC-10: all grep-found msg.* fields appear in the document
# Run this and manually scan that each field is present:
grep -rhnE "msg\.[a-zA-Z_]+" nodes/*.js lib/*.js | grep -oE "msg\.[a-zA-Z_]+" | sort -u

grep "msg\." docs/MSG-SCHEMA.md | grep -oE "msg\.[a-zA-Z_]+" | sort -u

# AC-11: stability statement present
grep -c "v1.0 Stab" docs/MSG-SCHEMA.md
# Expected: ≥1

# AC-12: PubSub reserved section with all seven fields
grep "Added in v0.1.0 (PubSub)" docs/MSG-SCHEMA.md
grep "dataSet\|publisherId\|writerGroupId\|dataSetWriterId\|sequenceNumber\|encoding\|transport" docs/MSG-SCHEMA.md | wc -l
# Expected: 7 matches

# AC-13: README link
grep "docs/MSG-SCHEMA.md" README.md
# Expected: one hit

# No code changes — npm test should still pass from Plans 01 and 02
npm test
```
</verification>

<success_criteria>
- `docs/MSG-SCHEMA.md` exists with one section per node (8 total).
- Every distinct `msg.*` field from `grep -rhnE "msg\.[a-zA-Z_]+" nodes/*.js lib/*.js` appears at least once in the document tables.
- Document contains "v1.0 Stability Statement" section.
- Document contains "Added in v0.1.0 (PubSub)" section with all seven reserved field names: msg.dataSet, msg.publisherId, msg.writerGroupId, msg.dataSetWriterId, msg.sequenceNumber, msg.encoding, msg.transport.
- `README.md` contains exactly one new Markdown link to `docs/MSG-SCHEMA.md`.
- Zero code file changes (nodes/*.js, lib/*.js, test/*.js untouched by this plan).
- Commits produced: 2 (one for docs/MSG-SCHEMA.md, one for README.md).
</success_criteria>

<output>
After completion, create `.planning/phases/01-pre-work/01-03-SUMMARY.md` using the template at `@$HOME/.claude/get-shit-done/templates/summary.md`.
</output>
