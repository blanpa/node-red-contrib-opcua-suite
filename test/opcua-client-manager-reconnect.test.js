"use strict";

/**
 * Unit tests for OpcUaClientManager.reconnect() and _isConnectionLostError()
 * — DEBT-01 (Phase 1 / Plan 1)
 *
 * Covers:
 * - single-flight: two concurrent reconnect() calls share the same Promise
 * - maxAttempts: respects opt; throws after exhausted attempts
 * - infinite mode (maxAttempts=0): loops until connect() succeeds
 * - _isConnectionLostError: known strings → true; non-connection errors → false
 * - events: "reconnecting" before loop, "reconnected" on success, "reconnect_failed" on exhaustion
 * - _reconnectPromise nulled in .finally() so a second sequential call gets a fresh promise
 * - AbortSignal: aborted signal throws "reconnect aborted"
 */

const { expect } = require("chai");
const sinon = require("sinon");

const OpcUaClientManager = require("../lib/opcua-client-manager");

function makeManager(overrides = {}) {
  const mgr = new OpcUaClientManager({
    endpointUrl: "opc.tcp://localhost:4840/UA/Test",
    maxReconnectAttempts: overrides.maxReconnectAttempts ?? 2,
    reconnectDelay: overrides.reconnectDelay ?? 100,
  });
  return mgr;
}

describe("OpcUaClientManager.reconnect / _isConnectionLostError (DEBT-01)", function () {
  this.timeout(10000);

  // ─── single-flight ───

  describe("single-flight reconnect()", function () {
    it("two concurrent calls share the exact same Promise instance", async function () {
      const mgr = makeManager();
      // connect resolves on the second tick so concurrent calls overlap
      let resolveConnect;
      mgr.connect = sinon.stub().callsFake(
        () =>
          new Promise((resolve) => {
            resolveConnect = () => {
              mgr.isConnected = true;
              resolve();
            };
          }),
      );

      const p1 = mgr.reconnect({ initialDelay: 1, maxDelay: 1 });
      const p2 = mgr.reconnect({ initialDelay: 1, maxDelay: 1 });

      // Same promise — single-flight lock
      expect(p1).to.equal(p2);

      // Resolve the in-flight connect so the test exits
      resolveConnect();
      await p1;
      expect(mgr.connect.callCount).to.equal(1);
    });

    it("nulls _reconnectPromise in .finally() so a second sequential call gets a fresh promise", async function () {
      const mgr = makeManager();
      mgr.connect = sinon.stub().callsFake(async () => {
        mgr.isConnected = true;
      });

      const p1 = mgr.reconnect({ initialDelay: 1, maxDelay: 1 });
      await p1;
      expect(mgr._reconnectPromise).to.be.null;

      const p2 = mgr.reconnect({ initialDelay: 1, maxDelay: 1 });
      // Different promise instance — first one was cleared
      expect(p1).to.not.equal(p2);
      await p2;
      expect(mgr.connect.callCount).to.equal(2);
    });
  });

  // ─── maxAttempts ───

  describe("maxAttempts option", function () {
    it("respects maxAttempts=1: throws after one failed attempt", async function () {
      const mgr = makeManager();
      mgr.connect = sinon.stub().rejects(new Error("Not connected"));

      let caught = null;
      try {
        await mgr.reconnect({ maxAttempts: 1, initialDelay: 1, maxDelay: 1 });
      } catch (e) {
        caught = e;
      }
      expect(caught).to.be.an("error");
      expect(caught.message).to.match(/Not connected/);
      expect(mgr.connect.callCount).to.equal(1);
    });

    it("respects maxAttempts=3: tries three times then throws", async function () {
      const mgr = makeManager();
      mgr.connect = sinon.stub().rejects(new Error("connection refused"));

      let caught = null;
      try {
        await mgr.reconnect({ maxAttempts: 3, initialDelay: 1, maxDelay: 1 });
      } catch (e) {
        caught = e;
      }
      expect(caught).to.be.an("error");
      expect(mgr.connect.callCount).to.equal(3);
    });

    it("with maxAttempts=0 (infinite): loops until connect() succeeds", async function () {
      const mgr = makeManager();
      let calls = 0;
      mgr.connect = sinon.stub().callsFake(async () => {
        calls++;
        if (calls < 4) throw new Error("temp fail");
        mgr.isConnected = true;
      });

      await mgr.reconnect({ maxAttempts: 0, initialDelay: 1, maxDelay: 1 });
      expect(calls).to.equal(4);
      expect(mgr.isConnected).to.be.true;
    });

    it("emits 'reconnecting' before first attempt and 'reconnected' on success", async function () {
      const mgr = makeManager();
      mgr.connect = sinon.stub().callsFake(async () => {
        mgr.isConnected = true;
      });

      const events = [];
      mgr.on("reconnecting", () => events.push("reconnecting"));
      mgr.on("reconnected", () => events.push("reconnected"));
      mgr.on("reconnect_failed", () => events.push("reconnect_failed"));

      await mgr.reconnect({ maxAttempts: 1, initialDelay: 1, maxDelay: 1 });

      expect(events).to.deep.equal(["reconnecting", "reconnected"]);
    });

    it("emits 'reconnect_failed' when maxAttempts exhausted", async function () {
      const mgr = makeManager();
      mgr.connect = sinon.stub().rejects(new Error("connection refused"));

      const events = [];
      mgr.on("reconnecting", () => events.push("reconnecting"));
      mgr.on("reconnected", () => events.push("reconnected"));
      mgr.on("reconnect_failed", () => events.push("reconnect_failed"));

      try {
        await mgr.reconnect({ maxAttempts: 2, initialDelay: 1, maxDelay: 1 });
      } catch (_e) {
        /* expected */
      }

      expect(events).to.deep.equal(["reconnecting", "reconnect_failed"]);
    });

    it("AbortSignal: aborted signal throws 'reconnect aborted'", async function () {
      const mgr = makeManager();
      mgr.connect = sinon.stub().rejects(new Error("connection refused"));

      const ac = new AbortController();
      ac.abort();

      let caught = null;
      try {
        await mgr.reconnect({
          maxAttempts: 5,
          initialDelay: 1,
          maxDelay: 1,
          signal: ac.signal,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).to.be.an("error");
      expect(caught.message).to.match(/reconnect aborted/);
    });
  });

  // ─── _isConnectionLostError ───

  describe("_isConnectionLostError(err)", function () {
    let mgr;
    beforeEach(function () {
      mgr = makeManager();
    });

    it("returns true for 'Session is no longer valid'", function () {
      expect(mgr._isConnectionLostError(new Error("Session is no longer valid")))
        .to.be.true;
    });

    it("returns true for 'Not connected'", function () {
      expect(mgr._isConnectionLostError(new Error("Not connected"))).to.be.true;
    });

    it("returns true for messages containing 'premature disconnection'", function () {
      expect(
        mgr._isConnectionLostError(
          new Error("Server closed: premature disconnection occurred"),
        ),
      ).to.be.true;
    });

    it("returns true for messages containing 'Secure Channel Closed'", function () {
      expect(
        mgr._isConnectionLostError(new Error("error: Secure Channel Closed")),
      ).to.be.true;
    });

    it("returns true for messages containing 'connection may have been rejected'", function () {
      expect(
        mgr._isConnectionLostError(
          new Error("BadConnect — connection may have been rejected"),
        ),
      ).to.be.true;
    });

    it("returns true for messages containing 'Server end point'", function () {
      expect(
        mgr._isConnectionLostError(
          new Error("Server end point unreachable"),
        ),
      ).to.be.true;
    });

    it("returns true for messages containing 'socket has been disconnected'", function () {
      expect(
        mgr._isConnectionLostError(
          new Error("transport: socket has been disconnected"),
        ),
      ).to.be.true;
    });

    it("returns false for 'timeout reading'", function () {
      expect(mgr._isConnectionLostError(new Error("timeout reading"))).to.be
        .false;
    });

    it("returns false for 'Invalid NodeId'", function () {
      expect(mgr._isConnectionLostError(new Error("Invalid NodeId"))).to.be
        .false;
    });

    it("returns false for null / undefined / no-message error", function () {
      expect(mgr._isConnectionLostError(null)).to.be.false;
      expect(mgr._isConnectionLostError(undefined)).to.be.false;
      expect(mgr._isConnectionLostError({})).to.be.false;
    });
  });
});
