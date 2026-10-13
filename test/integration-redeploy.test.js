"use strict";

/**
 * Integration: redeploying while the OPC UA server is unreachable.
 *
 * Node-RED waits at most 15 s for a node's close handler ("Close timed out")
 * and then starts the next deploy anyway. Against a real server this used to
 * fail two ways:
 *
 * - Endpoint unreachable at deploy: the manager's disconnect() waited out the
 *   in-flight connect, which node-opcua keeps retrying for ~40 s with the
 *   defaults. Its catch then armed scheduleReconnect(), so the "closed"
 *   manager reconnected once the server appeared and opened a session no
 *   node owned.
 * - Server gone while subscribed: node-opcua holds terminate() until the
 *   channel is back, so the close hung indefinitely.
 */

const { expect } = require("chai");
const { OPCUAServer, Variant, DataType } = require("node-opcua");
const {
  createRED,
  loadNode,
  makeNode,
  closeNode,
  input,
  sleep,
  waitFor,
} = require("./helpers/live-node-harness");

const PORT = 49900 + Math.floor(Math.random() * 90);
const ENDPOINT = `opc.tcp://localhost:${PORT}/UA/RedeployTest`;

async function startServer() {
  const server = new OPCUAServer({
    port: PORT,
    resourcePath: "/UA/RedeployTest",
    allowAnonymous: true,
  });
  await server.initialize();
  const addressSpace = server.engine.addressSpace;
  addressSpace.getOwnNamespace().addVariable({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "Value",
    nodeId: "s=Value",
    dataType: DataType.Int32,
    value: new Variant({ dataType: DataType.Int32, value: 7 }),
  });
  await server.start();
  return server;
}

function deploy() {
  const RED = createRED();
  loadNode(RED, "opcua-endpoint.js");
  loadNode(RED, "opcua-client.js");
  const endpoint = makeNode(RED, "opcua-endpoint", {
    id: "ep",
    endpointUrl: ENDPOINT,
  });
  const client = makeNode(RED, "opcua-client", { id: "cl", endpoint: "ep" });
  return { endpoint, client };
}

async function timedClose({ client, endpoint }) {
  const t0 = Date.now();
  await closeNode(client);
  await closeNode(endpoint);
  return Date.now() - t0;
}

describe("Integration: redeploy while the OPC UA server is unreachable", function () {
  this.timeout(60000);

  let server = null;

  afterEach(async function () {
    if (server) await server.shutdown(0);
    server = null;
  });

  it("closes fast while connecting, and the closed connection stays closed", async function () {
    // Nothing listens on PORT yet: autoConnect starts a connect that
    // node-opcua keeps retrying.
    const flow = deploy();
    await sleep(500);

    const elapsed = await timedClose(flow);
    expect(elapsed).to.be.below(3000);

    // The server shows up after the redeploy. The old manager must not
    // reconnect behind everyone's back (default reconnectDelay is 5 s).
    server = await startServer();
    await sleep(7000);
    expect(server.engine.currentSessionCount).to.equal(0);
  });

  it("closes a subscribed client within bounds after the server went away", async function () {
    server = await startServer();
    const flow = deploy();
    await input(flow.client, { topic: "ns=1;s=Value", operation: "subscribe" });
    expect(
      await waitFor(() => flow.client.sent.some((m) => m.payload === 7), 10000),
    ).to.equal(true);

    await server.shutdown(0);
    server = null;
    await sleep(2000);

    const elapsed = await timedClose(flow);
    expect(elapsed).to.be.below(5000);
  });
});
