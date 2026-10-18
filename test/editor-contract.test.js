"use strict";

/**
 * Static checks of the editor files (nodes/*.html, resources/*).
 *
 * The edit dialogs are plain HTML/JS that no unit test executes, so these
 * checks pin down the contract between dialog and runtime: every operation a
 * node executes can be chosen in its dialog, every dialog loads the shared
 * editor resources, and no dialog hard-codes colours that break dark themes.
 */

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkg = require(path.join(ROOT, "package.json"));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const NODE_TYPES = Object.keys(pkg["node-red"].nodes);

function listValues(html, varName) {
  const start = html.indexOf(`var ${varName} = [`);
  expect(start, `${varName} not found`).to.be.greaterThan(-1);
  const block = html.slice(start, html.indexOf("];", start));
  return [...block.matchAll(/\[\s*"([a-z]*)"\s*,/g)].map((m) => m[1]);
}

function styleBlocks(html) {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}

describe("editor contract", function () {
  const clientOps = [
    ...read("nodes/opcua-client.js").matchAll(/^\s+case "([a-z]+)":/gm),
  ]
    .map((m) => m[1])
    // the status callback uses case labels too
    .filter(
      (op) =>
        ![
          "connected",
          "disconnected",
          "reconnecting",
          "error",
          "session_recreated",
        ].includes(op),
    );

  it("finds the client operations in opcua-client.js", function () {
    expect(clientOps).to.include.members(["read", "write", "unregisternodes"]);
  });

  it("offers every client operation in the client dialog", function () {
    const offered = listValues(
      read("nodes/opcua-client.html"),
      "OPCUA_CLIENT_OPERATIONS",
    );
    expect(offered).to.have.members(clientOps);
  });

  it("offers every operation the item node passes on", function () {
    const offered = listValues(
      read("nodes/opcua-item.html"),
      "ITEM_OPERATIONS",
    );
    expect(offered).to.include.members([
      "",
      "read",
      "readmultiple",
      "write",
      "writemultiple",
      "subscribe",
      "unsubscribe",
    ]);
    for (const op of offered.filter(Boolean)) {
      expect(clientOps, `item operation ${op}`).to.include(op);
    }
  });

  it("keeps item rows that have content but no NodeId yet", function () {
    const html = read("nodes/opcua-item.html");
    const save = html.slice(html.indexOf("oneditsave"));
    // The old dialog skipped every row without NodeId, so a row with a typed
    // name vanished on save. Only an untouched row may be dropped now.
    expect(save).to.not.match(/if \(!nodeId\) return;/);
    expect(save).to.match(
      /if \(!nodeId && !itemName && !datatype && !dtn && !isArray\) return;/,
    );
    // ...and the node is flagged incomplete while a row lacks its NodeId.
    expect(html).to.match(/items: \{\s*value: \[\],\s*validate: function/);
  });

  it("does not let the item list collapse out of sight", function () {
    const html = read("nodes/opcua-item.html");
    expect(html).to.include(
      'class="opcua-section opcua-static" id="opcua-item-items"',
    );
    expect(read("resources/opcua-editor.js")).to.include(
      '.find(".opcua-section:not(.opcua-static)")',
    );
  });

  it("keeps unknown stored select values instead of dropping them", function () {
    const js = read("resources/opcua-editor.js");
    expect(js).to.match(/E\.keepValue = function/);
    expect(read("nodes/opcua-client.html")).to.include("OpcUaEditor.keepValue");
    expect(read("nodes/opcua-item.html")).to.include("OpcUaEditor.keepValue");
  });

  for (const type of NODE_TYPES) {
    describe(type, function () {
      const html = read(`nodes/${type}.html`);

      it("loads the shared editor stylesheet and script", function () {
        expect(html).to.include(
          'href="resources/node-red-contrib-opcua-suite/opcua-editor.css"',
        );
        expect(html).to.include(
          'src="resources/node-red-contrib-opcua-suite/opcua-editor.js"',
        );
      });

      it("uses the shared form layout", function () {
        expect(html).to.match(/class="opcua-form[ "]/);
      });

      it("has a palette label and a help text", function () {
        expect(html).to.match(/paletteLabel:\s*"OPC UA [^"]+"/);
        expect(html).to.include(`data-help-name="${type}"`);
      });

      it("takes colours from the editor theme", function () {
        for (const css of styleBlocks(html)) {
          const hard = css
            .split("\n")
            .filter((line) => /#[0-9a-fA-F]{3,6}\b/.test(line))
            .filter(
              (line) =>
                !/var\(--red-ui-[\w-]+,\s*#[0-9a-fA-F]{3,6}\)/.test(line),
            );
          expect(hard, hard.join("\n")).to.deep.equal([]);
        }
      });
    });
  }

  describe("shared resources", function () {
    const css = read("resources/opcua-editor.css");

    it("hides the native file input inside certificate drop zones", function () {
      // Node-RED's own input rules are more specific than a plain class rule.
      expect(css).to.match(
        /\.red-ui-editor \.opcua-form \.cert-dropzone input\.cert-file-input\[type="file"\]\s*\{\s*display: none !important;/,
      );
    });

    it("uses theme variables for every colour", function () {
      const hard = css
        .split("\n")
        .filter((line) => /#[0-9a-fA-F]{3,6}\b/.test(line))
        .filter(
          (line) => !/var\(--red-ui-[\w-]+,\s*#[0-9a-fA-F]{3,6}\)/.test(line),
        );
      expect(hard, hard.join("\n")).to.deep.equal([]);
    });

    it("is not excluded from the npm package", function () {
      const npmignore = read(".npmignore");
      expect(npmignore).to.not.match(/^resources/m);
    });
  });
});
