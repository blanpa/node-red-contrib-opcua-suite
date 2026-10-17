"use strict";

/**
 * Unit tests for lib/opcua-variant.js — turning JSON message values into
 * Variants. Every case is encoded and decoded with the OPC UA binary codec,
 * because several types used to be accepted by the Variant constructor and
 * only went wrong on the wire (an ExpandedNodeId string became ns=0;i=0).
 */

const { expect } = require("chai");
const {
  Variant,
  DataType,
  VariantArrayType,
  BinaryStream,
} = require("node-opcua");

const {
  buildVariant,
  resolveDataType,
  looksLikeStructure,
} = require("../lib/opcua-variant");

function roundTrip(variant) {
  const stream = new BinaryStream(variant.binaryStoreSize());
  variant.encode(stream);
  stream.rewind();
  const decoded = new Variant();
  decoded.decode(stream);
  return decoded;
}

function expectError(fn, text) {
  let error;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error, "expected an error").to.be.an("error");
  expect(error.message).to.include(text);
}

describe("opcua-variant buildVariant", function () {
  describe("resolveDataType", function () {
    it("resolves names and enum numbers", function () {
      expect(resolveDataType("UInt16")).to.equal(DataType.UInt16);
      expect(resolveDataType(DataType.Float)).to.equal(DataType.Float);
    });

    it("treats empty / auto as no type", function () {
      for (const v of [null, undefined, "", "auto", "Auto"]) {
        expect(resolveDataType(v)).to.equal(null);
      }
    });

    it("rejects unknown names", function () {
      expectError(() => resolveDataType("Integer32"), "Unknown DataType");
      expectError(() => resolveDataType(999), "Unknown DataType");
    });
  });

  describe("scalar types from JSON values", function () {
    const cases = [
      ["Boolean", true, true],
      ["Boolean", "false", false],
      ["Boolean", 1, true],
      ["SByte", -5, -5],
      ["Byte", 200, 200],
      ["Int16", -300, -300],
      ["UInt16", 60000, 60000],
      ["Int32", -70000, -70000],
      ["UInt32", 4000000000, 4000000000],
      ["Int32", "42", 42],
      ["Float", 1.5, 1.5],
      ["Double", 2.5, 2.5],
      ["String", "x", "x"],
      ["String", 5, "5"],
      ["XmlElement", "<a/>", "<a/>"],
      ["Guid", "72962B91-FA75-4AE6-8D28-B404DC7DAF63"],
      ["StatusCode", "Good"],
    ];

    for (const [type, input, expected] of cases) {
      it(`${type} from ${JSON.stringify(input)}`, function () {
        const decoded = roundTrip(buildVariant(input, type));
        expect(decoded.dataType).to.equal(DataType[type]);
        if (expected !== undefined) {
          expect(decoded.value).to.deep.equal(expected);
        }
      });
    }

    it("DateTime from an ISO string", function () {
      const decoded = roundTrip(
        buildVariant("2026-01-01T12:00:00Z", "DateTime"),
      );
      expect(decoded.dataType).to.equal(DataType.DateTime);
      expect(decoded.value.toISOString()).to.equal("2026-01-01T12:00:00.000Z");
    });

    it("DateTime from epoch milliseconds (inject timestamp)", function () {
      const decoded = roundTrip(buildVariant(1767268800000, "DateTime"));
      expect(decoded.value.getTime()).to.equal(1767268800000);
    });

    it("DateTime rejects an invalid string with a message", function () {
      expectError(
        () => buildVariant("tomorrow-ish", "DateTime"),
        'Invalid DateTime value "tomorrow-ish"',
      );
    });

    it("NodeId from a string", function () {
      const decoded = roundTrip(buildVariant("ns=2;s=Foo", "NodeId"));
      expect(decoded.dataType).to.equal(DataType.NodeId);
      expect(decoded.value.toString()).to.equal("ns=2;s=Foo");
    });

    it("NodeId from a well-known name", function () {
      const decoded = roundTrip(buildVariant("Server", "NodeId"));
      expect(decoded.value.toString()).to.equal("ns=0;i=2253");
    });

    it("ExpandedNodeId from a string keeps the identifier", function () {
      const decoded = roundTrip(buildVariant("ns=2;s=Foo", "ExpandedNodeId"));
      expect(decoded.dataType).to.equal(DataType.ExpandedNodeId);
      expect(decoded.value.toString()).to.equal("ns=2;s=Foo");
    });

    it("ExpandedNodeId with namespace URI and server index", function () {
      const decoded = roundTrip(
        buildVariant(
          "svr=1;nsu=http://example.org/UA/;s=Foo",
          "ExpandedNodeId",
        ),
      );
      expect(decoded.value.value).to.equal("Foo");
      expect(decoded.value.namespaceUri).to.equal("http://example.org/UA/");
      expect(decoded.value.serverIndex).to.equal(1);
    });

    it("ByteString from base64", function () {
      const decoded = roundTrip(buildVariant("aGVsbG8=", "ByteString"));
      expect(decoded.value.toString()).to.equal("hello");
    });

    it("ByteString from a byte array and a serialized Buffer", function () {
      expect(
        roundTrip(buildVariant([104, 105], "ByteString")).value.toString(),
      ).to.equal("hi");
      expect(
        roundTrip(
          buildVariant({ type: "Buffer", data: [104, 105] }, "ByteString"),
        ).value.toString(),
      ).to.equal("hi");
    });

    it("ByteString rejects plain text instead of garbling it", function () {
      expectError(() => buildVariant("hello", "ByteString"), "base64");
    });

    it("Int64 from a number, a decimal string and a BigInt", function () {
      expect(roundTrip(buildVariant(123, "Int64")).value).to.deep.equal([
        0, 123,
      ]);
      expect(
        roundTrip(buildVariant("9007199254740993", "Int64")).value,
      ).to.deep.equal([2097152, 1]);
      expect(roundTrip(buildVariant(5n, "UInt64")).value).to.deep.equal([0, 5]);
    });

    it("Int64 accepts the [high, low] form a read delivers", function () {
      const decoded = roundTrip(buildVariant([0, 7], "Int64"));
      expect(decoded.arrayType).to.equal(VariantArrayType.Scalar);
      expect(decoded.value).to.deep.equal([0, 7]);
    });

    it("QualifiedName and LocalizedText from strings and objects", function () {
      expect(
        roundTrip(buildVariant("2:Foo", "QualifiedName")).value.toString(),
      ).to.equal("2:Foo");
      const lt = roundTrip(
        buildVariant({ locale: "de", text: "hallo" }, "LocalizedText"),
      ).value;
      expect(lt.locale).to.equal("de");
      expect(lt.text).to.equal("hallo");
    });

    it("Variant uses the type carried by the value", function () {
      const decoded = roundTrip(
        buildVariant({ dataType: "UInt16", value: 7 }, "Variant"),
      );
      expect(decoded.dataType).to.equal(DataType.UInt16);
      expect(decoded.value).to.equal(7);
    });

    it("Variant without a type infers it instead of writing Null", function () {
      const decoded = roundTrip(buildVariant(2.5, "Variant"));
      expect(decoded.dataType).to.equal(DataType.Double);
    });

    it("names the type and value when node-opcua rejects it", function () {
      expectError(() => buildVariant(300, "Byte"), "Invalid Byte value 300");
    });
  });

  describe("arrays", function () {
    it("converts every element", function () {
      const decoded = roundTrip(
        buildVariant(["2026-01-01T00:00:00Z", 0], "DateTime", "Array"),
      );
      expect(decoded.arrayType).to.equal(VariantArrayType.Array);
      expect(decoded.value.map((d) => d.getTime())).to.deep.equal([
        1767225600000, 0,
      ]);
    });

    it("an explicit type with a JS array still makes an array", function () {
      const decoded = roundTrip(buildVariant([1, 2, 3], "Int16"));
      expect(decoded.arrayType).to.equal(VariantArrayType.Array);
      expect(Array.from(decoded.value)).to.deep.equal([1, 2, 3]);
    });

    it("an Int64 array needs arrayType to tell it from [high, low]", function () {
      const decoded = roundTrip(buildVariant([5, 6], "Int64", "Array"));
      expect(decoded.arrayType).to.equal(VariantArrayType.Array);
      expect(decoded.value).to.deep.equal([
        [0, 5],
        [0, 6],
      ]);
    });

    it("rejects a scalar when an array is required", function () {
      expectError(() => buildVariant(5, "Int32", "Array"), "Array value");
    });
  });

  describe("auto detection", function () {
    it("keeps the JS type mapping", function () {
      expect(buildVariant(true).dataType).to.equal(DataType.Boolean);
      expect(buildVariant(42).dataType).to.equal(DataType.Int32);
      expect(buildVariant(4.2).dataType).to.equal(DataType.Double);
      expect(buildVariant("s").dataType).to.equal(DataType.String);
      expect(buildVariant(new Date()).dataType).to.equal(DataType.DateTime);
      expect(buildVariant(Buffer.from("x")).dataType).to.equal(
        DataType.ByteString,
      );
    });

    it("recognises structure values", function () {
      expect(looksLikeStructure({ a: 1 })).to.equal(true);
      expect(looksLikeStructure([{ a: 1 }])).to.equal(true);
      expect(looksLikeStructure({ type: "Buffer", data: [] })).to.equal(false);
      expect(looksLikeStructure([1, 2])).to.equal(false);
      expect(looksLikeStructure(new Date())).to.equal(false);
    });
  });
});
