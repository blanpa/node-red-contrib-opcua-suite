"use strict";

/**
 * Integration: a flow deployed while the OPC UA server is offline connects
 * once the server comes up — however long that takes.
 *
 * The background reconnect used to give up after maxReconnectAttempts
 * (~8 min with the defaults). A flow that only subscribes never sends an
 * input message that would trigger a connect, so it then stayed
 * disconnected for good until the next redeploy — e.g. a PLC that was off
 * over a weekend.
 */

const { expect } = require("chai");
const { OPCUAServer, Variant, DataType } = require("node-opcua");
const {
  createRED,
  loadNode,
  makeNode,
  closeNode,
  waitFor,
} = require("./helpers/live-node-harness");

const PORT = 49990 + Math.floor(Math.random() * 9);
const ENDPOINT = `opc.tcp://localhost:${PORT}/UA/OfflineTest`;

async function startServer() {
  const server = new OPCUAServer({
    port: PORT,
    resourcePath: "/UA/OfflineTest",
    allowAnonymous: true,
  });
  await server.initialize();
  const addressSpace = server.engine.addressSpace;
  addressSpace.getOwnNamespace().addVariable({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "Value",
    nodeId: "s=Value",
    dataType: DataType.Int32,
    value: new Variant({ dataType: DataType.Int32, value: 42 }),
  });
  await server.start();
  return server;
}

describe("Integration: server offline at deploy", function () {
  this.timeout(90000);

  let server = null;
  let flow = null;

  afterEach(async function () {
    if (flow) {
      await closeNode(flow.browseClient);
      await closeNode(flow.endpoint);
    }
    if (server) await server.shutdown(0);
    flow = null;
    server = null;
  });

  it("a subscribe-only flow connects after the old give-up limit", async function () {
    const RED = createRED();
    loadNode(RED, "opcua-endpoint.js");
    loadNode(RED, "opcua-browse-client.js");
    const endpoint = makeNode(RED, "opcua-endpoint", {
      id: "ep",
      endpointUrl: ENDPOINT,
    });
    const browseClient = makeNode(RED, "opcua-browse-client", {
      id: "bc",
      endpoint: "ep",
      mode: "subscribe",
      publishInterval: 500,
      // Small values so the old give-up point is reached quickly.
      maxReconnectAttempts: 2,
      reconnectDelay: 1000,
      selectedItems: [
        { nodeId: "ns=1;s=Value", nodeClass: "Variable", browseName: "Value" },
      ],
    });
    flow = { endpoint, browseClient };
    const mgr = endpoint._sharedManager;

    // Past the point where the previous code stopped scheduling attempts.
    expect(await waitFor(() => mgr.reconnectAttempts > 3, 40000)).to.equal(
      true,
      "background reconnect stopped retrying",
    );

    server = await startServer();
    const delivered = await waitFor(
      () => browseClient.sent.some((m) => m.payload === 42),
      40000,
    );
    expect(delivered).to.equal(true, "no value after the server came up");
    expect(mgr.isConnected).to.equal(true);
  });
});
