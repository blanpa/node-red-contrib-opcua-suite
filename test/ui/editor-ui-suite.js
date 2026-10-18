/*
 * UI test suite for the edit dialogs of node-red-contrib-opcua-suite.
 *
 * Runs inside a live Node-RED editor (see test/ui/run-ui-tests.js) that has
 * the function test flow (examples/15) deployed. It drives every dialog
 * through DOM events, then checks the stored node properties, re-opening,
 * validation, layout and JavaScript errors. Nothing is deployed; all changes
 * stay in the browser session.
 *
 * Defines window.OpcUaUiSuite.run() -> Promise<[{ name, ok, error, ms }]>.
 */
(function () {
  "use strict";

  var TAB = "uit-tab";
  var seq = 0;
  var tests = [];
  var jsErrors = [];

  window.addEventListener("error", function (e) {
    jsErrors.push(String(e.message || e));
  });
  var origConsoleError = console.error;
  console.error = function () {
    var text = Array.prototype.map.call(arguments, String).join(" ");
    if (/opcua|OpcUa/i.test(text)) jsErrors.push(text);
    return origConsoleError.apply(console, arguments);
  };

  function test(name, fn) {
    tests.push({ name: name, fn: fn });
  }

  // --- helpers -------------------------------------------------------------

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  async function until(fn, label, ms) {
    var end = Date.now() + (ms || 8000);
    var last;
    while (Date.now() < end) {
      try {
        var v = fn();
        if (v) return v;
      } catch (e) {
        last = e;
      }
      await sleep(50);
    }
    throw new Error(
      "timeout waiting for " +
        (label || "condition") +
        (last ? " (" + last.message + ")" : ""),
    );
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  // JSON with sorted object keys, so key order does not matter.
  function canon(v) {
    return JSON.stringify(v, function (k, val) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.keys(val)
          .sort()
          .reduce(function (o, key) {
            o[key] = val[key];
            return o;
          }, {});
      }
      return val;
    });
  }

  function eq(got, want, what) {
    var g = canon(got);
    var w = canon(want);
    if (g !== w) throw new Error(what + ": expected " + w + ", got " + g);
  }

  function isConfig(type) {
    return RED.nodes.getType(type).category === "config";
  }

  function clone(v) {
    return v === undefined ? "" : JSON.parse(JSON.stringify(v));
  }

  function ensureTab() {
    if (!RED.nodes.workspace(TAB)) {
      RED.view.importNodes([{ id: TAB, type: "tab", label: "UI tests" }], {
        generateIds: false,
        addFlow: false,
      });
    }
    RED.workspaces.show(TAB);
  }

  /** Creates a node the way the palette does: every default, then props. */
  function newNode(type, props) {
    ensureTab();
    var def = RED.nodes.getType(type);
    var id = "uit-" + type.replace(/[^a-z]/g, "") + "-" + ++seq;
    var n = { id: id, type: type };
    Object.keys(def.defaults).forEach(function (k) {
      n[k] = clone(def.defaults[k].value);
    });
    Object.assign(n, props || {});
    if (!isConfig(type)) {
      n.z = TAB;
      n.x = 200 + (seq % 5) * 150;
      n.y = 60 + (seq % 12) * 40;
      n.wires = Array.from({ length: def.outputs || 0 }, function () {
        return [];
      });
    }
    RED.view.importNodes([n], { generateIds: false, addFlow: false });
    var node = RED.nodes.node(id);
    assert(node, "could not create " + type);
    return node;
  }

  function okButton(type) {
    return isConfig(type) ? $("#node-config-dialog-ok") : $("#node-dialog-ok");
  }

  async function open(node) {
    var before = jsErrors.length;
    if (isConfig(node.type)) RED.editor.editConfig("", node.type, node.id);
    else RED.editor.edit(node);
    await until(function () {
      return (
        okButton(node.type).is(":visible") && $(".opcua-form:visible").length
      );
    }, "dialog of " + node.type);
    await sleep(250);
    assert(
      jsErrors.length === before,
      "JavaScript error while opening: " + jsErrors.slice(before).join(" | "),
    );
    return form();
  }

  function form() {
    return $(".opcua-form:visible").last();
  }

  async function save(node) {
    var before = jsErrors.length;
    okButton(node.type).trigger("click");
    await until(function () {
      return !$(".opcua-form:visible").length;
    }, "dialog to close");
    await sleep(150);
    assert(
      jsErrors.length === before,
      "JavaScript error while saving: " + jsErrors.slice(before).join(" | "),
    );
  }

  async function cancel() {
    $("#node-dialog-cancel:visible, #node-config-dialog-cancel:visible")
      .last()
      .trigger("click");
    await until(function () {
      return !$(".opcua-form:visible").length;
    }, "dialog to close");
    await sleep(100);
  }

  function setVal(sel, v) {
    var $e = $(sel);
    assert($e.length, "missing field " + sel);
    $e.val(v).trigger("input").trigger("change");
  }

  function setCheck(sel, on) {
    var $e = $(sel);
    assert($e.length, "missing checkbox " + sel);
    if ($e.is(":checked") !== on) $e.trigger("click");
    assert($e.is(":checked") === on, "checkbox " + sel + " did not toggle");
  }

  function visible(sel) {
    return $(sel).is(":visible");
  }

  /** Layout rules every dialog must meet at the default tray width. */
  function checkLayout(type) {
    var problems = [];
    var $f = form();
    var body = $f.closest(".red-ui-tray-body")[0] || $f[0];
    if (body.scrollWidth > body.clientWidth + 1) {
      problems.push(
        "horizontal overflow " + body.scrollWidth + ">" + body.clientWidth,
      );
    }
    $f.find(".form-row > label:visible").each(function () {
      var text = this.textContent.trim();
      if (this.scrollWidth > this.clientWidth + 1)
        problems.push("label cut off: " + text);
      if (this.getBoundingClientRect().height > 34)
        problems.push("label wraps: " + text);
    });
    $f.find(".form-row:visible")
      .children("input:visible, select:visible, div:visible")
      .each(function () {
        if (this.getBoundingClientRect().width < 60) {
          problems.push(
            "field too narrow: " + (this.id || this.className || this.tagName),
          );
        }
      });
    if ($f.find("input.cert-file-input:visible").length)
      problems.push("native file input visible");
    assert(!problems.length, type + " layout: " + problems.join("; "));
  }

  async function toggleSection(id) {
    var $sec = $("#" + id);
    assert($sec.length, "missing section " + id);
    var was = $sec.hasClass("opcua-collapsed");
    $sec.children(".opcua-section-header").trigger("click");
    await sleep(50);
    assert(
      $sec.hasClass("opcua-collapsed") !== was,
      "section " + id + " did not toggle",
    );
    assert(
      visible("#" + id + " > .opcua-section-body") === was,
      "section body of " + id + " visibility wrong",
    );
  }

  // --- NodeId picker helpers --------------------------------------------------

  function pickerRow(name) {
    return $(".opcua-picker-row")
      .filter(function () {
        return $(this).find(".opcua-picker-name").text() === name;
      })
      .first();
  }

  async function pickerExpand(name) {
    var $row = await until(function () {
      var r = pickerRow(name);
      return r.length && r;
    }, "picker row " + name);
    $row.find(".opcua-picker-toggle").trigger("click");
  }

  async function pickerChoose(path, endpointId) {
    await until(function () {
      return $(".opcua-picker:visible").length;
    }, "picker tray");
    if (endpointId) {
      var $sel = $(".opcua-picker-bar select");
      if ($sel.val() !== endpointId) $sel.val(endpointId).trigger("change");
    }
    for (var i = 0; i < path.length - 1; i++) await pickerExpand(path[i]);
    var last = path[path.length - 1];
    var $row = await until(function () {
      var r = pickerRow(last);
      return r.length && r;
    }, "picker row " + last);
    return $row;
  }

  async function pickerConfirm() {
    $("#opcua-picker-ok").trigger("click");
    await until(function () {
      return !$(".opcua-picker:visible").length;
    }, "picker to close");
    await sleep(100);
  }

  // =========================================================================
  // Every node type
  // =========================================================================

  var TYPES = [
    "opcua-endpoint",
    "opcua-client",
    "opcua-item",
    "opcua-browser",
    "opcua-browse-client",
    "opcua-method",
    "opcua-event",
    "opcua-server",
    "opcua-pubsub-connection",
    "opcua-publisher",
    "opcua-subscriber",
  ];

  TYPES.forEach(function (type) {
    test(
      type + ": new node opens cleanly, uses the shared layout and saves",
      async function () {
        var n = newNode(type);
        var $f = await open(n);
        assert($f.hasClass("opcua-form"), "no .opcua-form");
        checkLayout(type);
        $f.find(".opcua-section:not(.opcua-static)").each(function () {
          assert(
            $(this).find("> .opcua-section-header .opcua-chevron").length === 1,
            "section without chevron: " + this.id,
          );
        });
        await save(n);
      },
    );

    test(type + ": cancel discards changes", async function () {
      var n = newNode(type, { name: "keep-me" });
      await open(n);
      setVal(
        isConfig(type) ? "#node-config-input-name" : "#node-input-name",
        "changed",
      );
      await cancel();
      eq(n.name, "keep-me", "name after cancel");
    });
  });

  // =========================================================================
  // opcua-client
  // =========================================================================

  test("client: defaults of a new node", async function () {
    var n = newNode("opcua-client");
    await open(n);
    eq($("#node-input-defaultOperation option").length, 14, "operation count");
    eq($("#node-input-defaultOperation").val(), "read", "operation");
    eq($("#node-input-autoConnect").is(":checked"), true, "connect on deploy");
    eq($("#node-input-verboseLog").is(":checked"), true, "verbose log");
    eq($("#node-input-unwrapSingle").is(":checked"), false, "unwrap");
    assert(
      $("#opcua-client-retry").hasClass("opcua-collapsed"),
      "retry section should start collapsed",
    );
    assert(
      !visible("#opcua-client-legacy"),
      "legacy note must be hidden for a new node",
    );
    assert(
      $("#node-input-endpoint option[value='ft-ep']").length,
      "endpoint ft-ep not offered",
    );
    setVal("#node-input-endpoint", "ft-ep");
    await save(n);
    eq(n.endpoint, "ft-ep", "endpoint");
    eq(n.valid, true, "valid");
  });

  test("client: every operation can be chosen and is stored", async function () {
    var n = newNode("opcua-client", { endpoint: "ft-ep" });
    await open(n);
    var ops = $("#node-input-defaultOperation option")
      .map(function () {
        return this.value;
      })
      .get();
    await cancel();
    for (var i = 0; i < ops.length; i++) {
      await open(n);
      setVal("#node-input-defaultOperation", ops[i]);
      await save(n);
      eq(n.defaultOperation, ops[i], "stored operation");
      await open(n);
      eq(
        $("#node-input-defaultOperation").val(),
        ops[i],
        "operation shown after reopen",
      );
      await cancel();
    }
  });

  test("client: an unknown stored operation is kept", async function () {
    var n = newNode("opcua-client", {
      endpoint: "ft-ep",
      defaultOperation: "futureop",
    });
    await open(n);
    eq($("#node-input-defaultOperation").val(), "futureop", "selected");
    assert(
      /not in list/.test(
        $("#node-input-defaultOperation option:selected").text(),
      ),
      "marked as not in list",
    );
    await save(n);
    eq(n.defaultOperation, "futureop", "stored");
  });

  test("client: options and retry settings are stored and reopened", async function () {
    var n = newNode("opcua-client", { endpoint: "ft-ep" });
    await open(n);
    setCheck("#node-input-autoConnect", false);
    setCheck("#node-input-verboseLog", false);
    setCheck("#node-input-unwrapSingle", true);
    await toggleSection("opcua-client-retry");
    setVal("#node-input-maxOperationRetries", "5");
    setVal("#node-input-retryBackoffMs", "250");
    setVal("#node-input-retryAttempts", "2");
    await toggleSection("opcua-client-retry");
    await save(n);
    eq(
      [n.autoConnect, n.verboseLog, n.unwrapSingle],
      [false, false, true],
      "checkboxes",
    );
    eq(
      [
        String(n.maxOperationRetries),
        String(n.retryBackoffMs),
        String(n.retryAttempts),
      ],
      ["5", "250", "2"],
      "retry values",
    );
    await open(n);
    assert(
      !$("#opcua-client-retry").hasClass("opcua-collapsed"),
      "retry section opens when not default",
    );
    eq($("#node-input-maxOperationRetries").val(), "5", "retries shown");
    await cancel();
  });

  test("client: legacy connection settings are shown and kept", async function () {
    var n = newNode("opcua-client", {
      endpoint: "ft-ep",
      applicationName: "Old App",
      maxReconnectAttempts: 3,
      reconnectDelay: 2000,
    });
    await open(n);
    await toggleSection("opcua-client-retry");
    assert(visible("#opcua-client-legacy"), "legacy note hidden");
    var text = $("#opcua-client-legacy").text();
    assert(
      /Old App/.test(text) &&
        /reconnect attempts 3/.test(text) &&
        /2000 ms/.test(text),
      "legacy note text: " + text,
    );
    await save(n);
    eq(
      [n.applicationName, n.maxReconnectAttempts, n.reconnectDelay],
      ["Old App", 3, 2000],
      "legacy values kept",
    );
  });

  // =========================================================================
  // opcua-endpoint
  // =========================================================================

  test("endpoint: defaults of a new node", async function () {
    var n = newNode("opcua-endpoint");
    await open(n);
    eq($("#node-config-input-securityMode").val(), "None", "mode");
    assert(
      !visible("#opcua-ep-policy-row"),
      "policy row must be hidden for None",
    );
    assert(visible("#opcua-ep-none-hint"), "None hint");
    assert(!visible("#opcua-ep-certs"), "certificates hidden for None");
    eq($("#opcua-ep-auth").val(), "anonymous", "auth method");
    assert(
      !visible("#opcua-ep-auth-username") &&
        !visible("#opcua-ep-auth-certificate"),
      "auth fields hidden",
    );
    assert(
      $("#opcua-ep-behaviour").hasClass("opcua-collapsed"),
      "behaviour collapsed",
    );
    await save(n);
    eq(n.valid, true, "valid");
  });

  test("endpoint: security mode drives policy, certificates and hints", async function () {
    var n = newNode("opcua-endpoint");
    await open(n);
    setVal("#node-config-input-securityMode", "Sign");
    assert(visible("#opcua-ep-policy-row"), "policy row visible");
    eq(
      $("#node-config-input-securityPolicy").val(),
      "Basic256Sha256",
      "default policy",
    );
    assert(visible("#opcua-ep-certs"), "certificates visible");
    assert(!visible("#opcua-ep-none-hint"), "None hint hidden");
    setVal("#node-config-input-securityPolicy", "Basic256");
    assert(visible("#opcua-ep-deprecated"), "deprecated note for Basic256");
    setVal("#node-config-input-securityPolicy", "Basic128Rsa15");
    assert(
      visible("#opcua-ep-deprecated"),
      "deprecated note for Basic128Rsa15",
    );
    setVal("#node-config-input-securityPolicy", "Aes128_Sha256_RsaOaep");
    assert(!visible("#opcua-ep-deprecated"), "no deprecated note for Aes128");
    setVal("#node-config-input-securityMode", "SignAndEncrypt");
    await save(n);
    eq(
      [n.securityMode, n.securityPolicy],
      ["SignAndEncrypt", "Aes128_Sha256_RsaOaep"],
      "stored security",
    );
    await open(n);
    eq(
      $("#node-config-input-securityPolicy").val(),
      "Aes128_Sha256_RsaOaep",
      "policy after reopen",
    );
    setVal("#node-config-input-securityMode", "None");
    assert(!visible("#opcua-ep-policy-row"), "policy hidden again");
    await save(n);
    eq(
      [n.securityMode, n.securityPolicy],
      ["None", "None"],
      "None resets the policy",
    );
  });

  test("endpoint: authentication method stores only the chosen credentials", async function () {
    var n = newNode("opcua-endpoint");
    await open(n);
    setVal("#opcua-ep-auth", "username");
    assert(
      visible("#opcua-ep-auth-username") &&
        !visible("#opcua-ep-auth-certificate"),
      "username fields",
    );
    setVal("#node-config-input-userName", "u1");
    setVal("#node-config-input-password", "pw1");
    await save(n);
    eq(n.credentials && n.credentials.userName, "u1", "username stored");
    await open(n);
    eq($("#opcua-ep-auth").val(), "username", "method detected on reopen");
    eq($("#node-config-input-userName").val(), "u1", "username shown");
    setVal("#opcua-ep-auth", "certificate");
    assert(
      visible("#opcua-ep-auth-certificate") &&
        !visible("#opcua-ep-auth-username"),
      "certificate fields",
    );
    setVal("#opcua-ep-auth", "anonymous");
    await save(n);
    eq(n.credentials.userName, "", "username cleared");
    eq(n.credentials.password, "", "password cleared");
  });

  test("endpoint: URL validation accepts opc.tcp and environment variables", async function () {
    var n = newNode("opcua-endpoint");
    var cases = [
      ["http://host:4840", false],
      ["opc.tcp://host", true],
      ["opc.tcp://host:4840/UA/Server", true],
      ["${OPCUA_URL}", true],
      ["", false],
    ];
    for (var i = 0; i < cases.length; i++) {
      await open(n);
      setVal("#node-config-input-endpointUrl", cases[i][0]);
      await save(n);
      eq(n.valid, cases[i][1], "valid for '" + cases[i][0] + "'");
    }
  });

  test("endpoint: connection behaviour is stored and opens when set", async function () {
    var n = newNode("opcua-endpoint");
    await open(n);
    await toggleSection("opcua-ep-behaviour");
    setVal("#node-config-input-maxReconnectAttempts", "0");
    setVal("#node-config-input-reconnectDelay", "1500");
    setVal("#node-config-input-operationTimeout", "20000");
    setVal("#node-config-input-poolSize", "2");
    setVal("#node-config-input-applicationName", "UI App");
    await save(n);
    eq(
      [
        String(n.maxReconnectAttempts),
        String(n.reconnectDelay),
        String(n.operationTimeout),
        String(n.poolSize),
        n.applicationName,
      ],
      ["0", "1500", "20000", "2", "UI App"],
      "behaviour values",
    );
    eq(n.valid, true, "valid");
    await open(n);
    assert(
      !$("#opcua-ep-behaviour").hasClass("opcua-collapsed"),
      "behaviour section opens when set",
    );
    setVal("#node-config-input-reconnectDelay", "10");
    await save(n);
    eq(n.valid, false, "reconnect delay below 100 is invalid");
  });

  test("endpoint: certificate field shows and clears a stored file", async function () {
    var n = newNode("opcua-endpoint", {
      securityMode: "Sign",
      securityPolicy: "Basic256Sha256",
      certificateFile: "/data/opcua-certs/client.pem",
    });
    await open(n);
    assert(
      $("#dropzone-cert").hasClass("has-file"),
      "drop zone shows the stored file",
    );
    eq($("#dropzone-cert .cert-status").text(), "client.pem", "file name");
    assert(!$("#dropzone-key").hasClass("has-file"), "empty key zone");
    $("#dropzone-cert .cert-clear").trigger("click");
    assert(!$("#dropzone-cert").hasClass("has-file"), "cleared");
    await save(n);
    eq(n.certificateFile, "", "certificate path removed");
  });

  // =========================================================================
  // opcua-item
  // =========================================================================

  test("item: add, edit and remove rows", async function () {
    var n = newNode("opcua-item");
    await open(n);
    assert(visible("#opcua-item-empty"), "empty state");
    $("#opcua-item-add").trigger("click");
    assert(
      document.activeElement &&
        $(document.activeElement).hasClass("opcua-item-nodeid"),
      "focus in new NodeId",
    );
    $("#opcua-item-add").trigger("click");
    $("#opcua-item-add").trigger("click");
    eq($(".opcua-item-entry").length, 3, "rows");
    var $rows = $(".opcua-item-entry");
    $rows.eq(0).find(".opcua-item-nodeid").val("ns=1;s=A").trigger("input");
    $rows.eq(0).find(".opcua-item-name").val("A").trigger("input");
    $rows.eq(0).find(".opcua-item-datatype").val("Int32").trigger("change");
    $rows.eq(1).find(".opcua-item-nodeid").val("ns=1;s=B").trigger("input");
    $rows.eq(1).find(".opcua-item-array").trigger("click");
    $rows.eq(2).find(".opcua-col-btn[title='Remove']").trigger("click");
    eq($(".opcua-item-entry").length, 2, "rows after remove");
    assert(
      /2 items are appended/.test($("#opcua-item-preview").text()),
      "preview: " + $("#opcua-item-preview").text(),
    );
    checkLayout("opcua-item");
    await save(n);
    eq(
      n.items,
      [
        { nodeId: "ns=1;s=A", itemName: "A", datatype: "Int32" },
        { nodeId: "ns=1;s=B", itemName: "", datatype: "", arrayType: "Array" },
      ],
      "items",
    );
    await open(n);
    eq($(".opcua-item-entry").length, 2, "rows after reopen");
    eq($(".opcua-item-datatype").eq(0).val(), "Int32", "type after reopen");
    eq($(".opcua-item-array").eq(1).is(":checked"), true, "array after reopen");
    await cancel();
  });

  test("item: a row without NodeId is kept and flags the node", async function () {
    var n = newNode("opcua-item");
    await open(n);
    $("#opcua-item-add").trigger("click");
    $(".opcua-item-name").last().val("Only name").trigger("input");
    assert(
      $(".opcua-item-nodeid").last().hasClass("input-error"),
      "NodeId marked red",
    );
    assert(visible("#opcua-item-incomplete"), "incomplete note");
    assert(
      /1 incomplete/.test($("#opcua-item-preview").text()),
      "preview counts it",
    );
    $("#opcua-item-add").trigger("click"); // untouched row
    await save(n);
    eq(n.items.length, 1, "only the untouched row is dropped");
    eq(n.items[0].itemName, "Only name", "row kept");
    eq(n.valid, false, "node incomplete");
    await open(n);
    assert(
      $(".opcua-item-nodeid").first().hasClass("input-error"),
      "still marked after reopen",
    );
    $(".opcua-item-nodeid").first().val("ns=1;s=X").trigger("input");
    assert(
      !$(".opcua-item-nodeid").first().hasClass("input-error"),
      "mark cleared",
    );
    await save(n);
    eq(n.valid, true, "valid with NodeId");
  });

  test("item: structure type field only for ExtensionObject", async function () {
    var n = newNode("opcua-item", {
      items: [{ nodeId: "ns=1;s=S", itemName: "", datatype: "" }],
    });
    await open(n);
    var $ext = $(".opcua-item-ext").first();
    assert(!$ext.is(":visible"), "hidden for Auto");
    $(".opcua-item-datatype").first().val("ExtensionObject").trigger("change");
    assert($ext.is(":visible"), "shown for ExtensionObject");
    $(".opcua-item-dtnodeid").first().val("ns=2;i=3003").trigger("input");
    await save(n);
    eq(n.items[0].dataTypeNodeId, "ns=2;i=3003", "DataType NodeId stored");
  });

  test("item: operation list, collector and unwrap are stored", async function () {
    var n = newNode("opcua-item", {
      items: [{ nodeId: "ns=1;s=A", itemName: "", datatype: "" }],
    });
    await open(n);
    var ops = $("#node-input-operation option")
      .map(function () {
        return this.value;
      })
      .get();
    eq(
      ops,
      [
        "",
        "read",
        "readmultiple",
        "write",
        "writemultiple",
        "subscribe",
        "unsubscribe",
      ],
      "operations",
    );
    assert(
      $("#opcua-item-items .opcua-section-header .opcua-chevron").length === 0,
      "item list is not collapsible",
    );
    await cancel();
    for (var i = 1; i < ops.length; i++) {
      await open(n);
      setVal("#node-input-operation", ops[i]);
      await save(n);
      eq(n.operation, ops[i], "operation stored");
    }
    await open(n);
    setCheck("#node-input-collector", false);
    assert(
      /Sets msg.topic/.test($("#opcua-item-preview").text()),
      "preview for single mode",
    );
    setCheck("#node-input-unwrapSingle", true);
    await save(n);
    eq([n.collector, n.unwrapSingle], [false, true], "checkboxes");
  });

  test("item: Browse fills NodeId, name and type of an empty row", async function () {
    var n = newNode("opcua-item");
    await open(n);
    $("#opcua-item-add").trigger("click");
    $(".opcua-item-entry").last().find(".opcua-picker-btn").trigger("click");
    var $row = await pickerChoose(["TestData", "Scalar", "Double"], "ft-ep");
    assert($row.hasClass("opcua-selectable"), "variable selectable");
    var $folder = pickerRow("Scalar");
    assert(
      !$folder.hasClass("opcua-selectable"),
      "folder not selectable for items",
    );
    $row.trigger("click");
    await pickerConfirm();
    var $e = $(".opcua-item-entry").last();
    eq($e.find(".opcua-item-nodeid").val(), "ns=1;s=Scalar.Double", "NodeId");
    eq($e.find(".opcua-item-name").val(), "Double", "name");
    eq($e.find(".opcua-item-datatype").val(), "Double", "type");
    await save(n);
    eq(n.items[0].nodeId, "ns=1;s=Scalar.Double", "stored");
  });

  test("item: picker Cancel changes nothing", async function () {
    var n = newNode("opcua-item", {
      items: [{ nodeId: "ns=1;s=Keep", itemName: "K", datatype: "" }],
    });
    await open(n);
    $(".opcua-item-entry").first().find(".opcua-picker-btn").trigger("click");
    await until(function () {
      return $(".opcua-picker:visible").length;
    }, "picker");
    assert(
      $("#opcua-picker-ok").prop("disabled"),
      "Select disabled before a choice",
    );
    $("#opcua-picker-cancel").trigger("click");
    await until(function () {
      return !$(".opcua-picker:visible").length;
    }, "picker closed");
    eq(
      $(".opcua-item-nodeid").first().val(),
      "ns=1;s=Keep",
      "NodeId unchanged",
    );
    await cancel();
  });

  // =========================================================================
  // opcua-browser
  // =========================================================================

  test("browser: recursive option controls the depth field", async function () {
    var n = newNode("opcua-browser", { endpoint: "ft-ep" });
    await open(n);
    assert(!visible("#opcua-browser-depth-row"), "depth hidden");
    setCheck("#node-input-recursive", true);
    assert(visible("#opcua-browser-depth-row"), "depth shown");
    setVal("#node-input-maxDepth", "3");
    assert(
      $("#node-input-startNodeId").next(".opcua-picker-btn").length,
      "Browse button",
    );
    await save(n);
    eq([n.recursive, String(n.maxDepth)], [true, "3"], "stored");
    await open(n);
    assert(visible("#opcua-browser-depth-row"), "depth shown after reopen");
    await cancel();
  });

  test("browser: Browse picks any node as start", async function () {
    var n = newNode("opcua-browser", { endpoint: "ft-ep" });
    await open(n);
    $("#node-input-startNodeId").next(".opcua-picker-btn").trigger("click");
    var $row = await pickerChoose(["Machine"]);
    assert($row.hasClass("opcua-selectable"), "object selectable");
    $row.trigger("click");
    await pickerConfirm();
    eq($("#node-input-startNodeId").val(), "ns=1;s=Machine", "start node");
    await save(n);
    eq(n.startNodeId, "ns=1;s=Machine", "stored");
  });

  // =========================================================================
  // opcua-browse-client
  // =========================================================================

  test("browse client: mode, tree selection and saved items", async function () {
    var n = newNode("opcua-browse-client", { endpoint: "ft-ep" });
    await open(n);
    assert(!visible("#opcua-bc-interval-row"), "interval hidden for read");
    setVal("#node-input-mode", "subscribe");
    assert(visible("#opcua-bc-interval-row"), "interval shown for subscribe");
    setVal("#node-input-publishInterval", "500");
    $("#opcua-bc-browse-btn").trigger("click");
    function item(label) {
      return $("#opcua-bc-tree .opcua-bc-tree-item")
        .filter(function () {
          return $(this).find(".opcua-bc-node-label").first().text() === label;
        })
        .first();
    }
    for (var name of ["Objects", "TestData", "Scalar"]) {
      var $it = await until(function () {
        var i = item(name);
        return i.length && i;
      }, "tree item " + name);
      if (name === "Objects" && $it.next(".opcua-bc-children").is(":visible"))
        continue;
      $it.find(".opcua-bc-expandable").trigger("click");
    }
    var $double = await until(function () {
      var i = item("Double");
      return i.length && i;
    }, "tree item Double");
    $double
      .find("input.opcua-bc-checkbox")
      .prop("checked", true)
      .trigger("change");
    eq($("#opcua-bc-selected-count").text(), "1", "selected count");
    assert(
      /Scalar\.Double/.test($("#opcua-bc-selected-list").text()),
      "selected list shows the item",
    );
    await save(n);
    eq(
      [n.mode, String(n.publishInterval)],
      ["subscribe", "500"],
      "mode and interval",
    );
    eq(
      n.selectedItems.map(function (i) {
        return i.nodeId;
      }),
      ["ns=1;s=Scalar.Double"],
      "selected items",
    );
    await open(n);
    eq($("#opcua-bc-selected-count").text(), "1", "selection after reopen");
    $("#opcua-bc-clear-all").trigger("click");
    eq($("#opcua-bc-selected-count").text(), "0", "cleared");
    await save(n);
    eq(n.selectedItems.length, 0, "cleared selection stored");
  });

  // =========================================================================
  // opcua-method
  // =========================================================================

  test("method: Browse for the method fills the object too", async function () {
    var n = newNode("opcua-method", { endpoint: "ft-ep" });
    await open(n);
    eq($(".opcua-picker-btn").length, 2, "two Browse buttons");
    $("#node-input-methodNodeId").next(".opcua-picker-btn").trigger("click");
    var $add = await pickerChoose(["TestData", "Methods", "Add"]);
    assert($add.hasClass("opcua-selectable"), "method selectable");
    assert(
      !pickerRow("Methods").hasClass("opcua-selectable"),
      "folder not selectable for a method",
    );
    $add.trigger("click");
    await pickerConfirm();
    eq($("#node-input-methodNodeId").val(), "ns=1;s=Methods.Add", "method");
    eq($("#node-input-objectNodeId").val(), "ns=1;s=Methods", "object");
    await save(n);
    eq(
      [n.methodNodeId, n.objectNodeId],
      ["ns=1;s=Methods.Add", "ns=1;s=Methods"],
      "stored",
    );
  });

  test("method: Read arguments lists the method signature", async function () {
    var n = newNode("opcua-method", {
      endpoint: "ft-ep",
      objectNodeId: "ns=1;s=Methods",
      methodNodeId: "ns=1;s=Methods.Multiply",
    });
    await open(n);
    await toggleSection("opcua-method-arguments");
    $("#opcua-method-read").trigger("click");
    var $area = await until(function () {
      var t = $("#opcua-method-args textarea");
      return t.length && t;
    }, "example arguments");
    var rows = $("#opcua-method-args .opcua-table-row")
      .map(function () {
        return $(this).text();
      })
      .get();
    eq(rows.length, 3, "argument rows (2 in, 1 out)");
    assert(
      /A/.test(rows[0]) && /Double/.test(rows[0]),
      "first input: " + rows[0],
    );
    var example = JSON.parse($area.val());
    eq(
      example,
      [
        { dataType: "Double", value: 0 },
        { dataType: "Double", value: 0 },
      ],
      "example",
    );
    setVal("#node-input-methodNodeId", "");
    $("#opcua-method-read").trigger("click");
    assert(
      /Set the method NodeId first/.test($("#opcua-method-args").text()),
      "warning without method",
    );
    await cancel();
  });

  // =========================================================================
  // opcua-event
  // =========================================================================

  test("event: suggestions, Browse and stored values", async function () {
    var n = newNode("opcua-event", { endpoint: "ft-ep" });
    await open(n);
    eq($("#opcua-event-types option").length, 16, "event type suggestions");
    eq(
      $("#node-input-eventType").attr("list"),
      "opcua-event-types",
      "suggestions linked",
    );
    $("#node-input-sourceNodeId").next(".opcua-picker-btn").trigger("click");
    var $server = await pickerChoose(["Server"]);
    $server.trigger("click");
    await pickerConfirm();
    eq(
      $("#node-input-sourceNodeId").val(),
      "ns=0;i=2253",
      "source from picker",
    );
    setVal("#node-input-eventType", "AlarmConditionType");
    await save(n);
    eq(
      [n.sourceNodeId, n.eventType],
      ["ns=0;i=2253", "AlarmConditionType"],
      "stored",
    );
  });

  // =========================================================================
  // opcua-server
  // =========================================================================

  test("server: port validation and URL preview", async function () {
    var n = newNode("opcua-server");
    await open(n);
    assert(
      /:4840\/UA\/NodeRED/.test($("#opcua-server-url").text()),
      "preview default port",
    );
    setVal("#node-input-port", "4850");
    assert(
      /:4850\/UA\/NodeRED/.test($("#opcua-server-url").text()),
      "preview follows the port",
    );
    await save(n);
    eq(n.valid, true, "4850 valid");
    var bad = ["0", "70000", "abc"];
    for (var i = 0; i < bad.length; i++) {
      await open(n);
      setVal("#node-input-port", bad[i]);
      await save(n);
      eq(n.valid, false, "port " + bad[i] + " invalid");
    }
  });

  test("server: limits and security are stored and open when set", async function () {
    var n = newNode("opcua-server");
    await open(n);
    assert(
      $("#opcua-server-limits").hasClass("opcua-collapsed"),
      "limits collapsed",
    );
    assert(
      $("#opcua-server-security").hasClass("opcua-collapsed"),
      "security collapsed",
    );
    await toggleSection("opcua-server-limits");
    setVal("#node-input-maxAllowedSessionNumber", "20");
    await toggleSection("opcua-server-security");
    setCheck("#node-input-allowMsgFunc", true);
    await save(n);
    eq(
      [String(n.maxAllowedSessionNumber), n.allowMsgFunc],
      ["20", true],
      "stored",
    );
    await open(n);
    assert(
      !$("#opcua-server-limits").hasClass("opcua-collapsed"),
      "limits open when set",
    );
    assert(
      !$("#opcua-server-security").hasClass("opcua-collapsed"),
      "security open when enabled",
    );
    await cancel();
  });

  // =========================================================================
  // opcua-pubsub-connection
  // =========================================================================

  test("pubsub connection: new node gets a UUID and transport switches sections", async function () {
    var n = newNode("opcua-pubsub-connection");
    await open(n);
    var uuid = $("#node-config-input-publisherId").val();
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        uuid,
      ),
      "UUID: " + uuid,
    );
    assert(
      visible("#opcua-psc-udp") && !visible("#opcua-psc-mqtt"),
      "UDP section",
    );
    setVal("#node-config-input-transportType", "mqtt");
    assert(
      visible("#opcua-psc-mqtt") && !visible("#opcua-psc-udp"),
      "MQTT section",
    );
    assert(
      !$(".opcua-form .cert-dropzone").length,
      "no reserved certificate fields",
    );
    setVal("#node-config-input-brokerUrl", "mqtt://broker:1883");
    setVal("#node-config-input-qos", "2");
    await save(n);
    eq(
      [n.transportType, n.brokerUrl, String(n.qos), n.publisherId],
      ["mqtt", "mqtt://broker:1883", "2", uuid],
      "stored",
    );
  });

  test("pubsub connection: PublisherId type switches the input", async function () {
    var n = newNode("opcua-pubsub-connection");
    await open(n);
    assert(visible("#opcua-psc-new-uuid"), "New button for String");
    var first = $("#node-config-input-publisherId").val();
    $("#opcua-psc-new-uuid").trigger("click");
    assert(
      $("#node-config-input-publisherId").val() !== first,
      "New generates another UUID",
    );
    setVal("#node-config-input-publisherIdType", "UInt32");
    eq(
      $("#node-config-input-publisherId").attr("type"),
      "number",
      "numeric input",
    );
    assert(!visible("#opcua-psc-new-uuid"), "no New button for numbers");
    setVal("#node-config-input-publisherId", "4711");
    await save(n);
    eq(
      [n.publisherIdType, String(n.publisherId)],
      ["UInt32", "4711"],
      "stored",
    );
  });

  // =========================================================================
  // opcua-publisher
  // =========================================================================

  test("publisher: encoding follows the transport, mode shows KeepAlive", async function () {
    var n = newNode("opcua-publisher", { connection: "ft-ps-1" });
    await open(n);
    assert(
      $("#node-input-messageEncoding option[value='json']").prop("disabled"),
      "JSON disabled for UDP",
    );
    assert(visible("#opcua-pub-encoding-hint"), "UDP hint");
    setVal("#node-input-connection", "ft-ps-3");
    assert(
      !$("#node-input-messageEncoding option[value='json']").prop("disabled"),
      "JSON enabled for MQTT",
    );
    assert(!visible("#opcua-pub-encoding-hint"), "hint hidden for MQTT");
    setVal("#node-input-messageEncoding", "json");
    assert(!visible("#opcua-pub-keepalive-row"), "no KeepAlive for acyclic");
    setVal("#node-input-publishMode", "cyclic");
    assert(visible("#opcua-pub-keepalive-row"), "KeepAlive for cyclic");
    assert(
      /every interval/.test($("#opcua-pub-mode-hint").text()),
      "cyclic hint",
    );
    setVal("#node-input-keepAliveTime", "3000");
    setVal("#node-input-publishingInterval", "500");
    await save(n);
    eq(
      [
        n.connection,
        n.messageEncoding,
        n.publishMode,
        String(n.keepAliveTime),
        String(n.publishingInterval),
      ],
      ["ft-ps-3", "json", "cyclic", "3000", "500"],
      "stored",
    );
  });

  test("publisher: writer editor adds, edits and removes writers and fields", async function () {
    var n = newNode("opcua-publisher", { connection: "ft-ps-1" });
    await open(n);
    eq($(".opcua-pub-writer").length, 1, "default writer");
    eq($(".opcua-pub-fname").val(), "value", "default field");
    $("#opcua-pub-add-writer").trigger("click");
    eq($(".opcua-pub-writer").length, 2, "writer added");
    var $w2 = $(".opcua-pub-writer").eq(1);
    eq($w2.find(".opcua-pub-wid").val(), "2", "next writer id");
    $w2.find(".opcua-pub-wname").val("Second").trigger("input");
    $w2.find(".opcua-pub-fname").first().val("Temp").trigger("input");
    $w2.find(".opcua-toolbar button").first().trigger("click"); // Add field
    $w2.find(".opcua-pub-fname").last().val("Label").trigger("input");
    $w2.find(".opcua-pub-ftype").last().val("String").trigger("change");
    $w2.find(".opcua-pub-cvmajor").val("2").trigger("input");
    $w2.find(".opcua-pub-cvminor").val("1").trigger("input");
    $(".opcua-pub-writer")
      .eq(0)
      .find(".opcua-card-head button")
      .trigger("click"); // remove first writer
    eq($(".opcua-pub-writer").length, 1, "writer removed");
    checkLayout("opcua-publisher");
    await save(n);
    eq(
      JSON.parse(n.writers),
      [
        {
          dataSetWriterId: 2,
          dataSetName: "Second",
          publishedDataSet: {
            fields: [
              { name: "Temp", dataType: "Double" },
              { name: "Label", dataType: "String" },
            ],
            name: "Second",
            configurationVersion: { major: 2, minor: 1 },
          },
        },
      ],
      "writers",
    );
    eq(n.valid, true, "valid");
  });

  test("publisher: JSON view round trip keeps unknown properties", async function () {
    var writers = [
      {
        dataSetWriterId: 7,
        dataSetName: "X",
        note: "keep me",
        publishedDataSet: {
          name: "X",
          fields: [
            {
              name: "S",
              dataType: "String",
              maxStringLength: 10,
              valueRank: -1,
            },
          ],
        },
      },
    ];
    var n = newNode("opcua-publisher", {
      connection: "ft-ps-1",
      writers: JSON.stringify(writers),
    });
    await open(n);
    $("#opcua-pub-mode-toggle").trigger("click");
    assert(
      visible("#opcua-pub-json") && !visible("#opcua-pub-writers"),
      "JSON view",
    );
    var list = JSON.parse($("#opcua-pub-json").val());
    list[0].publishedDataSet.fields.push({ name: "N", dataType: "Int32" });
    $("#opcua-pub-json").val(JSON.stringify(list));
    $("#opcua-pub-mode-toggle").trigger("click");
    assert(visible("#opcua-pub-writers"), "back to the form");
    eq($(".opcua-pub-field").length, 2, "field from JSON shown");
    await save(n);
    var saved = JSON.parse(n.writers)[0];
    eq(saved.note, "keep me", "unknown writer property");
    eq(
      saved.publishedDataSet.fields[0].maxStringLength,
      10,
      "unknown field property",
    );
    eq(
      saved.publishedDataSet.fields[1],
      { name: "N", dataType: "Int32" },
      "new field",
    );
  });

  test("publisher: invalid JSON is reported and marks the node", async function () {
    var n = newNode("opcua-publisher", { connection: "ft-ps-1" });
    await open(n);
    $("#opcua-pub-mode-toggle").trigger("click");
    $("#opcua-pub-json").val("[{ broken");
    $("#opcua-pub-mode-toggle").trigger("click");
    assert(visible("#opcua-pub-json-error"), "error shown");
    assert(visible("#opcua-pub-json"), "stays in JSON view");
    await save(n);
    eq(n.valid, false, "node invalid");
    eq(n.writers, "[{ broken", "typed text kept for fixing");
  });

  // =========================================================================
  // opcua-subscriber
  // =========================================================================

  test("subscriber: at least one filter is required", async function () {
    var n = newNode("opcua-subscriber", { connection: "ft-ps-1" });
    await open(n);
    assert(visible("#opcua-sub-filter-missing"), "missing-filter note");
    await save(n);
    eq(n.valid, false, "invalid without filter");
    await open(n);
    setVal("#node-input-writerGroupId", "5");
    assert(!visible("#opcua-sub-filter-missing"), "note hidden");
    await save(n);
    eq([String(n.writerGroupId), n.valid], ["5", true], "valid with a filter");
  });

  test("subscriber: suggestions, encoding rule and version check", async function () {
    var n = newNode("opcua-subscriber", {
      connection: "ft-ps-1",
      dataSetWriterId: 1,
    });
    await open(n);
    var ids = $("#opcua-sub-publisher-ids option")
      .map(function () {
        return this.value;
      })
      .get();
    assert(
      ids.indexOf("15000000-0000-4000-8000-000000000001") !== -1,
      "PublisherId suggestions: " + ids.length,
    );
    assert(
      $("#node-input-messageEncoding option[value='json']").prop("disabled"),
      "JSON disabled for UDP",
    );
    setVal("#node-input-connection", "ft-ps-3");
    assert(
      !$("#node-input-messageEncoding option[value='json']").prop("disabled"),
      "JSON for MQTT",
    );
    await toggleSection("opcua-sub-checks");
    setVal("#node-input-expectedConfigVersion", "abc");
    await save(n);
    eq(n.valid, false, "abc invalid");
    await open(n);
    assert(
      !$("#opcua-sub-checks").hasClass("opcua-collapsed"),
      "checks open when set",
    );
    setVal("#node-input-expectedConfigVersion", "2.1");
    await save(n);
    eq([n.expectedConfigVersion, n.valid], ["2.1", true], "2.1 valid");
  });

  // =========================================================================
  // Palette
  // =========================================================================

  test("palette: every flow node has an OPC UA label", async function () {
    var missing = [];
    TYPES.filter(function (t) {
      return !isConfig(t);
    }).forEach(function (t) {
      var $p = $('.red-ui-palette-node[data-palette-type="' + t + '"]');
      // Node-RED splits palette labels into word blocks.
      var label = $p
        .find(".red-ui-palette-label")
        .text()
        .replace(/\s+/g, " ")
        .trim();
      if (!$p.length || !/^OPC UA /.test(label))
        missing.push(t + " (" + (label || "not in palette") + ")");
    });
    assert(!missing.length, "palette labels: " + missing.join(", "));
  });

  // =========================================================================
  // Existing nodes and theme
  // =========================================================================

  test("all deployed package nodes reopen without change", async function () {
    var diffs = [];
    var list = [];
    RED.nodes.eachNode(function (n) {
      if (TYPES.indexOf(n.type) !== -1 && n.z !== TAB) list.push(n);
    });
    RED.nodes.eachConfig(function (n) {
      if (TYPES.indexOf(n.type) !== -1 && !/^uit-/.test(n.id)) list.push(n);
    });
    function norm(v) {
      return JSON.stringify(v === undefined ? "" : v, function (k, val) {
        if (val && typeof val === "object" && !Array.isArray(val)) {
          return Object.keys(val)
            .sort()
            .reduce(function (o, key) {
              o[key] = val[key];
              return o;
            }, {});
        }
        return val === null || val === undefined
          ? ""
          : typeof val === "number"
            ? String(val)
            : val;
      });
    }
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var def = RED.nodes.getType(n.type).defaults;
      var before = {};
      Object.keys(def).forEach(function (k) {
        before[k] = norm(n[k]);
      });
      await open(n);
      await save(n);
      Object.keys(def).forEach(function (k) {
        var after = norm(n[k]);
        if (after !== before[k])
          diffs.push(n.type + " " + (n.name || n.id) + " " + k);
      });
      if (n.valid === false)
        diffs.push(n.type + " " + (n.name || n.id) + " became invalid");
    }
    assert(
      list.length > 100,
      "expected the function test flow, found " + list.length + " nodes",
    );
    assert(!diffs.length, "changed: " + diffs.join("; "));
  });

  test("theme: dialogs take colours from the editor theme", async function () {
    var root = document.documentElement;
    root.style.setProperty("--red-ui-tertiary-background", "rgb(1, 2, 3)");
    root.style.setProperty("--red-ui-secondary-text-color", "rgb(4, 5, 6)");
    try {
      var n = newNode("opcua-endpoint");
      await open(n);
      eq(
        getComputedStyle($(".opcua-section-header:visible")[0]).backgroundColor,
        "rgb(1, 2, 3)",
        "section header background",
      );
      eq(
        getComputedStyle($(".opcua-hint:visible")[0]).color,
        "rgb(4, 5, 6)",
        "hint colour",
      );
      await cancel();
    } finally {
      root.style.removeProperty("--red-ui-tertiary-background");
      root.style.removeProperty("--red-ui-secondary-text-color");
    }
  });

  // --- runner ----------------------------------------------------------------

  async function closeAllTrays() {
    for (var i = 0; i < 5 && $(".red-ui-tray").length; i++) {
      $(
        "#opcua-picker-cancel:visible, #node-dialog-cancel:visible, #node-config-dialog-cancel:visible",
      )
        .last()
        .trigger("click");
      await sleep(300);
    }
  }

  window.OpcUaUiSuite = {
    count: function () {
      return tests.length;
    },
    run: async function (filter) {
      var results = [];
      for (var i = 0; i < tests.length; i++) {
        var t = tests[i];
        if (filter && t.name.indexOf(filter) === -1) continue;
        var start = Date.now();
        try {
          await t.fn();
          results.push({ name: t.name, ok: true, ms: Date.now() - start });
        } catch (e) {
          results.push({
            name: t.name,
            ok: false,
            error: e.message,
            ms: Date.now() - start,
          });
          await closeAllTrays();
        }
        window.OpcUaUiSuite.progress = results.length;
      }
      return results;
    },
  };
})();
