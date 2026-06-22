"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const PooledClientManager = require("../lib/opcua-pool");

// Stub manager so the pool can be tested without a real server. Each instance
// records calls and exposes a settable isConnected flag. Injected via the
// pool's optional ManagerClass constructor seam.
function makeFakeManagerClass() {
  const instances = [];
  class FakeManager {
    constructor(config) {
      this.config = config;
      this.isConnected = false;
      this.subscriptions = new Map();
      this._handlers = {};
      this.calls = [];
      // Spy-able async ops
      for (const m of [
        "read",
        "readMultiple",
        "readAttribute",
        "write",
        "writeMultiple",
        "callMethod",
        "historyRead",
        "browse",
        "translateBrowsePath",
        "getEndpoints",
        "createSubscription",
        "registerNodes",
        "unregisterNodes",
        "constructExtensionObject",
      ]) {
        this[m] = sinon.stub().callsFake(async () => {
          this.calls.push(m);
          return { op: m, member: this.id };
        });
      }
      this.connect = sinon.stub().callsFake(async () => {
        this.isConnected = true;
      });
      this.disconnect = sinon.stub().callsFake(async () => {
        this.isConnected = false;
      });
      this.reconnect = sinon.stub().callsFake(async () => {
        this.isConnected = true;
      });
      this.getSession = sinon.stub().returns({ id: this.id });
      this.id = instances.length;
      instances.push(this);
    }
    on(evt, cb) {
      (this._handlers[evt] = this._handlers[evt] || []).push(cb);
    }
    _isConnectionLostError(err) {
      return !!err && /Not connected|Session is no longer valid/.test(err.message);
    }
    _toOpcUaNodeId(nodeId) {
      return { toString: () => String(nodeId) };
    }
  }
  return { FakeManager, instances };
}

// Returns a factory that builds pools backed by fresh fake managers, plus the
// shared instances array so assertions can inspect created members.
function loadPool() {
  const { FakeManager, instances } = makeFakeManagerClass();
  const Pool = function (config, size) {
    return new PooledClientManager(config, size, FakeManager);
  };
  return { PooledClientManager: Pool, instances };
}

describe("PooledClientManager (opt-in session pool)", function () {
  it("creates N members with the same config; member 0 is primary", function () {
    const { PooledClientManager, instances } = loadPool();
    const pool = new PooledClientManager({ endpointUrl: "x" }, 3);
    expect(instances).to.have.lengthOf(3);
    expect(pool.members).to.have.lengthOf(3);
    expect(pool.primary).to.equal(pool.members[0]);
    expect(instances[0].config).to.deep.equal({ endpointUrl: "x" });
  });

  it("clamps pool size to a minimum of 2 (poolSize 1 never reaches here)", function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 1);
    expect(pool.size).to.equal(2);
  });

  it("connect() connects all members, primary first", async function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 3);
    await pool.connect();
    expect(pool.members.every((m) => m.connect.calledOnce)).to.be.true;
    expect(pool.isConnected).to.be.true;
  });

  it("disconnect() disconnects all members", async function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 3);
    await pool.connect();
    await pool.disconnect();
    expect(pool.members.every((m) => m.disconnect.calledOnce)).to.be.true;
  });

  it("round-robins stateless reads across connected members", async function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 3);
    await pool.connect();

    const used = [];
    for (let i = 0; i < 6; i++) {
      const r = await pool.read("ns=1;s=X");
      used.push(r.member);
    }
    // Each member used twice over 6 reads (round-robin).
    expect(used).to.deep.equal([0, 1, 2, 0, 1, 2]);
  });

  it("skips disconnected members when picking for stateless ops", async function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 3);
    await pool.connect();
    pool.members[1].isConnected = false; // member 1 is down

    const used = [];
    for (let i = 0; i < 4; i++) used.push((await pool.read("x")).member);
    expect(used).to.not.include(1);
    expect(used.every((m) => m === 0 || m === 2)).to.be.true;
  });

  it("routes session-bound ops (subscribe/register/getSession) to the primary", async function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 3);
    await pool.connect();

    await pool.createSubscription({});
    await pool.registerNodes([1]);
    await pool.unregisterNodes([1]);
    pool.getSession();

    expect(pool.primary.createSubscription.calledOnce).to.be.true;
    expect(pool.primary.registerNodes.calledOnce).to.be.true;
    expect(pool.primary.getSession.calledOnce).to.be.true;
    // Secondaries never receive session-bound ops.
    expect(pool.members[1].createSubscription.called).to.be.false;
    expect(pool.members[2].registerNodes.called).to.be.false;
  });

  it("isConnected reflects the primary member", async function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 2);
    expect(pool.isConnected).to.be.false;
    await pool.connect();
    expect(pool.isConnected).to.be.true;
    pool.primary.isConnected = false;
    expect(pool.isConnected).to.be.false;
  });

  it("reconnect() reconnects only disconnected members", async function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 3);
    await pool.connect();
    pool.members[2].isConnected = false;

    await pool.reconnect({ maxAttempts: 3 });
    expect(pool.members[0].reconnect.called).to.be.false; // was connected
    expect(pool.members[1].reconnect.called).to.be.false;
    expect(pool.members[2].reconnect.calledOnce).to.be.true; // was down
  });

  it("falls back to the primary when no member is connected", async function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 3);
    // none connected
    const r = await pool.read("x");
    expect(r.member).to.equal(0); // primary fallback
  });

  it("delegates connection-lost classification to a real-shaped helper", function () {
    const { PooledClientManager } = loadPool();
    const pool = new PooledClientManager({}, 2);
    expect(pool._isConnectionLostError(new Error("Not connected"))).to.be.true;
    expect(pool._isConnectionLostError(new Error("Invalid NodeId"))).to.be.false;
  });
});
