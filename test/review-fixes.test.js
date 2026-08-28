"use strict";

/**
 * Regression tests for the code-review fixes that are not covered by a
 * dedicated file. Each block names the defect it locks down.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");

const { parseNodeId, serializeExtensionObject } = require("../lib/opcua-utils");
const certStore = require("../lib/cert-store");
const OpcUaClientManager = require("../lib/opcua-client-manager");

// ─────────────────────────────────────────────────────────────────────────────
describe("parseNodeId — String identifiers containing ';'", function () {
  it("keeps everything after the FIRST separator", function () {
    // Split-on-every-";" + parts[1] truncated this to "Line1".
    expect(parseNodeId("ns=2;s=Line1;Motor")).to.deep.equal({
      namespaceIndex: 2,
      identifierType: "String",
      value: "Line1;Motor",
    });
  });

  it("still parses plain forms unchanged", function () {
    expect(parseNodeId("ns=2;i=5")).to.deep.equal({
      namespaceIndex: 2,
      identifierType: "Numeric",
      value: 5,
    });
    expect(parseNodeId("i=84")).to.deep.equal({
      namespaceIndex: 0,
      identifierType: "Numeric",
      value: 84,
    });
    expect(parseNodeId("RootFolder")).to.deep.equal({
      namespaceIndex: 0,
      identifierType: "Numeric",
      value: 84,
    });
  });

  it("keeps a ';' in a namespace-less String identifier", function () {
    expect(parseNodeId("s=Foo;Bar").value).to.equal("Foo;Bar");
  });

  it("rejects a non-numeric namespace instead of yielding NaN", function () {
    expect(parseNodeId("ns=abc;s=X")).to.equal(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("serializeExtensionObject — recursion guards", function () {
  it("does not blow the stack on a self-referential value", function () {
    const a = { schema: { name: "A", fields: [] }, name: "a" };
    a.self = a;
    let out;
    expect(() => {
      out = serializeExtensionObject(a);
    }).to.not.throw();
    expect(out.self).to.deep.equal({ _circular: true });
  });

  it("truncates beyond the depth cap instead of recursing forever", function () {
    // Build a deep, non-cyclic chain (each level a distinct object).
    let leaf = { value: "bottom" };
    for (let i = 0; i < 60; i++) leaf = { nested: leaf };
    let out;
    expect(() => {
      out = serializeExtensionObject(leaf);
    }).to.not.throw();
    let cur = out;
    let depth = 0;
    while (cur && cur.nested) {
      cur = cur.nested;
      depth++;
    }
    expect(cur).to.have.property("_truncated", true);
    expect(depth).to.be.lessThan(60);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("cert-store — admin permission guard and extension whitelist", function () {
  const TMP_DIR = path.join(os.tmpdir(), "opcua-certstore-review-test");

  function makeMockRED(auth) {
    const routes = {};
    const middleware = {};
    function record(method) {
      return function (routePath) {
        const fns = Array.prototype.slice.call(arguments, 1);
        routes[method + " " + routePath] = fns[fns.length - 1];
        middleware[method + " " + routePath] = fns.slice(0, -1);
      };
    }
    const RED = {
      httpAdmin: {
        post: record("POST"),
        get: record("GET"),
        delete: record("DEL"),
      },
      settings: { userDir: TMP_DIR },
      routes,
      middleware,
    };
    if (auth) RED.auth = auth;
    return RED;
  }

  beforeEach(function () {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(function () {
    if (fs.existsSync(TMP_DIR)) {
      for (const f of fs.readdirSync(TMP_DIR)) {
        const p = path.join(TMP_DIR, f);
        if (fs.statSync(p).isFile()) fs.unlinkSync(p);
      }
    }
  });

  it("puts RED.auth.needsPermission in front of every route", function () {
    const guard = sinon.stub().returns(function (req, res, next) {
      next();
    });
    const RED = makeMockRED({ needsPermission: guard });
    certStore.registerCertRoutes(RED, "/p", TMP_DIR);

    expect(RED.middleware["POST /p/upload-cert"]).to.have.length(1);
    expect(RED.middleware["GET /p/certs"]).to.have.length(1);
    expect(RED.middleware["DEL /p/upload-cert/:filename"]).to.have.length(1);

    const scopes = guard.getCalls().map((c) => c.args[0]);
    expect(scopes).to.include("flows.write");
    expect(scopes).to.include("flows.read");
  });

  it("falls back to a pass-through when RED.auth is unavailable", function () {
    const RED = makeMockRED(null);
    certStore.registerCertRoutes(RED, "/p", TMP_DIR);
    const mw = RED.middleware["POST /p/upload-cert"][0];
    const next = sinon.stub();
    mw({}, {}, next);
    expect(next.calledOnce).to.equal(true);
  });

  it("rejects a file whose extension is not on the whitelist", async function () {
    let thrown = null;
    try {
      await certStore.uploadCert(
        TMP_DIR,
        "payload.js",
        Buffer.from("x").toString("base64"),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.an("error");
    expect(thrown.status).to.equal(400);
    expect(fs.existsSync(path.join(TMP_DIR, "payload.js"))).to.equal(false);
  });

  it("still accepts every whitelisted extension", async function () {
    for (const name of ["a.pem", "b.der", "c.crt", "d.key", "e.pfx", "f.p12"]) {
      const res = await certStore.uploadCert(
        TMP_DIR,
        name,
        Buffer.from("x").toString("base64"),
      );
      expect(fs.existsSync(res.path)).to.equal(true);
    }
  });

  it("normalises '..' to a real file name", function () {
    expect(certStore.sanitiseFilename("..")).to.equal("cert.pem");
    expect(certStore.sanitiseFilename(".")).to.equal("cert.pem");
    // "/" becomes "_", so the result can never escape the certs directory
    expect(certStore.sanitiseFilename("../../etc/passwd")).to.equal(
      ".._.._etc_passwd",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("OpcUaClientManager.browse — reference type filter", function () {
  function makeConnectedManager(browseStub) {
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });
    mgr.isConnected = true;
    mgr.session = {
      isReconnecting: false,
      hasBeenClosed: () => false,
      browse: browseStub,
    };
    return mgr;
  }

  const goodResult = {
    references: [],
    continuationPoint: null,
    statusCode: { isNotGood: () => false, toString: () => "Good" },
  };

  it("defaults to HierarchicalReferences (matching the editor tree)", async function () {
    const browse = sinon.stub().resolves(goodResult);
    const mgr = makeConnectedManager(browse);

    await mgr.browse("ns=2;s=Folder");

    const desc = browse.firstCall.args[0];
    expect(desc.referenceTypeId).to.equal("HierarchicalReferences");
    expect(desc.includeSubtypes).to.equal(true);
  });

  it("lets a caller opt back into every reference type", async function () {
    const browse = sinon.stub().resolves(goodResult);
    const mgr = makeConnectedManager(browse);

    await mgr.browse("ns=2;s=Folder", { referenceTypeId: null });

    expect(browse.firstCall.args[0].referenceTypeId).to.equal(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("_isConnectionLostError — operation timeouts", function () {
  const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });

  it("classifies an operation timeout as connection-lost so the retry loop runs", function () {
    expect(
      mgr._isConnectionLostError(
        new Error("Operation timed out after 10000ms: read"),
      ),
    ).to.equal(true);
  });

  it("still does not classify a genuine logic error", function () {
    expect(
      mgr._isConnectionLostError(new Error("Invalid NodeId: ns=2;s=Nope")),
    ).to.equal(false);
    expect(mgr._isConnectionLostError(new Error("BadNodeIdUnknown"))).to.equal(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("getEndpoints — channel cleanup on failure", function () {
  let sandbox;
  beforeEach(function () {
    sandbox = sinon.createSandbox();
  });
  afterEach(function () {
    sandbox.restore();
  });

  it("disconnects the discovery client even when getEndpoints() throws", async function () {
    const { OPCUAClient } = require("node-opcua");
    let disconnected = 0;
    sandbox.stub(OPCUAClient, "create").callsFake(() => {
      const c = new EventEmitter();
      c.connect = async () => {};
      c.getEndpoints = async () => {
        throw new Error("BadServiceUnsupported");
      };
      c.disconnect = async () => {
        disconnected++;
      };
      return c;
    });

    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });
    let thrown = null;
    try {
      await mgr.getEndpoints();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.an("error");
    expect(disconnected).to.equal(1);
  });
});
