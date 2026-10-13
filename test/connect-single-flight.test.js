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

    await Promise.all([
      mgr.connect(),
      mgr.connect(),
      mgr.connect(),
      mgr.connect(),
    ]);

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
    const counters = stubOpcUaClient(sandbox, {
      connectDelay: 30,
      sessionDelay: 30,
    });
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });

    const connecting = mgr.connect().then(
      () => null,
      (err) => err,
    );
    // Redeploy lands while the connect is still in flight.
    const closing = mgr.disconnect();
    const [connectErr] = await Promise.all([connecting, closing]);

    // The attempt was cancelled, and whatever it opened was released.
    expect(connectErr).to.be.an("error");
    expect(connectErr.message).to.equal("Connection closed");
    expect(counters.sessionsOpened).to.equal(counters.sessionsClosed);
    expect(mgr.isConnected).to.equal(false);
    expect(mgr.client).to.equal(null);
    expect(mgr.session).to.equal(null);
  });

  it("disconnect() aborts a connect still retrying an unreachable endpoint", async function () {
    // node-opcua retries an unreachable endpoint inside client.connect() for
    // up to maxReconnectAttempts (~40 s with the defaults) and aborts that
    // retry loop when the client is disconnected. Model exactly that.
    const counters = { created: 0, disconnected: 0, sessions: 0 };
    sandbox.stub(OPCUAClient, "create").callsFake(() => {
      counters.created++;
      const client = new EventEmitter();
      let fail;
      client.connect = () =>
        new Promise((resolve, reject) => {
          fail = reject;
        });
      client.disconnect = async () => {
        counters.disconnected++;
        fail(new Error("connection may have been rejected by server"));
      };
      client.createSession = async () => {
        counters.sessions++;
        return { close: async () => {} };
      };
      return client;
    });
    const mgr = new OpcUaClientManager({
      endpointUrl: "opc.tcp://x:4840",
      reconnectDelay: 20,
    });
    const errors = [];
    mgr.on("error", (e) => errors.push(e));

    const connecting = mgr.connect().catch((e) => e);
    await new Promise((r) => setImmediate(r));
    const t0 = Date.now();
    await mgr.disconnect();

    expect(Date.now() - t0).to.be.below(1000);
    expect((await connecting).message).to.equal("Connection closed");
    expect(counters.disconnected).to.equal(1);
    // Closing is not an error, and nothing comes back afterwards: the old
    // code's catch armed scheduleReconnect(), which reconnected the closed
    // manager and opened a session no node owned.
    expect(errors).to.deep.equal([]);
    expect(mgr.reconnectTimer).to.equal(null);
    await new Promise((r) => setTimeout(r, 100));
    expect(counters.created).to.equal(1);
    expect(counters.sessions).to.equal(0);
  });

  it("disconnect() stops a running reconnect() retry loop", async function () {
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });
    const connect = sandbox
      .stub(mgr, "connect")
      .rejects(new Error("connection may have been rejected"));

    const looping = mgr
      .reconnect({ maxAttempts: 0, initialDelay: 50 })
      .catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    await mgr.disconnect();

    expect((await looping).message).to.equal("reconnect aborted");
    const calls = connect.callCount;
    await new Promise((r) => setTimeout(r, 150));
    expect(connect.callCount).to.equal(calls);
  });

  it("disconnect() while offline drops the client before terminating subscriptions", async function () {
    // node-opcua holds subscription.terminate() until the channel is back,
    // so an offline close used to hang until Node-RED gave up on it.
    const order = [];
    const mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://x:4840" });
    let release;
    const held = new Promise((r) => (release = r));
    mgr.client = new EventEmitter();
    mgr.client.disconnect = async () => {
      order.push("client.disconnect");
      release();
    };
    mgr.session = {
      isReconnecting: true,
      close: async () => order.push("session.close"),
    };
    mgr.subscriptions.set(1, {
      terminate: async () => {
        await held;
        order.push("subscription.terminate");
      },
    });
    mgr.isConnected = false;

    const t0 = Date.now();
    await mgr.disconnect();

    expect(Date.now() - t0).to.be.below(1000);
    expect(order).to.deep.equal([
      "client.disconnect",
      "subscription.terminate",
      "session.close",
    ]);
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
    const pool = new PooledClientManager(
      { endpointUrl: "opc.tcp://x:4840" },
      2,
    );

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
