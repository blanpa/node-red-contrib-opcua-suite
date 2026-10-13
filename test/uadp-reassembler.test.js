"use strict";

/**
 * lib/uadp-reassembler.js — shared by the UDP transport and the subscriber's
 * UADP-over-MQTT path. The UDP suite drives the same logic through the
 * transport (overflow, expiry, tiling); these cases cover the module API.
 */

const { expect } = require("chai");
const {
  encodeNetworkMessage,
  decodeNetworkMessage,
} = require("../lib/uadp-encoder");
const { UadpReassembler } = require("../lib/uadp-reassembler");

function bigNm(seq) {
  return {
    publisherId: "pub1",
    groupHeader: { writerGroupId: 1, sequenceNumber: seq || 1 },
    payloadHeader: { dataSetWriterIds: [1] },
    payload: [
      {
        messageType: "keyframe",
        sequenceNumber: 1,
        fields: { label: { dataType: "String", value: "y".repeat(2000) } },
      },
    ],
  };
}

describe("UadpReassembler", function () {
  it("returns the complete NetworkMessage once every chunk arrived, in any order", function () {
    const whole = encodeNetworkMessage(bigNm(), { mtu: 100000 });
    const chunks = encodeNetworkMessage(bigNm(), { mtu: 300 });
    expect(chunks.length).to.be.greaterThan(2);

    const r = new UadpReassembler({ maxTotalSize: 1 << 20 });
    const order = [...chunks].reverse();
    const results = order.map((c) => r.push(decodeNetworkMessage(c)));

    expect(results.slice(0, -1).every((x) => x === null)).to.equal(true);
    expect(results[results.length - 1].equals(whole)).to.equal(true);
    expect(r.entries.size).to.equal(0);
  });

  it("rejects a totalSize above maxTotalSize with a prefixed warning", function () {
    const warnings = [];
    const r = new UadpReassembler({
      maxTotalSize: 500,
      prefix: "MQTT",
      onWarn: (e) => warnings.push(e.message),
    });
    const chunks = encodeNetworkMessage(bigNm(), { mtu: 300 });
    expect(r.push(decodeNetworkMessage(chunks[0]))).to.equal(null);
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.match(/^MQTT_REASSEMBLY_TOTALSIZE/);
    expect(r.entries.size).to.equal(0);
  });

  it("keeps messages with different sequence numbers apart and clear() drops partials", function () {
    const r = new UadpReassembler({ maxTotalSize: 1 << 20 });
    const a = encodeNetworkMessage(bigNm(1), { mtu: 300 });
    const b = encodeNetworkMessage(bigNm(2), { mtu: 300 });
    r.push(decodeNetworkMessage(a[0]));
    r.push(decodeNetworkMessage(b[0]));
    expect(r.entries.size).to.equal(2);
    r.clear();
    expect(r.entries.size).to.equal(0);
  });
});
