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
const path = require("path");
const { OPCUAServer, Variant, DataType } = require("node-opcua");

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

// Minimal RED runtime: real endpoint + client nodes, recorded sends.
function createRED() {
  const types = {};
  const nodes = {};
  return {
    nodes: {
      createNode(node, config) {
        Object.assign(node, config);
        node._events = {};
        node.on = (event, cb) =>
          (node._events[event] = node._events[event] || []).push(cb);
        node.status = (s) => {
          node._status = s;
        };
        node.log = () => {};
        node.warn = () => {};
        node.error = () => {};
        node.sent = [];
        node.send = (msg) => node.sent.push(msg);
      },
      registerType(name, ctor) {
        types[name] = ctor;
      },
      getNode: (id) => nodes[id],
    },
    _types: types,
    _nodes: nodes,
  };
}

function loadNode(RED, file) {
  const p = path.resolve(__dirname, "..", "nodes", file);
  delete require.cache[require.resolve(p)];
  require(p)(RED);
}

async function closeNode(node) {
  for (const cb of node._events.close || []) {
    await new Promise((resolve) => {
      if (cb.length >= 2) cb.call(node, false, resolve);
      else if (cb.length === 1) cb.call(node, resolve);
      else Promise.resolve(cb.call(node)).then(resolve, resolve);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

describe("Integration: subscription survives an OPC UA server restart", function () {
  this.timeout(90000);

  let server, endpoint, client;

  beforeEach(async function () {
    server = await startServer();
    const RED = createRED();
    loadNode(RED, "opcua-endpoint.js");
    loadNode(RED, "opcua-client.js");

    endpoint = {};
    RED._types["opcua-endpoint"].call(endpoint, {
      id: "ep",
      endpointUrl: ENDPOINT,
      securityMode: "None",
      securityPolicy: "None",
    });
    endpoint.credentials = {};
    RED._nodes.ep = endpoint;

    client = {};
    RED._types["opcua-client"].call(client, { id: "cl", endpoint: "ep" });
    RED._nodes.cl = client;
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

  function input(msg) {
    return new Promise((resolve) =>
      client._events.input[0](
        msg,
        (m) => client.sent.push(m),
        () => resolve(),
      ),
    );
  }

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
