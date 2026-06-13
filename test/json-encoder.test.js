"use strict";

const { expect } = require("chai");

const { encodeNetworkMessage, decodeNetworkMessage } = require("../lib/json-encoder");

// ─── module exports ───

describe("json-encoder", function () {

  describe("module exports", function () {
    it("exports encodeNetworkMessage and decodeNetworkMessage", function () {
      expect(encodeNetworkMessage).to.be.a("function");
      expect(decodeNetworkMessage).to.be.a("function");
    });
  });

  // ─── encodeNetworkMessage — field order (D-07) ───

  describe("encodeNetworkMessage — Part 14 §7.2.5 field order", function () {
    it("emits top-level fields in MessageId, MessageType, Messages order (no PublisherId/WriterGroupName/DataSetClassId)", function () {
      const json = encodeNetworkMessage({ messageId: "m1", payload: [] });
      const parsed = JSON.parse(json);
      expect(Object.keys(parsed)).to.deep.equal(["MessageId", "MessageType", "Messages"]);
      expect(parsed.MessageType).to.equal("ua-data");
    });

    it("emits PublisherId between MessageType and WriterGroupName when present", function () {
      const json = encodeNetworkMessage({
        messageId: "m1",
        publisherId: "publisher-A",
        writerGroupName: "group-1",
        dataSetClassId: "00000000-0000-0000-0000-000000000001",
        payload: [],
      });
      const parsed = JSON.parse(json);
      expect(Object.keys(parsed)).to.deep.equal([
        "MessageId", "MessageType", "PublisherId", "WriterGroupName", "DataSetClassId", "Messages",
      ]);
    });

    it("DataSetMessage emits DataSetWriterId, SequenceNumber, MessageType, Payload in spec order", function () {
      const json = encodeNetworkMessage({
        messageId: "m1",
        payload: [{
          dataSetWriterId: 7,
          sequenceNumber: 100,
          messageType: "keyframe",
          fields: { x: { dataType: "Int32", value: 1 } },
        }],
      });
      const parsed = JSON.parse(json);
      const dsmKeys = Object.keys(parsed.Messages[0]);
      expect(dsmKeys[0]).to.equal("DataSetWriterId");
      expect(dsmKeys).to.include("SequenceNumber");
      expect(dsmKeys).to.include("MessageType");
      expect(dsmKeys[dsmKeys.length - 1]).to.equal("Payload");
    });
  });

  // ─── Variant type conversions (Part 6 §5.4) ───

  describe("Variant type conversions", function () {
    function encField(field) {
      const json = encodeNetworkMessage({
        messageId: "m1",
        payload: [{ messageType: "keyframe", fields: { x: field } }],
      });
      return JSON.parse(json).Messages[0].Payload.x;
    }

    it("Boolean → UaType=1, Value=true|false", function () {
      const v = encField({ dataType: "Boolean", value: true });
      expect(v).to.deep.equal({ UaType: 1, Value: true });
    });

    it("Int32 → UaType=6", function () {
      const v = encField({ dataType: "Int32", value: -42 });
      expect(v).to.deep.equal({ UaType: 6, Value: -42 });
    });

    it("Double → UaType=11", function () {
      const v = encField({ dataType: "Double", value: 3.14 });
      expect(v).to.deep.equal({ UaType: 11, Value: 3.14 });
    });

    it("UInt64 BigInt → UaType=9, Value=string (safe JSON)", function () {
      const v = encField({ dataType: "UInt64", value: 0x1234567890abcdefn });
      expect(v.UaType).to.equal(9);
      expect(v.Value).to.equal("1311768467294899695");
    });

    it("emits UaType BEFORE Value (Part 6 §5.4 SHOULD)", function () {
      const v = encField({ dataType: "Int32", value: 1 });
      expect(Object.keys(v)).to.deep.equal(["UaType", "Value"]);
    });

    it("array Variant → array Value preserved", function () {
      const v = encField({ dataType: "Int32", value: [1, 2, 3] });
      expect(v).to.deep.equal({ UaType: 6, Value: [1, 2, 3] });
    });
  });

  // ─── DateTime conversion ───

  describe("DateTime conversion", function () {
    it("Date → ISO-8601 string", function () {
      const date = new Date("2026-05-13T18:45:19.555Z");
      const json = encodeNetworkMessage({
        messageId: "m1",
        payload: [{ messageType: "keyframe", timestamp: date, fields: { ts: { dataType: "DateTime", value: date } } }],
      });
      const parsed = JSON.parse(json);
      expect(parsed.Messages[0].Timestamp).to.equal("2026-05-13T18:45:19.555Z");
      expect(parsed.Messages[0].Payload.ts.Value).to.equal("2026-05-13T18:45:19.555Z");
    });
  });

  // ─── ByteString conversion ───

  describe("ByteString conversion", function () {
    it("Buffer → Base64 string", function () {
      const buf = Buffer.from("hello", "utf8");
      const json = encodeNetworkMessage({
        messageId: "m1",
        payload: [{ messageType: "keyframe", fields: { blob: { dataType: "ByteString", value: buf } } }],
      });
      const parsed = JSON.parse(json);
      expect(parsed.Messages[0].Payload.blob.UaType).to.equal(15);
      expect(parsed.Messages[0].Payload.blob.Value).to.equal("aGVsbG8=");
    });
  });

  // ─── NodeId conversion ───

  describe("NodeId conversion", function () {
    it("NodeId domain object → ns=X;s=Value string via nodeIdToString", function () {
      const nodeId = { namespaceIndex: 2, identifierType: "String", value: "Temperature" };
      const json = encodeNetworkMessage({
        messageId: "m1",
        payload: [{ messageType: "keyframe", fields: { ref: { dataType: "NodeId", value: nodeId } } }],
      });
      const parsed = JSON.parse(json);
      expect(parsed.Messages[0].Payload.ref.UaType).to.equal(17);
      expect(parsed.Messages[0].Payload.ref.Value).to.equal("ns=2;s=Temperature");
    });
  });

  // ─── MessageType wire mapping ───

  describe("MessageType wire mapping", function () {
    const cases = [
      ["keyframe",   "ua-keyframe"],
      ["deltaframe", "ua-deltaframe"],
      ["event",      "ua-event"],
      ["keepalive",  "ua-keepalive"],
    ];
    for (const [model, wire] of cases) {
      it(`${model} → ${wire}`, function () {
        const json = encodeNetworkMessage({
          messageId: "m1",
          payload: [{ messageType: model, fields: {} }],
        });
        expect(JSON.parse(json).Messages[0].MessageType).to.equal(wire);
      });
    }
  });

  // ─── Round-trip ───

  describe("round-trip", function () {
    it("decode(encode(model)) preserves scalar fields and field order", function () {
      const model = {
        messageId: "rt-1",
        publisherId: "pub-A",
        payload: [{
          dataSetWriterId: 5,
          sequenceNumber: 42,
          messageType: "keyframe",
          fields: { a: { dataType: "Int32", value: 7 }, b: { dataType: "Double", value: 1.5 } },
        }],
      };
      const decoded = decodeNetworkMessage(encodeNetworkMessage(model));
      expect(decoded.messageId).to.equal("rt-1");
      expect(decoded.publisherId).to.equal("pub-A");
      expect(decoded.payload[0].fields.a).to.deep.equal({ dataType: 6, value: 7 });
      expect(decoded.payload[0].fields.b).to.deep.equal({ dataType: 11, value: 1.5 });
    });
  });

  // ─── NetworkMessage group header / timestamp / publisherId parity ───
  // (CR-02 writerGroupId, HI-01 NM timestamp, HI-02 publisherId type parity)

  describe("NetworkMessage group header (CR-02)", function () {
    it("emits NM-level WriterGroupId and SequenceNumber from groupHeader", function () {
      const json = encodeNetworkMessage({
        messageId: "m1",
        publisherId: "pub-A",
        groupHeader: { writerGroupId: 7, sequenceNumber: 3 },
        payload: [{ messageType: "keyframe", fields: {} }],
      });
      const parsed = JSON.parse(json);
      expect(parsed.WriterGroupId).to.equal(7);
      expect(parsed.SequenceNumber).to.equal(3);
    });

    it("round-trips groupHeader.writerGroupId so a writerGroupId filter can match", function () {
      const model = {
        messageId: "m1",
        publisherId: "pub-A",
        groupHeader: { writerGroupId: 42, sequenceNumber: 9 },
        payload: [{ dataSetWriterId: 1, messageType: "keyframe", fields: { a: { dataType: "Int32", value: 1 } } }],
      };
      const decoded = decodeNetworkMessage(encodeNetworkMessage(model));
      expect(decoded.groupHeader).to.be.an("object");
      expect(decoded.groupHeader.writerGroupId).to.equal(42);
      expect(decoded.groupHeader.sequenceNumber).to.equal(9);
    });
  });

  describe("NetworkMessage timestamp (HI-01)", function () {
    it("emits the NM-level timestamp and decodes it back into nm.timestamp", function () {
      const ts = new Date("2026-06-13T10:11:12.345Z");
      const json = encodeNetworkMessage({
        messageId: "m1",
        timestamp: ts,
        payload: [{ messageType: "keyframe", fields: {} }],
      });
      const parsed = JSON.parse(json);
      expect(parsed.Timestamp).to.equal("2026-06-13T10:11:12.345Z");

      const decoded = decodeNetworkMessage(json);
      expect(decoded.timestamp).to.be.an.instanceof(Date);
      expect(decoded.timestamp.toISOString()).to.equal(ts.toISOString());
    });
  });

  describe("PublisherId type parity (HI-02)", function () {
    it("round-trips a NUMERIC publisherId back to a number (not a string)", function () {
      const decoded = decodeNetworkMessage(
        encodeNetworkMessage({
          messageId: "m1",
          publisherId: 5,
          payload: [{ messageType: "keyframe", fields: {} }],
        })
      );
      expect(decoded.publisherId).to.equal(5);
      expect(typeof decoded.publisherId).to.equal("number");
    });

    it("round-trips a STRING publisherId back to a string", function () {
      const decoded = decodeNetworkMessage(
        encodeNetworkMessage({
          messageId: "m1",
          publisherId: "pub-A",
          payload: [{ messageType: "keyframe", fields: {} }],
        })
      );
      expect(decoded.publisherId).to.equal("pub-A");
      expect(typeof decoded.publisherId).to.equal("string");
    });
  });

  // ─── Structured decoder errors (D-08) ───

  describe("decodeNetworkMessage structured errors", function () {
    it("missing 'Messages' array throws { code: 'JSON_DECODE_MISSING_FIELD', path: 'Messages' }", function () {
      let caught = null;
      try { decodeNetworkMessage("{\"MessageId\":\"x\",\"MessageType\":\"ua-data\"}"); }
      catch (e) { caught = e; }
      expect(caught).to.not.equal(null);
      expect(caught.code).to.equal("JSON_DECODE_MISSING_FIELD");
      expect(caught.path).to.equal("Messages");
    });

    it("missing 'Payload' inside DataSetMessage throws with path 'Messages[0].Payload'", function () {
      let caught = null;
      try {
        decodeNetworkMessage("{\"MessageId\":\"x\",\"MessageType\":\"ua-data\",\"Messages\":[{\"DataSetWriterId\":1,\"MessageType\":\"ua-keyframe\"}]}");
      } catch (e) { caught = e; }
      expect(caught).to.not.equal(null);
      expect(caught.code).to.equal("JSON_DECODE_MISSING_FIELD");
      expect(caught.path).to.equal("Messages[0].Payload");
    });

    it("invalid JSON throws { code: 'JSON_DECODE_PARSE_ERROR' }", function () {
      let caught = null;
      try { decodeNetworkMessage("{not valid json"); }
      catch (e) { caught = e; }
      expect(caught.code).to.equal("JSON_DECODE_PARSE_ERROR");
    });
  });
});
