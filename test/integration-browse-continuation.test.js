"use strict";

/**
 * Integration test for issue #14: browse results capped at the server's
 * per-browse reference limit (S7-1500 returns at most 100 per response).
 *
 * We reproduce the S7 behavior against a real node-opcua server by
 * lowering the client session's requestedMaxReferencesPerNode to 100,
 * which makes the server paginate with continuation points exactly like
 * a server-side cap does.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");
const {
  OPCUAServer,
  Variant,
  DataType,
  MessageSecurityMode,
  SecurityPolicy,
} = require("node-opcua");

const OpcUaClientManager = require("../lib/opcua-client-manager");

// Use a random port to avoid conflicts with a running test-server.
const PORT = 49400 + Math.floor(Math.random() * 1000);
const ENDPOINT = `opc.tcp://localhost:${PORT}/UA/BrowseContinuationTest`;

const TOTAL_OBJECTS = 250;
const TOTAL_VARIABLES = 5;
const TOTAL_CHILDREN = TOTAL_OBJECTS + TOTAL_VARIABLES;
const PAGE_SIZE = 100;

describe("Integration: browse with continuation points (issue #14)", function () {
  this.timeout(60000);

  let server;
  let folderNodeId;

  before(async function () {
    server = new OPCUAServer({
      port: PORT,
      resourcePath: "/UA/BrowseContinuationTest",
      maxAllowedSessionNumber: 50,
      securityModes: [MessageSecurityMode.None],
      securityPolicies: [SecurityPolicy.None],
      allowAnonymous: true,
    });
    await server.initialize();

    const addressSpace = server.engine.addressSpace;
    const namespace = addressSpace.getOwnNamespace();
    const objectsFolder = addressSpace.rootFolder.objects;

    // Mimic an S7-1500 DataBlocksGlobal folder with many user blocks
    const folder = namespace.addFolder(objectsFolder, {
      browseName: "DataBlocksGlobal",
    });
    folderNodeId = folder.nodeId.toString();

    for (let i = 0; i < TOTAL_OBJECTS; i++) {
      namespace.addObject({
        organizedBy: folder,
        browseName: `DB_${String(i).padStart(3, "0")}`,
      });
    }
    for (let i = 0; i < TOTAL_VARIABLES; i++) {
      namespace.addVariable({
        organizedBy: folder,
        browseName: `Tag_${i}`,
        dataType: "Double",
        value: { dataType: DataType.Double, value: i * 1.5 },
      });
    }

    await server.start();
  });

  after(async function () {
    if (server) {
      await server.shutdown();
    }
  });

  describe("OpcUaClientManager.browse()", function () {
    let mgr;

    beforeEach(async function () {
      mgr = new OpcUaClientManager({
        endpointUrl: ENDPOINT,
        securityMode: "None",
        securityPolicy: "None",
        maxReconnectAttempts: 0,
      });
      await mgr.connect();
      // Force pagination like an S7-1500 server-side cap
      mgr.session.requestedMaxReferencesPerNode = PAGE_SIZE;
    });

    afterEach(async function () {
      await mgr.disconnect();
    });

    it("sanity: a raw single browse really is capped at the page size", async function () {
      // Guards the test itself — if the server ignored the limit, the
      // pagination test below would pass without exercising browseNext.
      const raw = await mgr.session.browse({
        nodeId: folderNodeId,
        resultMask: 63,
      });
      expect(raw.references).to.have.length(PAGE_SIZE);
      expect(raw.continuationPoint).to.exist;
      expect(raw.continuationPoint.length).to.be.greaterThan(0);
      // Release the dangling continuation point
      await mgr.session.browseNext(raw.continuationPoint, true);
    });

    it("returns all children across continuation points", async function () {
      const references = await mgr.browse(folderNodeId);

      // browse() uses no referenceTypeId filter, so the folder's own
      // HasTypeDefinition reference (FolderType) is included as well.
      const childNames = references
        .map((r) => r.browseName?.name)
        .filter((n) => n && (n.startsWith("DB_") || n.startsWith("Tag_")))
        .sort();

      expect(childNames).to.have.length(TOTAL_CHILDREN);
      expect(childNames[0]).to.equal("DB_000");
      expect(childNames).to.include("DB_249");
      expect(childNames).to.include("Tag_4");
      // No duplicates across pages
      expect(new Set(childNames).size).to.equal(TOTAL_CHILDREN);
    });
  });

  describe("opcua-browse-client editor HTTP API", function () {
    let RED, sandbox, browseRoute, disconnectRoute;

    before(function () {
      sandbox = sinon.createSandbox();

      // Wrap getSession to force pagination on the otherwise real session
      const origGetSession = OpcUaClientManager.prototype.getSession;
      sandbox
        .stub(OpcUaClientManager.prototype, "getSession")
        .callsFake(function () {
          const session = origGetSession.call(this);
          if (session) {
            session.requestedMaxReferencesPerNode = PAGE_SIZE;
          }
          return session;
        });

      const routes = {};
      RED = {
        nodes: {
          createNode() {},
          registerType: sinon.stub(),
          getNode(id) {
            if (id === "ep1") {
              return {
                id: "ep1",
                endpointUrl: ENDPOINT,
                securityMode: "None",
                securityPolicy: "None",
              };
            }
            return null;
          },
        },
        httpAdmin: {
          post(routePath, handler) {
            routes[routePath] = handler;
          },
          get(routePath, handler) {
            routes[routePath] = handler;
          },
        },
      };

      const modPath = path.resolve(
        __dirname,
        "..",
        "nodes",
        "opcua-browse-client.js",
      );
      delete require.cache[require.resolve(modPath)];
      require(modPath)(RED);

      browseRoute = routes["/opcua-browse-client/browse"];
      disconnectRoute = routes["/opcua-browse-client/disconnect"];
    });

    after(async function () {
      // Close the cached editor browse connection and its idle timer
      const res = {
        status() {
          return this;
        },
        json() {},
      };
      await disconnectRoute({ body: { endpointId: "ep1" } }, res);
      sandbox.restore();
    });

    it("editor tree returns all children across continuation points", async function () {
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(obj) {
          this.body = obj;
        },
      };

      await browseRoute(
        { body: { endpointId: "ep1", nodeId: folderNodeId } },
        res,
      );

      expect(res.statusCode).to.equal(200);
      expect(res.body.references).to.have.length(TOTAL_CHILDREN);

      const names = res.body.references.map((r) => r.browseName);
      expect(new Set(names).size).to.equal(TOTAL_CHILDREN);
      expect(names).to.include("DB_249");

      // Variables got their DataType resolved via the real batch read
      const tag = res.body.references.find((r) => r.browseName === "Tag_0");
      expect(tag).to.exist;
      expect(tag.dataType).to.equal("Double");
    });
  });
});
