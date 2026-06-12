"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");

const OpcUaClientManager = require("../lib/opcua-client-manager");

// ─── RED mock with httpAdmin route capture ───

function createRED(endpointNodes) {
  const routes = {};
  return {
    nodes: {
      createNode: function (node, config) {
        Object.assign(node, config);
        node.on = sinon.stub();
        node.status = sinon.stub();
        node.log = sinon.stub();
        node.warn = sinon.stub();
        node.error = sinon.stub();
      },
      registerType: sinon.stub(),
      getNode: function (id) {
        return endpointNodes?.[id] || null;
      },
    },
    httpAdmin: {
      post: function (routePath, handler) {
        routes[routePath] = handler;
      },
      get: function (routePath, handler) {
        routes[routePath] = handler;
      },
    },
    _routes: routes,
  };
}

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
  return res;
}

function makeRef(name, nodeClass = "Object") {
  return {
    browseName: { name },
    nodeId: { toString: () => `ns=3;s=${name}` },
    nodeClass,
    displayName: { text: name },
    typeDefinition: { toString: () => "i=61" },
    isForward: true,
  };
}

const goodStatus = { isNotGood: () => false, toString: () => "Good" };

describe("opcua-browse-client HTTP API (continuation points, issue #14)", function () {
  let RED, sandbox, session, browseRoute, disconnectRoute;

  beforeEach(function () {
    sandbox = sinon.createSandbox();

    session = {
      browse: sinon.stub(),
      browseNext: sinon.stub(),
      read: sinon.stub().resolves([]),
    };

    // Intercept the editor browse connection: no real OPC UA traffic
    sandbox.stub(OpcUaClientManager.prototype, "connect").resolves();
    sandbox.stub(OpcUaClientManager.prototype, "disconnect").resolves();
    sandbox
      .stub(OpcUaClientManager.prototype, "getSession")
      .callsFake(() => session);

    RED = createRED({
      ep1: {
        id: "ep1",
        endpointUrl: "opc.tcp://plc:4840",
        securityMode: "None",
        securityPolicy: "None",
      },
    });

    const modPath = path.resolve(
      __dirname,
      "..",
      "nodes",
      "opcua-browse-client.js",
    );
    delete require.cache[require.resolve(modPath)];
    require(modPath)(RED);

    browseRoute = RED._routes["/opcua-browse-client/browse"];
    disconnectRoute = RED._routes["/opcua-browse-client/disconnect"];
  });

  afterEach(async function () {
    // Drop the cached browse connection and its idle timer
    await disconnectRoute({ body: { endpointId: "ep1" } }, createRes());
    sandbox.restore();
  });

  it("should aggregate references across continuation points (S7-1500 100-item cap)", async function () {
    const firstBatch = Array.from({ length: 100 }, (_, i) =>
      makeRef(`DB_${i}`),
    );
    const secondBatch = Array.from({ length: 100 }, (_, i) =>
      makeRef(`DB_${100 + i}`),
    );
    const thirdBatch = Array.from({ length: 42 }, (_, i) =>
      makeRef(`DB_${200 + i}`),
    );
    const cp1 = Buffer.from("cp1");
    const cp2 = Buffer.from("cp2");

    session.browse.resolves({
      statusCode: goodStatus,
      references: firstBatch,
      continuationPoint: cp1,
    });
    session.browseNext
      .onFirstCall()
      .resolves({ references: secondBatch, continuationPoint: cp2 })
      .onSecondCall()
      .resolves({ references: thirdBatch, continuationPoint: null });

    const res = createRes();
    await browseRoute(
      { body: { endpointId: "ep1", nodeId: "ns=3;s=DataBlocksGlobal" } },
      res,
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.references).to.have.length(242);
    expect(res.body.references[0].browseName).to.equal("DB_0");
    expect(res.body.references[241].browseName).to.equal("DB_241");
    expect(session.browseNext.callCount).to.equal(2);
    expect(session.browseNext.firstCall.args).to.deep.equal([cp1, false]);
    expect(session.browseNext.secondCall.args).to.deep.equal([cp2, false]);
  });

  it("should return all references when there is no continuation point", async function () {
    session.browse.resolves({
      statusCode: goodStatus,
      references: [makeRef("A"), makeRef("B")],
      continuationPoint: null,
    });

    const res = createRes();
    await browseRoute({ body: { endpointId: "ep1" } }, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body.references).to.have.length(2);
    expect(session.browseNext.called).to.be.false;
  });

  it("should follow continuation points in the unfiltered fallback browse too", async function () {
    // Hierarchical browse returns nothing → fallback (no referenceTypeId)
    session.browse
      .onFirstCall()
      .resolves({
        statusCode: goodStatus,
        references: [],
        continuationPoint: null,
      })
      .onSecondCall()
      .resolves({
        statusCode: goodStatus,
        references: Array.from({ length: 100 }, (_, i) => makeRef(`V_${i}`)),
        continuationPoint: Buffer.from("cp"),
      });
    session.browseNext.resolves({
      references: Array.from({ length: 30 }, (_, i) => makeRef(`V_${100 + i}`)),
      continuationPoint: null,
    });

    const res = createRes();
    await browseRoute(
      { body: { endpointId: "ep1", nodeId: "ns=3;s=SomeStruct" } },
      res,
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.references).to.have.length(130);
    expect(session.browse.callCount).to.equal(2);
    expect(session.browseNext.callCount).to.equal(1);
  });

  it("should surface a failed browse as an error instead of an empty folder", async function () {
    session.browse.resolves({
      statusCode: {
        isNotGood: () => true,
        toString: () => "BadNodeIdUnknown (0x80340000)",
      },
      references: [],
      continuationPoint: null,
    });

    const res = createRes();
    await browseRoute({ body: { endpointId: "ep1" } }, res);

    expect(res.statusCode).to.equal(500);
    expect(res.body.error).to.include("BadNodeIdUnknown");
  });

  it("should still report an empty folder with Good status as empty", async function () {
    session.browse.resolves({
      statusCode: goodStatus,
      references: [],
      continuationPoint: null,
    });

    const res = createRes();
    await browseRoute({ body: { endpointId: "ep1" } }, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body.references).to.have.length(0);
  });
});
