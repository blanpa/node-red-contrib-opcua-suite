"use strict";

/**
 * Multi-consumer reconnect integration test (DEBT-01)
 *
 * Boots a real OPCUAServer on a random port, drives two independent
 * OpcUaClientManager instances (simulating an opcua-client + opcua-event
 * pair attached to the same endpoint), forces a session drop on each,
 * and asserts both managers re-establish isConnected === true within 10s
 * via the new manager.reconnect() single-flight retry loop.
 *
 * Skipped unless LIVE_TESTS env var is set (D-18) — keeps default `npm test`
 * fast and deterministic. Single-flight unit coverage lives in
 * test/opcua-client-manager-reconnect.test.js.
 */

const { expect } = require("chai");
const {
  OPCUAServer,
  Variant,
  DataType,
  MessageSecurityMode,
  SecurityPolicy,
} = require("node-opcua");

const OpcUaClientManager = require("../lib/opcua-client-manager");

// Port range 49400-49500 — avoids overlap with integration-session-retry.test.js (48400-49400).
const PORT = 49400 + Math.floor(Math.random() * 100);
const ENDPOINT = `opc.tcp://localhost:${PORT}/UA/MultiConsumerTest`;

// Poll until predicate returns true or timeout (ms) elapses.
async function waitFor(pred, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

describe("Multi-consumer reconnect (DEBT-01)", function () {
  this.timeout(30000);

  let server;
  let skipAll = false;

  before(async function () {
    if (!process.env.LIVE_TESTS) {
      skipAll = true;
      this.skip();
      return;
    }

    server = new OPCUAServer({
      port: PORT,
      resourcePath: "/UA/MultiConsumerTest",
      maxAllowedSessionNumber: 50,
      securityModes: [MessageSecurityMode.None],
      securityPolicies: [SecurityPolicy.None],
      allowAnonymous: true,
    });

    await server.initialize();
    const addressSpace = server.engine.addressSpace;
    const ns = addressSpace.getOwnNamespace();

    ns.addVariable({
      organizedBy: addressSpace.rootFolder.objects,
      browseName: "MultiConsumerVar",
      nodeId: "s=MultiConsumerVar",
      dataType: DataType.Int32,
      value: new Variant({ dataType: DataType.Int32, value: 100 }),
    });

    await server.start();
  });

  after(async function () {
    if (skipAll || !server) return;
    await server.shutdown();
  });

  // ─── End-to-end recovery ───

  it("both managers recover after forced session drop", async function () {
    if (skipAll) return this.skip();

    const mgr1 = new OpcUaClientManager({
      endpointUrl: ENDPOINT,
      operationTimeout: 10000,
      maxReconnectAttempts: 5,
      reconnectDelay: 5000,
    });
    const mgr2 = new OpcUaClientManager({
      endpointUrl: ENDPOINT,
      operationTimeout: 10000,
      maxReconnectAttempts: 5,
      reconnectDelay: 5000,
    });

    await mgr1.connect();
    await mgr2.connect();
    expect(mgr1.isConnected).to.be.true;
    expect(mgr2.isConnected).to.be.true;

    // Verify initial reads work on both managers
    const r1 = await mgr1.read("ns=1;s=MultiConsumerVar");
    expect(r1.value).to.equal(100);

    // ─── force a session drop on each manager ───
    await mgr1.session.close();
    await mgr2.session.close();

    // ─── kick off reconnect via the new public API ───
    const recover1 = mgr1.reconnect({
      reason: "test-forced-drop",
      maxAttempts: 5,
      initialDelay: 200,
      maxDelay: 1000,
    });
    const recover2 = mgr2.reconnect({
      reason: "test-forced-drop",
      maxAttempts: 5,
      initialDelay: 200,
      maxDelay: 1000,
    });

    await Promise.all([recover1, recover2]);

    // ─── both managers must report connected within 10s ───
    const ok1 = await waitFor(() => mgr1.isConnected, 10000);
    const ok2 = await waitFor(() => mgr2.isConnected, 10000);
    expect(ok1, "mgr1 reconnected within 10s").to.be.true;
    expect(ok2, "mgr2 reconnected within 10s").to.be.true;

    // ─── post-recovery read on mgr1 succeeds ───
    const r2 = await mgr1.read("ns=1;s=MultiConsumerVar");
    expect(r2.value).to.equal(100);
    expect(r2.statusCode).to.match(/Good/);

    await mgr1.disconnect();
    await mgr2.disconnect();
  });
});
