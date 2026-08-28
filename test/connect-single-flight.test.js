"use strict";

/**
 * Regression tests for issue #17 — "Connection Handling/Cleanup".
 *
 * Every consumer node calls connect() on the SHARED manager when its flow is
 * deployed. Before the single-flight lock those calls all passed the
 * `isConnected` check in the same tick and each built its own OPCUAClient +
 * session; only the last assignment survived in this.client/this.session, so
 * every earlier session was orphaned — still open on the server, kept alive by
 * `keepSessionAlive`, and invisible to disconnect(). Each redeploy leaked
 * another round until the server answered "connection was rejected".
 */

const { expect } = require("chai");
const sinon = require("sinon");
const { EventEmitter } = require("events");
const { OPCUAClient } = require("node-opcua");

const OpcUaClientManager = require("../lib/opcua-client-manager");
const PooledClientManager = require("../lib/opcua-pool");

/**
 * Replaces OPCUAClient.create with a fake that counts how many sessions are
 * opened and how many are closed again, so a leak is directly observable.
 */
function stubOpcUaClient(sandbox, opts = {}) {
  const counters = {
    clientsCreated: 0,
    sessionsOpened: 0,
    sessionsClosed: 0,
    clientsDisconnected: 0,
  };

  sandbox.stub(OPCUAClient, "create").callsFake(() => {
    const id = ++counters.clientsCreated;
    const client = new EventEmitter();
    client.id = id;
    client.connect = async () => {
      await new Promise((r) => setTimeout(r, opts.connectDelay ?? 5));
    };
    client.createSession = async () => {
      await new Promise((r) => setTimeout(r, opts.sessionDelay ?? 5));
      counters.sessionsOpened++;
      return {
        id: `session-${id}`,
        isReconnecting: false,
        hasBeenClosed: () => false,
        close: async () => {
          counters.sessionsClosed++;
        },
      };
    };
    client.disconnect = async () => {
      counters.clientsDisconnected++;
    };
    return client;
  });

  return counters;
}

describe("OpcUaClientManager.connect single-flight (issue #17)", function () {
  let sandbox;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
  });

  afterEach(function () {
    sandbox.restore();
  });

  it("N concurrent connect() calls open exactly ONE session", async function () {
    const counters = stubOpcUaClient(sandbox);
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });

    await Promise.all([mgr.connect(), mgr.connect(), mgr.connect(), mgr.connect()]);

    expect(counters.clientsCreated).to.equal(1);
    expect(counters.sessionsOpened).to.equal(1);
    expect(mgr.isConnected).to.equal(true);
  });

  it("concurrent callers share the exact same in-flight promise", function () {
    stubOpcUaClient(sandbox);
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });

    const p1 = mgr.connect();
    const p2 = mgr.connect();
    expect(p1).to.equal(p2);
    return p1;
  });

  it("disconnect() after a concurrent deploy leaves NO session open", async function () {
    const counters = stubOpcUaClient(sandbox);
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });

    // three client nodes deploying against one shared endpoint
    await Promise.all([mgr.connect(), mgr.connect(), mgr.connect()]);
    await mgr.disconnect();

    expect(counters.sessionsOpened - counters.sessionsClosed).to.equal(0);
  });

  it("repeated deploy/redeploy cycles do not accumulate sessions", async function () {
    const counters = stubOpcUaClient(sandbox);

    for (let cycle = 0; cycle < 5; cycle++) {
      const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });
      await Promise.all([mgr.connect(), mgr.connect(), mgr.connect()]);
      await mgr.disconnect();
    }

    expect(counters.sessionsOpened).to.equal(5);
    expect(counters.sessionsClosed).to.equal(5);
  });

  it("the lock is released so a later connect() can start a fresh attempt", async function () {
    const counters = stubOpcUaClient(sandbox);
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });

    await mgr.connect();
    await mgr.disconnect();
    await mgr.connect();

    expect(counters.sessionsOpened).to.equal(2);
    expect(mgr._connectPromise).to.equal(null);
  });

  it("disconnect() racing an in-flight connect() still tears the session down", async function () {
    const counters = stubOpcUaClient(sandbox, { connectDelay: 30, sessionDelay: 30 });
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });

    const connecting = mgr.connect();
    // Redeploy lands while the connect is still in flight.
    const closing = mgr.disconnect();
    await Promise.all([connecting, closing]);

    expect(counters.sessionsOpened).to.equal(1);
    expect(counters.sessionsClosed).to.equal(1);
    expect(mgr.isConnected).to.equal(false);
  });

  it("a session refused after the channel is up does not leak the channel", async function () {
    const counters = { clients: 0, disconnected: 0 };
    sandbox.stub(OPCUAClient, "create").callsFake(() => {
      counters.clients++;
      const client = new EventEmitter();
      client.connect = async () => {};
      client.createSession = async () => {
        throw new Error("BadTooManySessions");
      };
      client.disconnect = async () => {
        counters.disconnected++;
      };
      return client;
    });

    const mgr = new OpcUaClientManager({
      endpointUrl: "opc.tcp://x:4840",
      maxReconnectAttempts: 0,
    });

    let thrown = null;
    try {
      await mgr.connect();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).to.be.an("error");
    expect(counters.clients).to.equal(1);
    // the secure channel opened by client.connect() was closed again
    expect(counters.disconnected).to.equal(1);
  });

  it("emit('error') never throws even without a consumer listener", function () {
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });
    expect(() => mgr.emit("error", new Error("boom"))).to.not.throw();
  });
});

describe("PooledClientManager.connect (issue #17)", function () {
  let sandbox;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
  });

  afterEach(function () {
    sandbox.restore();
  });

  it("a pool of N opens exactly N sessions under concurrent connects", async function () {
    const counters = stubOpcUaClient(sandbox);
    const pool = new PooledClientManager({ endpointUrl: "opc.tcp://x:4840" }, 2);

    await Promise.all([pool.connect(), pool.connect(), pool.connect()]);

    expect(counters.sessionsOpened).to.equal(2);

    await pool.disconnect();
    expect(counters.sessionsOpened - counters.sessionsClosed).to.equal(0);
  });

  it("forwards arrayType (5th arg) to the member manager", function () {
    const member = { isConnected: true, write: sinon.stub().resolves({}) };
    const pool = Object.create(PooledClientManager.prototype);
    pool._pickMember = () => member;

    pool.write("ns=2;s=Arr", [1, 2, 3], "Int32", null, "Array");

    expect(member.write.firstCall.args).to.deep.equal([
      "ns=2;s=Arr",
      [1, 2, 3],
      "Int32",
      null,
      "Array",
    ]);
  });
});
