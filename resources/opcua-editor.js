/*
 * Shared editor helpers for node-red-contrib-opcua-suite.
 *
 * Loaded by every edit dialog of the package. Defines window.OpcUaEditor
 * once; later loads are no-ops.
 */
(function () {
  "use strict";
  if (window.OpcUaEditor) return;

  var E = {};

  // --- Constants -----------------------------------------------------------

  // Field types the PubSub encoders (UADP and JSON) can carry.
  E.PUBSUB_DATA_TYPES = [
    "Boolean",
    "SByte",
    "Byte",
    "Int16",
    "UInt16",
    "Int32",
    "UInt32",
    "Int64",
    "UInt64",
    "Float",
    "Double",
    "String",
    "DateTime",
    "Guid",
    "ByteString",
    "StatusCode",
  ];

  // Standard event types offered as suggestions in the event node.
  E.EVENT_TYPES = [
    "BaseEventType",
    "SystemEventType",
    "DeviceFailureEventType",
    "AuditEventType",
    "ProgressEventType",
    "TransitionEventType",
    "ConditionType",
    "AcknowledgeableConditionType",
    "AlarmConditionType",
    "LimitAlarmType",
    "ExclusiveLimitAlarmType",
    "NonExclusiveLimitAlarmType",
    "OffNormalAlarmType",
    "DiscreteAlarmType",
    "TripAlarmType",
    "SystemOffNormalAlarmType",
  ];

  // --- Small helpers -------------------------------------------------------

  /**
   * Wires up every .opcua-section below root as a collapsible section.
   * A section with the class opcua-static stays open and has no toggle.
   */
  E.sections = function (root) {
    $(root)
      .find(".opcua-section:not(.opcua-static)")
      .each(function () {
        var $sec = $(this);
        var $head = $sec.children(".opcua-section-header");
        var $chev = $head.find(".opcua-chevron");
        function sync() {
          var collapsed = $sec.hasClass("opcua-collapsed");
          $chev
            .toggleClass("fa-chevron-right", collapsed)
            .toggleClass("fa-chevron-down", !collapsed);
        }
        $head.off("click.opcua").on("click.opcua", function () {
          $sec.toggleClass("opcua-collapsed");
          sync();
        });
        sync();
      });
  };

  /** Opens a section, e.g. when it holds a value that is not the default. */
  E.expand = function (selector) {
    var $sec = $(selector);
    $sec.removeClass("opcua-collapsed");
    $sec
      .children(".opcua-section-header")
      .find(".opcua-chevron")
      .removeClass("fa-chevron-right")
      .addClass("fa-chevron-down");
  };

  /**
   * Selects `value` in a <select>. A stored value the option list does not
   * know gets its own option, so opening and saving a dialog never drops it.
   */
  E.keepValue = function (selector, value) {
    var $sel = $(selector);
    if (value === undefined || value === null) return;
    var v = String(value);
    var known = $sel.find("option").filter(function () {
      return this.value === v;
    }).length;
    if (!known) {
      $("<option>")
        .val(v)
        .text(v + " (not in list)")
        .appendTo($sel);
    }
    $sel.val(v);
  };

  /** POSTs JSON to an admin route relative to the editor; returns a promise. */
  E.post = function (path, body) {
    return new Promise(function (resolve, reject) {
      $.ajax({
        url: path,
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify(body || {}),
        success: resolve,
        error: function (xhr) {
          var msg =
            (xhr.responseJSON && xhr.responseJSON.error) ||
            xhr.statusText ||
            "Request failed";
          if (xhr.status === 404 && /Deploy first/i.test(msg)) {
            msg =
              "The endpoint is not deployed yet. Deploy the flow, then try again.";
          }
          reject(new Error(msg));
        },
      });
    });
  };

  /** All opcua-endpoint config nodes as [{ id, label }]. */
  E.endpoints = function () {
    var list = [];
    RED.nodes.eachConfig(function (n) {
      if (n.type === "opcua-endpoint") {
        list.push({ id: n.id, label: n.name || n.endpointUrl || n.id });
      }
    });
    return list;
  };

  /** Fills a <datalist> with the given values. */
  E.datalist = function (id, values) {
    var $dl = $("#" + id);
    $dl.empty();
    values.forEach(function (v) {
      $("<option>").attr("value", v).appendTo($dl);
    });
  };

  // --- Certificate upload --------------------------------------------------

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  /**
   * Turns a .cert-dropzone into a drag-and-drop / click upload that stores
   * the uploaded file's path in the hidden input `inputId`.
   */
  E.certUpload = function (dropzoneId, inputId, routePrefix) {
    var $dropzone = $("#" + dropzoneId);
    var $input = $("#" + inputId);
    var $fileInput = $dropzone.find(".cert-file-input");
    var $status = $dropzone.find(".cert-status");
    var $icon = $dropzone.find(".cert-icon");
    var idleText = "Drop a file here or click to choose one";

    function showFile(text) {
      $icon
        .removeClass("fa-cloud-upload fa-spinner fa-spin")
        .addClass("fa-check-circle");
      $status.text(text);
      $dropzone.removeClass("upload-error").addClass("has-file");
    }
    function showIdle(text, isError) {
      $icon
        .removeClass("fa-check-circle fa-spinner fa-spin")
        .addClass("fa-cloud-upload");
      $status.text(text || idleText);
      $dropzone.removeClass("has-file").toggleClass("upload-error", !!isError);
    }

    if ($input.val()) showFile($input.val().split("/").pop());
    else showIdle();

    $dropzone.on("click", function (e) {
      if ($(e.target).closest(".cert-clear").length) return;
      if (e.target === $fileInput[0]) return;
      $fileInput.trigger("click");
    });
    $dropzone.on("dragover", function (e) {
      e.preventDefault();
      e.stopPropagation();
      $dropzone.addClass("drag-over");
    });
    $dropzone.on("dragleave", function (e) {
      e.preventDefault();
      e.stopPropagation();
      $dropzone.removeClass("drag-over");
    });
    $dropzone.on("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      $dropzone.removeClass("drag-over");
      var files = e.originalEvent.dataTransfer.files;
      if (files.length > 0) upload(files[0]);
    });
    $fileInput.on("change", function () {
      if (this.files.length > 0) upload(this.files[0]);
      this.value = "";
    });
    $dropzone.find(".cert-clear").on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      $input.val("");
      showIdle();
    });

    function upload(file) {
      $icon
        .removeClass("fa-cloud-upload fa-check-circle")
        .addClass("fa-spinner fa-spin");
      $status.text("Uploading...");
      var reader = new FileReader();
      reader.onload = function (ev) {
        var base64 = ev.target.result.split(",")[1];
        E.post(routePrefix + "/upload-cert", {
          filename: file.name,
          content: base64,
        }).then(
          function (resp) {
            $input.val(resp.path);
            showFile(resp.filename + " (" + formatSize(resp.size) + ")");
          },
          function (err) {
            showIdle(err.message, true);
          },
        );
      };
      reader.readAsDataURL(file);
    }
  };

  // --- NodeId picker -------------------------------------------------------

  /**
   * Opens a tray that browses an endpoint's address space and lets the user
   * pick one node.
   *
   * opts.endpointId  preselected endpoint (any opcua-endpoint if missing)
   * opts.classes     selectable NodeClasses, e.g. ["Variable"]; all if empty
   * opts.title       tray title
   * opts.onPick(ref, parentRef, endpointId)
   *                  ref: { nodeId, browseName, displayName, nodeClass,
   *                  dataType } as returned by the browse route
   */
  E.pickNodeId = function (opts) {
    opts = opts || {};
    var classes = opts.classes || [];
    var chosen = null;
    var endpoints = E.endpoints();
    var endpointId =
      opts.endpointId && RED.nodes.node(opts.endpointId)
        ? opts.endpointId
        : endpoints.length
          ? endpoints[0].id
          : "";

    function selectable(ref) {
      return !classes.length || classes.indexOf(ref.nodeClass) !== -1;
    }

    RED.tray.show({
      title: opts.title || "Select a node",
      buttons: [
        {
          id: "opcua-picker-cancel",
          text: "Cancel",
          click: function () {
            RED.tray.close();
          },
        },
        {
          id: "opcua-picker-ok",
          text: "Select",
          class: "primary",
          click: function () {
            if (!chosen) return;
            var pick = chosen;
            // Node-RED detaches the dialog below while this tray is open and
            // re-attaches it only when the close animation has finished, so
            // the choice is handed over in the close callback. Before that,
            // an ID lookup in the dialog below finds nothing.
            RED.tray.close(function () {
              if (opts.onPick) opts.onPick(pick.ref, pick.parent, endpointId);
            });
          },
        },
      ],
      open: function (tray) {
        var $body = tray.find(".red-ui-tray-body");
        var $root = $('<div class="opcua-picker"></div>').appendTo($body);
        $body.css("height", "100%");

        var $bar = $('<div class="opcua-picker-bar"></div>').appendTo($root);
        $("<label>").text("Endpoint").css({ margin: 0 }).appendTo($bar);
        var $ep = $("<select></select>").appendTo($bar);
        endpoints.forEach(function (ep) {
          $("<option>").val(ep.id).text(ep.label).appendTo($ep);
        });
        $ep.val(endpointId);

        var hint = classes.length
          ? "Selectable: " + classes.join(", ") + ". Double-click to select."
          : "Double-click a node to select it.";
        $('<div class="opcua-picker-status"></div>').text(hint).appendTo($root);
        var $tree = $('<div class="opcua-picker-tree"></div>').appendTo($root);
        var $choice = $('<div class="opcua-picker-choice"></div>').appendTo(
          $root,
        );
        $("#opcua-picker-ok").addClass("disabled").prop("disabled", true);

        function choose(ref, parent, $row) {
          chosen = { ref: ref, parent: parent };
          $tree.find(".opcua-selected").removeClass("opcua-selected");
          $row.addClass("opcua-selected");
          $choice.text(ref.nodeId);
          $("#opcua-picker-ok").removeClass("disabled").prop("disabled", false);
        }

        function load(nodeId, $container, parent, autoOpen) {
          var $status = $('<div class="opcua-picker-status"></div>')
            .text("Loading...")
            .css("padding-left", "8px")
            .appendTo($container);
          E.post("opcua-browse-client/browse", {
            endpointId: endpointId,
            nodeId: nodeId,
          }).then(
            function (resp) {
              $status.remove();
              var refs = resp.references || [];
              if (!refs.length) {
                $('<div class="opcua-picker-status"></div>')
                  .text("No child nodes")
                  .css("padding-left", "8px")
                  .appendTo($container);
                return;
              }
              var $ul = $("<ul></ul>").appendTo($container);
              refs.forEach(function (ref) {
                var $li = $("<li></li>").appendTo($ul);
                var $row = $('<div class="opcua-picker-row"></div>').appendTo(
                  $li,
                );
                var $toggle = $('<span class="opcua-picker-toggle"></span>')
                  .appendTo($row)
                  .html(
                    ref.hasChildren ? '<i class="fa fa-caret-right"></i>' : "",
                  );
                $('<span class="opcua-picker-name"></span>')
                  .text(ref.displayName || ref.browseName)
                  .appendTo($row);
                $('<span class="opcua-picker-meta"></span>')
                  .text(
                    ref.nodeClass + (ref.dataType ? ", " + ref.dataType : ""),
                  )
                  .appendTo($row);
                if (selectable(ref)) {
                  $row.addClass("opcua-selectable");
                  $row.on("click", function (e) {
                    if ($(e.target).closest(".opcua-picker-toggle").length)
                      return;
                    choose(ref, parent, $row);
                  });
                  $row.on("dblclick", function () {
                    choose(ref, parent, $row);
                    $("#opcua-picker-ok").trigger("click");
                  });
                }
                var loaded = false;
                function toggle() {
                  if (!ref.hasChildren) return;
                  var $icon = $toggle.find(".fa");
                  if (!loaded) {
                    loaded = true;
                    $icon
                      .removeClass("fa-caret-right")
                      .addClass("fa-caret-down");
                    load(ref.nodeId, $li, ref, false);
                    return;
                  }
                  var $kids = $li.children("ul, .opcua-picker-status");
                  $kids.toggle();
                  $icon.toggleClass("fa-caret-right fa-caret-down");
                }
                $toggle.on("click", toggle);
                if (!selectable(ref)) $row.on("dblclick", toggle);
                if (autoOpen && ref.browseName === "Objects") toggle();
              });
            },
            function (err) {
              $status.addClass("opcua-error").text(err.message);
            },
          );
        }

        function reload() {
          chosen = null;
          $choice.text("");
          $("#opcua-picker-ok").addClass("disabled").prop("disabled", true);
          $tree.empty();
          if (!endpointId) {
            $('<div class="opcua-picker-status opcua-error"></div>')
              .text("Add an OPC UA endpoint first.")
              .css("padding-left", "8px")
              .appendTo($tree);
            return;
          }
          load("RootFolder", $tree, null, true);
        }
        $ep.on("change", function () {
          endpointId = $ep.val();
          reload();
        });
        reload();
      },
    });
  };

  /**
   * Adds a browse button after `$input` that opens the picker and writes the
   * chosen NodeId into the input.
   *
   * opts.endpoint()  returns the endpoint id to browse
   * opts.classes, opts.title as for pickNodeId
   * opts.onPick(ref, parent, endpointId) optional extra handling
   * opts.compact     icon-only button for table rows
   */
  E.attachPicker = function ($input, opts) {
    opts = opts || {};
    var $btn = $(
      '<button type="button" class="red-ui-button opcua-picker-btn" title="Browse the server"></button>',
    );
    if (opts.compact) $btn.html('<i class="fa fa-sitemap"></i>');
    else $btn.text("Browse");
    $input.after($btn);
    $btn.on("click", function () {
      E.pickNodeId({
        endpointId: opts.endpoint ? opts.endpoint() : "",
        classes: opts.classes,
        title: opts.title,
        onPick: function (ref, parent, endpointId) {
          $input.val(ref.nodeId).trigger("change");
          if (opts.onPick) opts.onPick(ref, parent, endpointId);
        },
      });
    });
    return $btn;
  };

  window.OpcUaEditor = E;
})();
