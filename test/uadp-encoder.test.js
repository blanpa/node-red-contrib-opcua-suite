"use strict";

const { expect } = require("chai");
const { encodeNetworkMessage, decodeNetworkMessage, encodeDataSetMessage, decodeDataSetMessage } = require("../lib/uadp-encoder");

// ─── Helpers ───

function roundTripDsm(dsm) {
  const buf = encodeDataSetMessage(dsm);
  return decodeDataSetMessage(buf);
}

function roundTripNm(nm) {
  const buf = encodeNetworkMessage(nm);
  if (Array.isArray(buf)) throw new Error("expected single Buffer, got Array — use roundTripNmChunked");
  return decodeNetworkMessage(buf);
}

// ─── DataSetMessage encode/decode ───

describe("uadp-encoder — DataSetMessage", function () {

  describe("encodeDataSetMessage / decodeDataSetMessage stubs replaced", function () {
    it("encodeDataSetMessage returns a Buffer (not a stub throw)", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", fields: {} });
      expect(Buffer.isBuffer(buf)).to.equal(true);
    });

    it("decodeDataSetMessage returns an object (not a stub throw)", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", fields: {} });
      const dsm = decodeDataSetMessage(buf);
      expect(dsm).to.be.an("object");
    });
  });

  // ─── DataSetFlags1/2 cascade ───

  describe("DataSetFlags1/2 flag cascade", function () {
    it("default keyframe emits no DataSetFlags2 byte (bit 7 of DSF1 = 0)", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", fields: {} });
      // DSF1 bit 7 must be 0 → no second byte before optional fields
      const dsf1 = buf[0];
      expect(dsf1 & 0x80).to.equal(0, "DataSetFlags2 must not be present for default keyframe");
    });

    it("valid bit (bit 0) is set by default", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", fields: {} });
      expect(buf[0] & 0x01).to.equal(1, "Valid bit must be 1");
    });

    it("valid: false clears bit 0", function () {
      const buf = encodeDataSetMessage({ valid: false, fieldEncoding: "variant", messageType: "keyframe", fields: {} });
      expect(buf[0] & 0x01).to.equal(0, "Valid bit must be 0");
    });

    it("variant fieldEncoding → bits 1-2 = 00", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", fields: {} });
      expect((buf[0] >> 1) & 0x03).to.equal(0b00, "variant = bits 1-2 = 00");
    });

    it("rawdata fieldEncoding → bits 1-2 = 01", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "rawdata", messageType: "keyframe", fields: {} });
      expect((buf[0] >> 1) & 0x03).to.equal(0b01, "rawdata = bits 1-2 = 01");
    });

    it("datavalue fieldEncoding → bits 1-2 = 10", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "datavalue", messageType: "keyframe", fields: {} });
      expect((buf[0] >> 1) & 0x03).to.equal(0b10, "datavalue = bits 1-2 = 10");
    });

    it("sequenceNumber sets DSF1 bit 3", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", sequenceNumber: 1, fields: {} });
      expect(buf[0] & 0x08).to.equal(0x08, "sequenceNumber bit must be set");
    });

    it("status sets DSF1 bit 4", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", status: 0, fields: {} });
      expect(buf[0] & 0x10).to.equal(0x10, "status bit must be set");
    });

    it("configurationVersion.major sets DSF1 bit 5", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", configurationVersion: { major: 1 }, fields: {} });
      expect(buf[0] & 0x20).to.equal(0x20, "configVersionMajor bit must be set");
    });

    it("configurationVersion.minor sets DSF1 bit 6", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", configurationVersion: { major: 1, minor: 0 }, fields: {} });
      expect(buf[0] & 0x40).to.equal(0x40, "configVersionMinor bit must be set");
    });

    it("deltaframe messageType triggers DSF2 presence (bit 0 of DSF2 = 1)", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "deltaframe", fields: {} });
      expect(buf[0] & 0x80).to.equal(0x80, "DSF1 bit 7 must be set (DSF2 present)");
      expect(buf[1] & 0x0F).to.equal(0b0001, "DSF2 bits 0-3 must be 0001 for deltaframe");
    });

    it("keepalive messageType triggers DSF2 bits 0-3 = 0011", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keepalive", fields: {} });
      expect(buf[0] & 0x80).to.equal(0x80, "DSF1 bit 7 must be set for keepalive (DSF2 present)");
      expect(buf[1] & 0x0F).to.equal(0b0011, "DSF2 bits 0-3 must be 0011 for keepalive");
    });

    it("event messageType triggers DSF2 bits 0-3 = 0010", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "event", fields: {} });
      expect(buf[0] & 0x80).to.equal(0x80, "DSF1 bit 7 must be set for event (DSF2 present)");
      expect(buf[1] & 0x0F).to.equal(0b0010, "DSF2 bits 0-3 must be 0010 for event");
    });

    it("timestamp sets DSF2 bit 4", function () {
      const ts = new Date("2021-09-27T18:45:19.555Z");
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", timestamp: ts, fields: {} });
      expect(buf[0] & 0x80).to.equal(0x80, "DSF2 must be present");
      expect(buf[1] & 0x10).to.equal(0x10, "timestamp bit must be set in DSF2");
    });

    it("picoseconds sets DSF2 bit 5 (when timestamp also present)", function () {
      const ts = new Date("2021-09-27T18:45:19.555Z");
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", timestamp: ts, picoseconds: 1234, fields: {} });
      expect(buf[1] & 0x20).to.equal(0x20, "picoseconds bit must be set in DSF2");
    });

    it("picoseconds is NOT set when timestamp is absent", function () {
      const buf = encodeDataSetMessage({ fieldEncoding: "variant", messageType: "keyframe", picoseconds: 1234, fields: {} });
      // No timestamp → DSF2 should not have bit 5 set (and may not even be present)
      if (buf[0] & 0x80) {
        expect(buf[1] & 0x20).to.equal(0, "picoseconds bit must not be set without timestamp");
      }
    });
  });

  // ─── Round-trip: keyframe with variant fields ───

  describe("round-trip: variant fieldEncoding", function () {
    it("round-trips Double scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", sequenceNumber: 1, fields: { temp: { dataType: "Double", value: 23.5 } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.temp.value).to.equal(23.5);
      expect(d.fields.temp.dataType).to.equal(11); // BUILTIN_TYPE.Double
    });

    it("round-trips Boolean scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", sequenceNumber: 1, fields: { ok: { dataType: "Boolean", value: true } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.ok.value).to.equal(true);
    });

    it("round-trips UInt32 scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { count: { dataType: "UInt32", value: 100 } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.count.value).to.equal(100);
    });

    it("round-trips UInt16 scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { id: { dataType: "UInt16", value: 65535 } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.id.value).to.equal(65535);
    });

    it("round-trips Int32 scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { diff: { dataType: "Int32", value: -42 } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.diff.value).to.equal(-42);
    });

    it("round-trips String scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { name: { dataType: "String", value: "hello world" } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.name.value).to.equal("hello world");
    });

    it("round-trips Float scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { f: { dataType: "Float", value: 3.14 } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.f.value).to.be.closeTo(3.14, 0.0001);
    });

    it("round-trips Byte scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { b: { dataType: "Byte", value: 255 } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.b.value).to.equal(255);
    });

    it("round-trips Int16 scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { s: { dataType: "Int16", value: -1000 } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.s.value).to.equal(-1000);
    });

    it("round-trips SByte scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { sb: { dataType: "SByte", value: -128 } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.sb.value).to.equal(-128);
    });

    it("round-trips UInt64 BigInt scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { bigval: { dataType: "UInt64", value: 9007199254740993n } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.bigval.value).to.equal(9007199254740993n);
    });

    it("round-trips StatusCode scalar", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { sc: { dataType: "StatusCode", value: 0x80350000 } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.sc.value).to.equal(0x80350000);
    });

    it("round-trips DateTime scalar", function () {
      const ts = new Date("2021-09-27T18:45:19.000Z");
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { t: { dataType: "DateTime", value: ts } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.t.value.getTime()).to.equal(ts.getTime());
    });

    it("round-trips null Variant (empty)", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { empty: null } };
      const d = roundTripDsm(dsm);
      expect(d.fields.empty).to.equal(null);
    });

    it("round-trips UInt32 array Variant", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { arr: { dataType: "UInt32", value: [1, 2, 3] } } };
      const d = roundTripDsm(dsm);
      expect(d.fields.arr.value).to.deep.equal([1, 2, 3]);
    });

    it("round-trips multiple fields preserving insertion order", function () {
      const dsm = {
        fieldEncoding: "variant",
        messageType: "keyframe",
        fields: {
          a: { dataType: "UInt32", value: 1 },
          b: { dataType: "String", value: "two" },
          c: { dataType: "Boolean", value: false },
        },
      };
      const d = roundTripDsm(dsm);
      const keys = Object.keys(d.fields);
      expect(keys).to.deep.equal(["a", "b", "c"]);
      expect(d.fields.a.value).to.equal(1);
      expect(d.fields.b.value).to.equal("two");
      expect(d.fields.c.value).to.equal(false);
    });

    it("round-trips all optional DSM header fields", function () {
      const ts = new Date("2021-09-27T18:45:19.000Z");
      const dsm = {
        fieldEncoding: "variant",
        messageType: "keyframe",
        valid: true,
        sequenceNumber: 42,
        status: 0,
        configurationVersion: { major: 2, minor: 1 },
        timestamp: ts,
        picoseconds: 500,
        fields: { x: { dataType: "Double", value: 1.5 } },
      };
      const d = roundTripDsm(dsm);
      expect(d.sequenceNumber).to.equal(42);
      expect(d.status).to.equal(0);
      expect(d.configurationVersion).to.deep.equal({ major: 2, minor: 1 });
      expect(d.timestamp.getTime()).to.equal(ts.getTime());
      expect(d.picoseconds).to.equal(500);
      expect(d.fields.x.value).to.equal(1.5);
    });
  });

  // ─── Round-trip: keepalive has no body ───

  describe("round-trip: keepalive messageType", function () {
    it("keepalive round-trips without fields", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keepalive", sequenceNumber: 5, fields: {} };
      const d = roundTripDsm(dsm);
      expect(d.messageType).to.equal("keepalive");
    });

    it("keepalive has no fields in decoded output", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keepalive", fields: {} };
      const d = roundTripDsm(dsm);
      expect(d.fields).to.equal(undefined);
    });
  });

  // ─── Round-trip: datavalue fieldEncoding ───

  describe("round-trip: datavalue fieldEncoding", function () {
    it("round-trips datavalue with value only", function () {
      const dsm = {
        fieldEncoding: "datavalue",
        messageType: "keyframe",
        fields: {
          sensor: { value: { dataType: "Double", value: 99.9 } },
        },
      };
      const d = roundTripDsm(dsm);
      expect(d.fields.sensor.value.value).to.be.closeTo(99.9, 0.0001);
    });

    it("round-trips datavalue with statusCode", function () {
      const dsm = {
        fieldEncoding: "datavalue",
        messageType: "keyframe",
        fields: {
          s: { value: { dataType: "UInt32", value: 42 }, statusCode: 0x80350000 },
        },
      };
      const d = roundTripDsm(dsm);
      expect(d.fields.s.statusCode).to.equal(0x80350000);
      expect(d.fields.s.value.value).to.equal(42);
    });

    it("round-trips datavalue with sourceTimestamp", function () {
      const ts = new Date("2021-09-27T18:45:19.000Z");
      const dsm = {
        fieldEncoding: "datavalue",
        messageType: "keyframe",
        fields: {
          s: { value: { dataType: "UInt32", value: 1 }, sourceTimestamp: ts },
        },
      };
      const d = roundTripDsm(dsm);
      expect(d.fields.s.sourceTimestamp.getTime()).to.equal(ts.getTime());
    });
  });

  // ─── Error cases ───

  describe("error handling", function () {
    it("throws UADP_ENCODE_INVALID_INPUT on null input to encodeDataSetMessage", function () {
      expect(() => encodeDataSetMessage(null)).to.throw(/UADP_ENCODE_INVALID_INPUT/);
    });

    it("throws UADP_ENCODE_INVALID_FIELD_ENCODING on unknown fieldEncoding", function () {
      expect(() => encodeDataSetMessage({ fieldEncoding: "unknown", fields: {} })).to.throw(/UADP_ENCODE_INVALID_FIELD_ENCODING/);
    });

    it("throws UADP_ENCODE_INVALID_MESSAGE_TYPE on unknown messageType", function () {
      expect(() => encodeDataSetMessage({ fieldEncoding: "variant", messageType: "bogus", fields: {} })).to.throw(/UADP_ENCODE_INVALID_MESSAGE_TYPE/);
    });

    it("throws UADP_VARIANT_UNSUPPORTED_BUILTIN_TYPE on unknown dataType id", function () {
      const dsm = { fieldEncoding: "variant", messageType: "keyframe", fields: { bad: { dataType: 99, value: 0 } } };
      expect(() => encodeDataSetMessage(dsm)).to.throw(/UADP_VARIANT_UNSUPPORTED_BUILTIN_TYPE/);
    });

    it("throws UADP_RAWDATA_DECODE_REQUIRES_METADATA when decoding rawdata", function () {
      const dsm = { fieldEncoding: "rawdata", messageType: "keyframe", fields: { x: { dataType: "UInt32", value: 5 } } };
      const buf = encodeDataSetMessage(dsm);
      expect(() => decodeDataSetMessage(buf)).to.throw(/UADP_RAWDATA_DECODE_REQUIRES_METADATA/);
    });
  });
});

// ─── NetworkMessage with payload ───

describe("uadp-encoder — NetworkMessage with payload", function () {
  describe("encodeNetworkMessage serializes DataSetMessages", function () {
    it("round-trips a NetworkMessage with one variant DataSetMessage", function () {
      const nm = {
        publisherId: 7,
        groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 42 },
        payloadHeader: { dataSetWriterIds: [1] },
        payload: [{
          dataSetWriterId: 1,
          fieldEncoding: "variant",
          messageType: "keyframe",
          sequenceNumber: 1,
          fields: {
            temp: { dataType: "Double", value: 23.5 },
            ok: { dataType: "Boolean", value: true },
          },
        }],
      };
      const buf = encodeNetworkMessage(nm);
      expect(Buffer.isBuffer(buf)).to.equal(true);
      const d = decodeNetworkMessage(buf);
      expect(d.payload[0].fields.temp.value).to.equal(23.5);
      expect(d.payload[0].fields.ok.value).to.equal(true);
    });

    it("round-trips a NetworkMessage with keepalive payload", function () {
      const nm = {
        payload: [{
          fieldEncoding: "variant",
          messageType: "keepalive",
          sequenceNumber: 5,
          fields: {},
        }],
      };
      const buf = encodeNetworkMessage(nm);
      const d = decodeNetworkMessage(buf);
      expect(d.payload[0].messageType).to.equal("keepalive");
    });

    it("round-trips NetworkMessage with UInt32 field", function () {
      const nm = {
        payload: [{
          fieldEncoding: "variant",
          messageType: "keyframe",
          sequenceNumber: 1,
          fields: { x: { dataType: "UInt32", value: 100 } },
        }],
      };
      const buf = encodeNetworkMessage(nm);
      const d = decodeNetworkMessage(buf);
      expect(d.payload[0].fields.x.value).to.equal(100);
    });

    it("does NOT throw on non-empty payload (stubs replaced)", function () {
      const nm = {
        payload: [{ fieldEncoding: "variant", messageType: "keyframe", fields: { v: { dataType: "Boolean", value: false } } }],
      };
      expect(() => encodeNetworkMessage(nm)).not.to.throw();
    });
  });

  describe("size array for multiple DataSetMessages", function () {
    it("round-trips two DataSetMessages with payloadHeader having 2 writerIds", function () {
      const nm = {
        payloadHeader: { dataSetWriterIds: [1, 2] },
        payload: [
          { fieldEncoding: "variant", messageType: "keyframe", fields: { a: { dataType: "UInt32", value: 1 } } },
          { fieldEncoding: "variant", messageType: "keyframe", fields: { b: { dataType: "String", value: "hello" } } },
        ],
      };
      const buf = encodeNetworkMessage(nm);
      const d = decodeNetworkMessage(buf);
      expect(d.payload).to.have.lengthOf(2);
      expect(d.payload[0].fields.a.value).to.equal(1);
      expect(d.payload[1].fields.b.value).to.equal("hello");
    });
  });

  describe("chunking", function () {
    it("produces Array<Buffer> when payload exceeds default MTU (1400 bytes)", function () {
      const big = "x".repeat(2000);
      const nm = {
        groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 1 },
        payloadHeader: { dataSetWriterIds: [1] },
        payload: [{
          fieldEncoding: "variant",
          messageType: "keyframe",
          sequenceNumber: 1,
          fields: { blob: { dataType: "String", value: big } },
        }],
      };
      const result = encodeNetworkMessage(nm);
      expect(Array.isArray(result)).to.equal(true, "expected Array<Buffer> for oversized payload");
      expect(result.length).to.be.greaterThanOrEqual(2, "expected at least 2 chunks");
    });

    it("each chunk is <= MTU (1400 bytes) with default MTU", function () {
      const big = "x".repeat(2000);
      const nm = {
        groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 1 },
        payloadHeader: { dataSetWriterIds: [1] },
        payload: [{
          fieldEncoding: "variant",
          messageType: "keyframe",
          sequenceNumber: 1,
          fields: { blob: { dataType: "String", value: big } },
        }],
      };
      const result = encodeNetworkMessage(nm);
      for (const chunk of result) {
        expect(chunk.length).to.be.at.most(1400, `chunk of length ${chunk.length} exceeds MTU`);
      }
    });

    it("total chunk data sums to full payload size (TotalSize consistency)", function () {
      const big = "x".repeat(2000);
      const nm = {
        groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 1 },
        payloadHeader: { dataSetWriterIds: [1] },
        payload: [{
          fieldEncoding: "variant",
          messageType: "keyframe",
          sequenceNumber: 1,
          fields: { blob: { dataType: "String", value: big } },
        }],
      };
      const result = encodeNetworkMessage(nm);
      // Decode each chunk to extract TotalSize and ChunkData length
      let lastTotalSize = null;
      let sumChunkData = 0;
      for (const chunk of result) {
        const d = decodeNetworkMessage(chunk);
        expect(d.chunk).to.exist;
        if (lastTotalSize === null) lastTotalSize = d.chunk.totalSize;
        else expect(d.chunk.totalSize).to.equal(lastTotalSize, "TotalSize must be same across all chunks");
        sumChunkData += d.chunk.chunkData.length;
      }
      expect(sumChunkData).to.equal(lastTotalSize, "sum of chunkData lengths must equal TotalSize");
    });

    it("each chunk has ExtendedFlags2 bit 0 set (chunk marker)", function () {
      const big = "x".repeat(2000);
      const nm = {
        groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 1 },
        payloadHeader: { dataSetWriterIds: [1] },
        payload: [{
          fieldEncoding: "variant",
          messageType: "keyframe",
          sequenceNumber: 1,
          fields: { blob: { dataType: "String", value: big } },
        }],
      };
      const result = encodeNetworkMessage(nm);
      for (const chunk of result) {
        // UADPFlags bit 7 → ExtFlags1 bit 7 → ExtFlags2 bit 0
        const uadpFlags = chunk[0];
        expect(uadpFlags & 0x80).to.equal(0x80, "ExtFlags1 must be present");
        const extFlags1 = chunk[1];
        expect(extFlags1 & 0x80).to.equal(0x80, "ExtFlags2 must be present");
        const extFlags2 = chunk[2];
        expect(extFlags2 & 0x01).to.equal(0x01, "ExtFlags2 bit 0 (chunk) must be set");
      }
    });

    it("produces a single Buffer when payload is small enough (below MTU)", function () {
      const nm = {
        groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 1 },
        payloadHeader: { dataSetWriterIds: [1] },
        payload: [{
          fieldEncoding: "variant",
          messageType: "keyframe",
          sequenceNumber: 1,
          fields: { x: { dataType: "UInt32", value: 42 } },
        }],
      };
      const result = encodeNetworkMessage(nm);
      expect(Buffer.isBuffer(result)).to.equal(true, "small payload should return a single Buffer");
    });

    it("respects custom mtu via opts", function () {
      const nm = {
        groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 1 },
        payloadHeader: { dataSetWriterIds: [1] },
        payload: [{
          fieldEncoding: "variant",
          messageType: "keyframe",
          sequenceNumber: 1,
          fields: { x: { dataType: "String", value: "x".repeat(100) } },
        }],
      };
      // Force chunking at tiny MTU
      const result = encodeNetworkMessage(nm, { mtu: 50 });
      expect(Array.isArray(result)).to.equal(true, "expected chunking with tiny mtu=50");
      for (const chunk of result) {
        expect(chunk.length).to.be.at.most(50, `chunk exceeds custom mtu: ${chunk.length}`);
      }
    });
  });

  describe("encodeNetworkMessage JSDoc documents Buffer|Buffer[] return", function () {
    it("function exists and accepts opts", function () {
      // just verify it doesn't throw on empty payload with opts
      const nm = { payload: [] };
      const result = encodeNetworkMessage(nm, { mtu: 1400 });
      expect(Buffer.isBuffer(result)).to.equal(true);
    });
  });
});

// ─── 8-Combination Fixture Matrix (Plan 02-05, D-17, D-19, ENC-01) ──────────
//
// These tests lock in the UADP wire format with executable byte-for-byte assertions
// against the test vectors in test/fixtures/uadp-vectors.js.
// The 8 combinations cover the full ExtendedFlags1/ExtendedFlags2 presence matrix
// per RESEARCH.md §"8 Combinations for Test Matrix".

const vectors = require("./fixtures/uadp-vectors");

function hexStrip(s) { return s.replace(/[\s_]/g, "").toLowerCase(); }
function bufHex(buf) { return buf.toString("hex").toLowerCase(); }

describe("uadp-encoder — module exports", function () {
  it("exports the four expected functions", function () {
    expect(encodeNetworkMessage).to.be.a("function");
    expect(decodeNetworkMessage).to.be.a("function");
    expect(encodeDataSetMessage).to.be.a("function");
    expect(decodeDataSetMessage).to.be.a("function");
  });

  it("does NOT export BinaryStream (private class)", function () {
    const u = require("../lib/uadp-encoder");
    expect(u.BinaryStream).to.equal(undefined);
  });
});

describe("uadp-encoder — 8-combination flag cascade matrix (D-17, D-19, ENC-01)", function () {
  it("fixture file exports exactly 8 cases", function () {
    expect(Object.keys(vectors)).to.have.length(8);
  });

  for (const [name, vec] of Object.entries(vectors)) {
    describe(name, function () {
      it("first byte (UADPFlags) matches fixture.flags.uadpFlags", function () {
        if (vec.pending) this.skip();
        // For static-chunk fixtures, produce a chunk by encoding a large payload
        // and read the first chunk's UADPFlags byte.
        if (vec.isStaticChunk) {
          // We verify the flag cascade logic produces the expected first byte
          // by encoding a model that triggers chunking with the same publisherId.
          const big = "x".repeat(2000);
          const chunkNm = {
            publisherId: vec.model.publisherId,
            groupHeader: vec.model.groupHeader,
            payloadHeader: vec.model.payloadHeader,
            payload: [{
              fieldEncoding: "variant", messageType: "keyframe", sequenceNumber: 1,
              fields: { blob: { dataType: "String", value: big } },
            }],
          };
          const result = encodeNetworkMessage(chunkNm);
          const buf = Array.isArray(result) ? result[0] : result;
          // Chunk messages always have ExtFlags2 = 0x01 set, which requires ExtFlags1.
          // The specific extFlags2 byte is 0x01 so UADPFlags bit 7 must be set.
          expect(buf[0] & 0x80).to.equal(0x80, "chunk messages must have ExtFlags1 enabled");
          return;
        }
        const encoded = encodeNetworkMessage(vec.model);
        const buf = Array.isArray(encoded) ? encoded[0] : encoded;
        expect(buf[0]).to.equal(vec.flags.uadpFlags);
      });

      it("encodeNetworkMessage(model) hex matches fixture.hex", function () {
        if (vec.pending) this.skip();
        if (vec.isStaticChunk) this.skip();
        const encoded = encodeNetworkMessage(vec.model);
        const buf = Buffer.isBuffer(encoded) ? encoded : encoded[0];
        expect(bufHex(buf)).to.equal(hexStrip(vec.hex));
      });

      it("decodeNetworkMessage(hex) round-trips key fields from fixture.model", function () {
        if (vec.pending) this.skip();
        if (vec.isStaticChunk) this.skip();
        const buf = Buffer.from(hexStrip(vec.hex), "hex");
        const decoded = decodeNetworkMessage(buf);
        if (vec.model.publisherId !== undefined) {
          expect(decoded.publisherId).to.deep.equal(vec.model.publisherId);
        }
        if (vec.model.timestamp) {
          expect(decoded.timestamp.getTime()).to.equal(vec.model.timestamp.getTime());
        }
        if (vec.model.dataSetClassId) {
          expect(decoded.dataSetClassId.toUpperCase()).to.equal(vec.model.dataSetClassId.toUpperCase());
        }
      });
    });
  }
});

describe("uadp-encoder — round-trip stability (D-11, D-19)", function () {
  it("encode → decode → encode produces identical bytes for minimalNoExtFlags", function () {
    const buf1 = encodeNetworkMessage(vectors.minimalNoExtFlags.model);
    const decoded = decodeNetworkMessage(buf1);
    const buf2 = encodeNetworkMessage(decoded);
    expect(bufHex(buf2)).to.equal(bufHex(buf1));
  });

  it("encode → decode → encode produces identical bytes for uint64PublisherId", function () {
    const buf1 = encodeNetworkMessage(vectors.uint64PublisherId.model);
    const decoded = decodeNetworkMessage(buf1);
    const buf2 = encodeNetworkMessage(decoded);
    expect(bufHex(buf2)).to.equal(bufHex(buf1));
  });

  it("encode → decode → encode produces identical bytes for stringPublisherId", function () {
    const buf1 = encodeNetworkMessage(vectors.stringPublisherId.model);
    const decoded = decodeNetworkMessage(buf1);
    const buf2 = encodeNetworkMessage(decoded);
    expect(bufHex(buf2)).to.equal(bufHex(buf1));
  });
});

describe("uadp-encoder — PublisherId variants (all 5 types, ExtFlags1 type bits)", function () {
  const cases = [
    { name: "Byte",   value: 0x42,               typeBits: 0b000 },
    { name: "UInt16", value: 0x1234,             typeBits: 0b001 },
    { name: "UInt32", value: 0x12345678,         typeBits: 0b010 },
    { name: "UInt64", value: 0xFEDCBA9876543210n, typeBits: 0b011 },
    { name: "String", value: "publisher-A",      typeBits: 0b100 },
  ];

  for (const c of cases) {
    it(`${c.name} (typeBits=0b${c.typeBits.toString(2).padStart(3, "0")}): PublisherId presence + round-trip`, function () {
      const m = { publisherId: c.value, payload: [] };
      const buf = encodeNetworkMessage(m);
      // UADPFlags must always have PublisherId enabled (bit 4)
      expect(buf[0] & 0x10).to.equal(0x10, "UADPFlags bit 4 (PublisherId) must be set");
      if (c.typeBits === 0b000) {
        // Byte type: ExtFlags1 bits 0-2 = 000 → ExtFlags1 is 0x00 → suppressed per cascade rule
        // UADPFlags bit 7 must be CLEAR (no ExtFlags1 byte emitted)
        expect(buf[0] & 0x80).to.equal(0x00, "Byte publisherId: ExtFlags1 suppressed (all bits zero), UADPFlags bit 7 must be 0");
      } else {
        // Non-Byte types trigger ExtFlags1 (type bits are non-zero)
        expect(buf[0] & 0x80).to.equal(0x80, "UADPFlags bit 7 (ExtFlags1) must be set for non-Byte publisherId");
        // ExtFlags1 bits 0-2 must equal the expected type bits
        expect(buf[1] & 0x07).to.equal(c.typeBits, `ExtFlags1 bits 0-2 must be 0b${c.typeBits.toString(2)} for ${c.name}`);
      }
      // Round-trip: decode must reproduce the same publisherId
      const decoded = decodeNetworkMessage(buf);
      expect(decoded.publisherId).to.deep.equal(c.value);
    });
  }
});

describe("uadp-encoder — chunking (fixture assertions, Part 14 §7.2.4.4.4)", function () {
  it("input larger than MTU returns Array<Buffer>; each chunk <= MTU; sum of chunk data == totalSize", function () {
    const big = "x".repeat(2000);
    const m = {
      publisherId: 1,
      groupHeader: { writerGroupId: 1, groupVersion: 1, networkMessageNumber: 1, sequenceNumber: 1 },
      payloadHeader: { dataSetWriterIds: [1] },
      payload: [{
        dataSetWriterId: 1, fieldEncoding: "variant", messageType: "keyframe",
        sequenceNumber: 1, fields: { blob: { dataType: "String", value: big } },
      }],
    };
    const result = encodeNetworkMessage(m);
    expect(Array.isArray(result)).to.equal(true, "large payload must return Array<Buffer>");
    expect(result.length).to.be.greaterThan(1, "must produce more than one chunk");
    let totalChunkData = 0;
    let totalSize = null;
    for (const chunk of result) {
      expect(chunk.length).to.be.at.most(1400, "each chunk must be <= 1400 bytes (default MTU)");
      const d = decodeNetworkMessage(chunk);
      expect(d.chunk).to.exist;
      if (totalSize === null) totalSize = d.chunk.totalSize;
      else expect(d.chunk.totalSize).to.equal(totalSize, "totalSize must be consistent across chunks");
      totalChunkData += d.chunk.chunkData.length;
    }
    expect(totalChunkData).to.equal(totalSize, "sum of chunkData lengths must equal totalSize");
  });

  it("input below MTU returns a single Buffer (not Array)", function () {
    const m = {
      publisherId: 1,
      payload: [{
        fieldEncoding: "variant", messageType: "keyframe", sequenceNumber: 1,
        fields: { x: { dataType: "Int32", value: 42 } },
      }],
    };
    expect(Buffer.isBuffer(encodeNetworkMessage(m))).to.equal(true);
  });
});

describe("uadp-encoder — decoder error handling (T-02-01, T-02-05, T-02-08)", function () {
  it("truncated buffer throws UADP_DECODE_TRUNCATED with offset info", function () {
    // 0x91 = UADPFlags with PublisherId (bit 4) + ExtFlags1 (bit 7) → decoder needs 1 more byte
    let caught = null;
    try { decodeNetworkMessage(Buffer.from([0x91])); } catch (e) { caught = e; }
    expect(caught).to.not.equal(null);
    expect(caught.message).to.match(/UADP_DECODE_TRUNCATED/);
  });

  it("non-Buffer input throws UADP_DECODE_INVALID_INPUT", function () {
    expect(() => decodeNetworkMessage("not a buffer")).to.throw(/UADP_DECODE_INVALID_INPUT/);
  });

  it("unsupported UADP version (version bits != 1) throws UADP_DECODE_UNSUPPORTED_VERSION", function () {
    // Version 2 in low 4 bits → unsupported
    expect(() => decodeNetworkMessage(Buffer.from([0x02]))).to.throw(/UADP_DECODE_UNSUPPORTED_VERSION/);
  });

  it("null input throws UADP_ENCODE_INVALID_INPUT on encodeNetworkMessage", function () {
    expect(() => encodeNetworkMessage(null)).to.throw(/UADP_ENCODE_INVALID_INPUT/);
  });
});
