"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const dgram = require("dgram");
const EventEmitter = require("events");

const { BaseTransport } = require("../../lib/transports/base-transport");
const { UdpTransport } = require("../../lib/transports/udp-transport");
const uadp = require("../../lib/uadp-encoder");
const { encodeNetworkMessage } = uadp;

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

describe("UdpTransport — _reassemble (UADP chunking)", function () {

  // A NetworkMessage large enough to force multiple chunks at a tiny MTU.
  function bigNm(publisherId) {
    return {
      publisherId: publisherId === undefined ? 7 : publisherId,
      groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 1 },
      payloadHeader: { dataSetWriterIds: [1] },
      payload: [{
        fieldEncoding: "variant",
        messageType: "keyframe",
        sequenceNumber: 1,
        fields: { blob: { dataType: "String", value: "x".repeat(2000) } },
      }],
    };
  }

  // Small single-datagram NetworkMessage (no chunking).
  function smallNm() {
    return {
      publisherId: 7,
      groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 1 },
      payloadHeader: { dataSetWriterIds: [1] },
      payload: [{
        fieldEncoding: "variant",
        messageType: "keyframe",
        sequenceNumber: 1,
        fields: { v: { dataType: "Int32", value: 42 } },
      }],
    };
  }

  let transport;

  beforeEach(function () {
    // No socket needed — drive _onDatagram directly with synthetic buffers.
    transport = new UdpTransport({ port: 45999, multicastGroup: "239.0.0.1" });
  });

  afterEach(function () {
    sinon.restore();
    transport = null;
  });

  it("single-buffer NetworkMessage emits 'message' immediately and does NOT add to _chunks", function () {
    const buf = encodeNetworkMessage(smallNm());
    expect(Buffer.isBuffer(buf)).to.equal(true, "small payload must be a single Buffer");
    const spy = sinon.spy();
    transport.on("message", spy);
    transport._onDatagram(buf, {});
    expect(spy.calledOnce).to.equal(true);
    expect(transport._chunks.size).to.equal(0);
  });

  it("multi-chunk reassembly: chunks delivered in order produce one 'message' with full payload", function () {
    const original = encodeNetworkMessage(bigNm());
    const chunks = encodeNetworkMessage(bigNm(), { mtu: 200 });
    expect(Array.isArray(chunks)).to.equal(true);
    expect(chunks.length).to.be.greaterThanOrEqual(2);

    // The full payload size is the totalSize carried in each chunk.
    const totalSize = uadp.decodeNetworkMessage(chunks[0]).chunk.totalSize;

    const spy = sinon.spy();
    transport.on("message", spy);
    chunks.forEach((c) => transport._onDatagram(c, {}));

    expect(spy.calledOnce).to.equal(true, "exactly one 'message' after last chunk");
    const assembled = spy.firstCall.args[0];
    expect(Buffer.isBuffer(assembled)).to.equal(true);
    expect(assembled.length).to.equal(totalSize);
    expect(transport._chunks.size).to.equal(0, "entry removed after completion");
  });

  it("multi-chunk reassembly: out-of-order chunks reassemble correctly", function () {
    const chunks = encodeNetworkMessage(bigNm(), { mtu: 200 });
    const totalSize = uadp.decodeNetworkMessage(chunks[0]).chunk.totalSize;

    const spy = sinon.spy();
    transport.on("message", spy);
    // Deliver in reverse order.
    [...chunks].reverse().forEach((c) => transport._onDatagram(c, {}));

    expect(spy.calledOnce).to.equal(true);
    expect(spy.firstCall.args[0].length).to.equal(totalSize);
  });

  it("stale entry expires after 30 seconds", function () {
    const clock = sinon.useFakeTimers();
    try {
      const chunks = encodeNetworkMessage(bigNm(), { mtu: 200 });
      expect(chunks.length).to.be.greaterThanOrEqual(3);

      const spy = sinon.spy();
      transport.on("message", spy);

      // Deliver only the first chunk — entry now in-flight.
      transport._onDatagram(chunks[0], {});
      expect(transport._chunks.size).to.equal(1);

      // Advance past expiry, then deliver an UNRELATED datagram to trigger the sweep.
      clock.tick(30001);
      const unrelated = encodeNetworkMessage(bigNm(99), { mtu: 200 });
      transport._onDatagram(unrelated[0], {});

      // Original key must be gone; only the unrelated (publisherId 99) entry remains.
      const remainingKeys = [...transport._chunks.keys()];
      expect(remainingKeys.some((k) => k.startsWith("7|"))).to.equal(false, "stale publisherId 7 entry swept");

      // Now deliver the rest of the ORIGINAL chunks — must NOT complete (entry was dropped).
      for (let i = 1; i < chunks.length; i++) transport._onDatagram(chunks[i], {});
      expect(spy.called).to.equal(false, "stale message must not reassemble");
    } finally {
      clock.restore();
    }
  });

  it("overflow guard: 1001st distinct key drops the oldest", function () {
    // Stub the decoder to synthesize 1001 distinct chunk-1-of-N entries quickly.
    let seq = 0;
    sinon.stub(uadp, "decodeNetworkMessage").callsFake(() => ({
      publisherId: 1,
      groupHeader: { writerGroupId: 1 },
      chunk: {
        messageSequenceNumber: seq, // distinct per call -> distinct key
        chunkOffset: 0,
        totalSize: 1000000, // never completes (huge)
        chunkData: Buffer.alloc(10),
      },
    }));

    const warnSpy = sinon.spy();
    transport.on("warn", warnSpy);

    const firstKey = "1|1|0";
    for (seq = 0; seq < 1001; seq++) {
      transport._onDatagram(Buffer.alloc(4), {});
    }

    expect(transport._chunks.size).to.equal(1000, "bound holds at 1000");
    expect(transport._chunks.has(firstKey)).to.equal(false, "oldest key dropped");
    expect(warnSpy.called).to.equal(true);
    expect(warnSpy.firstCall.args[0].message).to.match(/UDP_REASSEMBLY_OVERFLOW/);
  });

  it("malformed datagram: decode error is caught and emitted as 'error', listener stays alive", function () {
    const stub = sinon.stub(uadp, "decodeNetworkMessage");
    stub.onFirstCall().throws(new Error("garbage bytes"));
    // Second call: a valid single-buffer (no chunk) message -> passthrough.
    stub.onSecondCall().returns({ publisherId: 7, groupHeader: { writerGroupId: 1 } });

    const errSpy = sinon.spy();
    const msgSpy = sinon.spy();
    transport.on("error", errSpy);
    transport.on("message", msgSpy);

    // Junk datagram -> decode throws -> caught + 'error' emitted, no exception bubbles.
    expect(function () {
      transport._onDatagram(Buffer.from([0xff, 0xff]), {});
    }).to.not.throw();
    expect(errSpy.calledOnce).to.equal(true);
    expect(errSpy.firstCall.args[0].message).to.match(/UDP_DECODE_ERROR/);

    // Listener survived: a subsequent valid datagram still emits 'message'.
    transport._onDatagram(Buffer.from([0x01]), {});
    expect(msgSpy.calledOnce).to.equal(true);
  });

});
