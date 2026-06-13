"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const dgram = require("dgram");
const EventEmitter = require("events");

const { BaseTransport } = require("../../lib/transports/base-transport");
const { UdpTransport } = require("../../lib/transports/udp-transport");

// Unique-ish port per test to avoid collisions across repeated runs.
function freshPort() {
  return 45678 + Math.floor(Math.random() * 5000);
}

const GROUP = "239.0.0.1";

describe("UdpTransport — TRP-01", function () {

  let transport;

  afterEach(async function () {
    if (transport) {
      try {
        await transport.close();
      } catch (e) {
        /* ignore teardown errors */
      }
      transport = null;
    }
    sinon.restore();
  });

  it("extends BaseTransport (instanceof check)", function () {
    transport = new UdpTransport({ port: freshPort(), multicastGroup: GROUP });
    expect(transport instanceof BaseTransport).to.equal(true);
  });

  it("connect() resolves and emits 'connected' once", async function () {
    transport = new UdpTransport({ port: freshPort(), multicastGroup: GROUP });
    const spy = sinon.spy();
    transport.on("connected", spy);
    await transport.connect();
    expect(spy.calledOnce).to.equal(true, "'connected' should fire exactly once");
    expect(transport._socket).to.not.equal(null);
  });

  it("close() resolves and emits 'disconnected' once; transport._socket becomes null", async function () {
    transport = new UdpTransport({ port: freshPort(), multicastGroup: GROUP });
    const spy = sinon.spy();
    transport.on("disconnected", spy);
    await transport.connect();
    await transport.close();
    expect(spy.calledOnce).to.equal(true, "'disconnected' should fire exactly once");
    expect(transport._socket).to.equal(null);
  });

  it("close() called twice is idempotent (does not throw, second resolves immediately)", async function () {
    transport = new UdpTransport({ port: freshPort(), multicastGroup: GROUP });
    await transport.connect();
    await transport.close();
    // Second close must resolve without throwing.
    await transport.close();
    expect(transport._socket).to.equal(null);
  });

  it("send(Buffer) sends one packet to (port, multicastGroup)", async function () {
    const port = freshPort();
    transport = new UdpTransport({ port, multicastGroup: GROUP });
    await transport.connect();
    const sendSpy = sinon.stub(transport._socket, "send").callsFake((buf, p, g, cb) => {
      if (cb) cb(null);
    });
    const payload = Buffer.from([1, 2, 3]);
    transport.send(payload);
    expect(sendSpy.calledOnce).to.equal(true);
    const args = sendSpy.firstCall.args;
    expect(args[0]).to.equal(payload);
    expect(args[1]).to.equal(port);
    expect(args[2]).to.equal(GROUP);
    expect(args[3]).to.be.a("function");
  });

  it("send(Buffer[]) sends one packet per chunk in array order", async function () {
    transport = new UdpTransport({ port: freshPort(), multicastGroup: GROUP });
    await transport.connect();
    const sendSpy = sinon.stub(transport._socket, "send").callsFake((buf, p, g, cb) => {
      if (cb) cb(null);
    });
    const a = Buffer.from([1]);
    const b = Buffer.from([2, 3]);
    transport.send([a, b]);
    expect(sendSpy.callCount).to.equal(2);
    expect(sendSpy.firstCall.args[0]).to.equal(a);
    expect(sendSpy.secondCall.args[0]).to.equal(b);
  });

  it("send returns synchronously (no Promise) and emits 'error' if dgram.send fails", async function () {
    transport = new UdpTransport({ port: freshPort(), multicastGroup: GROUP });
    await transport.connect();
    sinon.stub(transport._socket, "send").callsFake((buf, p, g, cb) => {
      if (cb) cb(new Error("boom"));
    });
    const errSpy = sinon.spy();
    transport.on("error", errSpy);
    let ret;
    expect(function () {
      ret = transport.send(Buffer.from([9]));
    }).to.not.throw();
    expect(ret).to.equal(undefined, "send returns void, not a Promise");
    expect(errSpy.calledOnce).to.equal(true);
    expect(errSpy.firstCall.args[0].message).to.match(/UDP_SEND_ERROR/);
  });

  it("completes 20 rapid bind/close cycles on the same port without EADDRINUSE", function (done) {
    this.timeout(15000);
    const port = 45678 + Math.floor(Math.random() * 5000);
    let cycles = 0;

    function cycle() {
      if (cycles >= 20) {
        return done(null);
      }
      cycles += 1;
      const t = new UdpTransport({ port, multicastGroup: GROUP });
      t.on("error", (e) => {
        const msg = (e && e.message) || String(e);
        if (/EADDRINUSE/.test(msg)) {
          return done(new Error(`EADDRINUSE on cycle ${cycles}: ${msg}`));
        }
      });
      t.connect().then(() => t.close()).then(() => {
        cycle();
      }).catch((err) => {
        const msg = (err && err.message) || String(err);
        if (/EADDRINUSE/.test(msg)) {
          return done(new Error(`EADDRINUSE on cycle ${cycles}: ${msg}`));
        }
        return done(err instanceof Error ? err : new Error(msg));
      });
    }

    cycle();
  });

  it("addMembership is called AFTER bind callback fires", async function () {
    const realCreate = dgram.createSocket.bind(dgram);
    let bindCalled = false;
    let addMembershipBeforeBind = false;
    let addMembershipAfterBind = false;

    sinon.stub(dgram, "createSocket").callsFake((opts) => {
      const sock = realCreate(opts);
      const realBind = sock.bind.bind(sock);
      sock.bind = function (bindOpts, cb) {
        return realBind(bindOpts, function () {
          bindCalled = true;
          if (cb) cb();
        });
      };
      const realAdd = sock.addMembership.bind(sock);
      sock.addMembership = function (...a) {
        if (bindCalled) addMembershipAfterBind = true;
        else addMembershipBeforeBind = true;
        return realAdd(...a);
      };
      return sock;
    });

    transport = new UdpTransport({ port: freshPort(), multicastGroup: GROUP });
    await transport.connect();
    expect(addMembershipBeforeBind).to.equal(false, "addMembership must NOT run before bind callback");
    expect(addMembershipAfterBind).to.equal(true, "addMembership must run inside/after bind callback");
  });

  it("binds to '0.0.0.0' (NEVER to NIC IP)", async function () {
    const realCreate = dgram.createSocket.bind(dgram);
    let bindAddress;
    sinon.stub(dgram, "createSocket").callsFake((opts) => {
      const sock = realCreate(opts);
      const realBind = sock.bind.bind(sock);
      sock.bind = function (bindOpts, cb) {
        bindAddress = bindOpts && bindOpts.address;
        return realBind(bindOpts, cb);
      };
      return sock;
    });

    transport = new UdpTransport({ port: freshPort(), multicastGroup: GROUP });
    await transport.connect();
    expect(bindAddress).to.equal("0.0.0.0");
  });

});
