"use strict";

/**
 * Integration: an opcua-client subscription must survive a real OPC UA
 * server restart.
 *
 * node-opcua re-establishes the secure channel on its own and then repairs
 * the session — re-activating it, or creating a replacement and recreating
 * every subscription on it. The manager used to race that repair by opening
 * a second session in "after_reconnection" and closing the one node-opcua was
 * repairing. The repair then failed forever, the replayed subscribes landed
 * on a session that was itself mid-reconnect, and data stopped for good while
 * the node status showed "connected". Mock-based tests cannot see this: it
 * only happens against node-opcua's real reconnection machinery.
 */

const { expect } = require("chai");
const { OPCUAServer, Variant, DataType } = require("node-opcua");
const {
  createRED,
  loadNode,
  makeNode,
  closeNode,
  input: deliver,
  sleep,
  waitFor,
} = require("./helpers/live-node-harness");

const PORT = 49500 + Math.floor(Math.random() * 400);
const ENDPOINT = `opc.tcp://localhost:${PORT}/UA/RestartTest`;

let counter = 0;

async function startServer() {
  const server = new OPCUAServer({
    port: PORT,
    resourcePath: "/UA/RestartTest",
    allowAnonymous: true,
  });
  await server.initialize();
  const addressSpace = server.engine.addressSpace;
  const variable = addressSpace.getOwnNamespace().addVariable({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "Counter",
    nodeId: "s=Counter",
    dataType: DataType.Int32,
    minimumSamplingInterval: 100,
  });
  server._tick = setInterval(
    () =>
      variable.setValueFromSource(
        new Variant({ dataType: DataType.Int32, value: ++counter }),
      ),
    100,
  );
  await server.start();
  return server;
}

async function stopServer(server) {
  clearInterval(server._tick);
  await server.shutdown(0);
}

describe("Integration: subscription survives an OPC UA server restart", function () {
  this.timeout(90000);

  let server, endpoint, client;

  beforeEach(async function () {
    server = await startServer();
    const RED = createRED();
    loadNode(RED, "opcua-endpoint.js");
    loadNode(RED, "opcua-client.js");

    endpoint = makeNode(RED, "opcua-endpoint", {
      id: "ep",
      endpointUrl: ENDPOINT,
      securityMode: "None",
      securityPolicy: "None",
    });
    client = makeNode(RED, "opcua-client", { id: "cl", endpoint: "ep" });
  });

  afterEach(async function () {
    if (client) await closeNode(client);
    if (endpoint) await closeNode(endpoint);
    if (server) await stopServer(server);
  });

  const values = () =>
    client.sent.filter(
      (m) => m.operation === "subscribe" && typeof m.payload === "number",
    );

  const input = (msg) => deliver(client, msg);

  async function subscribeAndRestart({ readDuringOutage }) {
    await input({ topic: "ns=1;s=Counter", operation: "subscribe" });
    expect(await waitFor(() => values().length >= 3, 10000)).to.equal(
      true,
      "no values before the restart",
    );

    let poller = null;
    if (readDuringOutage) {
      poller = setInterval(
        () => input({ topic: "ns=1;s=Counter", operation: "read" }),
        500,
      );
    }
    try {
      await stopServer(server);
      server = null;
      await sleep(2000);
      server = await startServer();

      const mark = values().length;
      const recovered = await waitFor(() => values().length >= mark + 5, 45000);
      expect(recovered).to.equal(
        true,
        `subscription delivered ${values().length - mark} values after the restart`,
      );
      expect(client._status.fill).to.not.equal("red");
    } finally {
      if (poller) clearInterval(poller);
    }
  }

  it("resumes delivery via node-opcua's in-place session repair", async function () {
    await subscribeAndRestart({ readDuringOutage: false });
  });

  it("resumes delivery when reads during the outage force a full reconnect", async function () {
    await subscribeAndRestart({ readDuringOutage: true });
  });
});
