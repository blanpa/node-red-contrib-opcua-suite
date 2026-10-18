"use strict";

/**
 * Editor admin routes of opcua-browse-client against a real in-process
 * OPC UA server:
 *  - POST /opcua-browse-client/method-arguments (used by the method dialog)
 *  - built-in DataType names in POST /opcua-browse-client/browse
 */

const { expect } = require("chai");
const path = require("path");
const { OPCUAServer, DataType, Variant, StatusCodes } = require("node-opcua");

const PORT = 47000 + Math.floor(Math.random() * 900);
const URL = `opc.tcp://localhost:${PORT}/UA/ArgsTest`;

function createRED(endpoints) {
  const routes = {};
  return {
    nodes: {
      createNode() {},
      registerType() {},
      getNode: (id) => endpoints[id] || null,
    },
    httpAdmin: {
      post(routePath, ...fns) {
        routes[routePath] = fns[fns.length - 1];
      },
      get(routePath, ...fns) {
        routes[routePath] = fns[fns.length - 1];
      },
    },
    _routes: routes,
  };
}

function call(route, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        resolve({ status: this.statusCode, data });
      },
    };
    route({ body }, res);
  });
}

describe("opcua-browse-client editor routes (real server)", function () {
  this.timeout(30000);
  let server, RED;

  before(async function () {
    server = new OPCUAServer({ port: PORT, resourcePath: "/UA/ArgsTest" });
    await server.initialize();
    const ns = server.engine.addressSpace.getOwnNamespace();
    const folder = ns.addObject({
      organizedBy: server.engine.addressSpace.rootFolder.objects,
      browseName: "Calc",
      nodeId: "s=Calc",
    });
    const scale = ns.addMethod(folder, {
      browseName: "Scale",
      nodeId: "s=Calc.Scale",
      inputArguments: [
        {
          name: "Value",
          dataType: DataType.Double,
          description: { text: "Input value" },
        },
        {
          name: "Factors",
          dataType: DataType.Int32,
          valueRank: 1,
          arrayDimensions: [0],
        },
      ],
      outputArguments: [{ name: "Result", dataType: DataType.Double }],
    });
    scale.bindMethod((args, ctx, cb) =>
      cb(null, {
        statusCode: StatusCodes.Good,
        outputArguments: [new Variant({ dataType: DataType.Double, value: 0 })],
      }),
    );
    const noArgs = ns.addMethod(folder, {
      browseName: "Reset",
      nodeId: "s=Calc.Reset",
    });
    noArgs.bindMethod((args, ctx, cb) =>
      cb(null, { statusCode: StatusCodes.Good, outputArguments: [] }),
    );
    ns.addVariable({
      componentOf: folder,
      browseName: "Gain",
      nodeId: "s=Calc.Gain",
      dataType: DataType.Double,
      value: new Variant({ dataType: DataType.Double, value: 1.5 }),
    });
    await server.start();

    RED = createRED({
      ep1: {
        id: "ep1",
        endpointUrl: URL,
        securityMode: "None",
        securityPolicy: "None",
        credentials: {},
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
  });

  after(async function () {
    if (RED) {
      await call(RED._routes["/opcua-browse-client/disconnect"], {
        endpointId: "ep1",
      });
    }
    if (server) await server.shutdown();
  });

  it("returns a method's input and output arguments", async function () {
    const res = await call(
      RED._routes["/opcua-browse-client/method-arguments"],
      {
        endpointId: "ep1",
        methodNodeId: "ns=1;s=Calc.Scale",
      },
    );
    expect(res.status).to.equal(200);
    expect(res.data.inputArguments).to.deep.equal([
      {
        name: "Value",
        dataType: "Double",
        valueRank: -1,
        description: "Input value",
      },
      { name: "Factors", dataType: "Int32", valueRank: 1, description: "" },
    ]);
    expect(res.data.outputArguments).to.deep.equal([
      { name: "Result", dataType: "Double", valueRank: -1, description: "" },
    ]);
  });

  it("returns empty lists for a method without arguments", async function () {
    const res = await call(
      RED._routes["/opcua-browse-client/method-arguments"],
      {
        endpointId: "ep1",
        methodNodeId: "ns=1;s=Calc.Reset",
      },
    );
    expect(res.status).to.equal(200);
    expect(res.data).to.deep.equal({ inputArguments: [], outputArguments: [] });
  });

  it("reports an endpoint that is not deployed", async function () {
    const res = await call(
      RED._routes["/opcua-browse-client/method-arguments"],
      {
        endpointId: "missing",
        methodNodeId: "ns=1;s=Calc.Scale",
      },
    );
    expect(res.status).to.equal(404);
    expect(res.data.error).to.match(/Deploy first/);
  });

  it("rejects a request without methodNodeId", async function () {
    const res = await call(
      RED._routes["/opcua-browse-client/method-arguments"],
      {
        endpointId: "ep1",
      },
    );
    expect(res.status).to.equal(400);
  });

  it("names built-in variable DataTypes without extra lookups", async function () {
    // Count the reads of a BrowseName attribute: a built-in type must come
    // from the lookup table, not from reading the DataType node's name.
    const OpcUaClientManager = require("../lib/opcua-client-manager");
    const { AttributeIds } = require("node-opcua");
    const original = OpcUaClientManager.prototype.getSession;
    let browseNameReads = 0;
    OpcUaClientManager.prototype.getSession = function () {
      const session = original.call(this);
      if (session && !session.__counted) {
        const read = session.read.bind(session);
        session.read = (nodes, ...rest) => {
          const list = Array.isArray(nodes) ? nodes : [nodes];
          browseNameReads += list.filter(
            (n) => n && n.attributeId === AttributeIds.BrowseName,
          ).length;
          return read(nodes, ...rest);
        };
        session.__counted = true;
      }
      return session;
    };
    try {
      const res = await call(RED._routes["/opcua-browse-client/browse"], {
        endpointId: "ep1",
        nodeId: "ns=1;s=Calc",
      });
      expect(res.status).to.equal(200);
      const gain = res.data.references.find((r) => r.browseName === "Gain");
      expect(gain).to.exist;
      expect(gain.dataType).to.equal("Double");
      expect(browseNameReads).to.equal(0);
    } finally {
      OpcUaClientManager.prototype.getSession = original;
    }
  });
});
