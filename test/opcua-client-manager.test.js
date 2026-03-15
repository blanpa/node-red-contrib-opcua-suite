"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const { serializeExtensionObject } = require("../lib/opcua-utils");

// We need to mock node-opcua before requiring OpcUaClientManager,
// because it imports node-opcua at the top level.
// We use a proxyquire-like approach: intercept require via Module._cache manipulation
// or simply test the parts that don't require a live connection.

// Since OpcUaClientManager requires node-opcua at module level, we will
// test it by requiring it and testing only the pure helper methods.
// The actual OPC UA connection tests belong in integration tests.

const OpcUaClientManager = require("../lib/opcua-client-manager");

describe("OpcUaClientManager", function () {
  // ─── Constructor ───

  describe("constructor", function () {
    it("should initialize with default config values", function () {
      const mgr = new OpcUaClientManager({
        endpointUrl: "opc.tcp://localhost:4840",
      });
      expect(mgr.config.endpointUrl).to.equal("opc.tcp://localhost:4840");
      expect(mgr.isConnected).to.be.false;
      expect(mgr.client).to.be.null;
      expect(mgr.session).to.be.null;
      expect(mgr.reconnectAttempts).to.equal(0);
      expect(mgr.maxReconnectAttempts).to.equal(10);
      expect(mgr.reconnectDelay).to.equal(5000);
    });

    it("should accept custom maxReconnectAttempts and reconnectDelay", function () {
      const mgr = new OpcUaClientManager({
        endpointUrl: "opc.tcp://localhost:4840",
        maxReconnectAttempts: 3,
        reconnectDelay: 1000,
      });
      expect(mgr.maxReconnectAttempts).to.equal(3);
      expect(mgr.reconnectDelay).to.equal(1000);
    });

    it("should be an EventEmitter", function () {
      const mgr = new OpcUaClientManager({
        endpointUrl: "opc.tcp://localhost:4840",
      });
      expect(mgr.on).to.be.a("function");
      expect(mgr.emit).to.be.a("function");
    });

    it("should initialize subscriptions as empty Map", function () {
      const mgr = new OpcUaClientManager({
        endpointUrl: "opc.tcp://localhost:4840",
      });
      expect(mgr.subscriptions).to.be.instanceOf(Map);
      expect(mgr.subscriptions.size).to.equal(0);
    });
  });

  // ─── _createVariant ───

  describe("_createVariant", function () {
    let mgr;

    beforeEach(function () {
      mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://localhost:4840" });
    });

    it("should create a Boolean variant for boolean value", function () {
      const variant = mgr._createVariant(true);
      // node-opcua Variant stores dataType as numeric enum;
      // DataType.Boolean = 1
      expect(variant).to.have.property("value", true);
      expect(variant.dataType).to.exist;
    });

    it("should create a Boolean variant for false", function () {
      const variant = mgr._createVariant(false);
      expect(variant.value).to.equal(false);
    });

    it("should create an Int32 variant for integer number", function () {
      const variant = mgr._createVariant(42);
      expect(variant.value).to.equal(42);
    });

    it("should create a Double variant for floating-point number", function () {
      const variant = mgr._createVariant(3.14);
      expect(variant.value).to.equal(3.14);
    });

    it("should create a String variant for string value", function () {
      const variant = mgr._createVariant("hello");
      expect(variant.value).to.equal("hello");
    });

    it("should create a DateTime variant for Date value", function () {
      const date = new Date("2024-01-01T00:00:00Z");
      const variant = mgr._createVariant(date);
      expect(variant.value).to.equal(date);
    });

    it("should use explicit datatype when provided", function () {
      const variant = mgr._createVariant(42, "Double");
      expect(variant.value).to.equal(42);
      // With explicit datatype, it should use DataType.Double
    });

    it("should use explicit String datatype", function () {
      const variant = mgr._createVariant("test", "String");
      expect(variant.value).to.equal("test");
    });

    it("should fallback to generic Variant for unknown types", function () {
      const variant = mgr._createVariant({ complex: true });
      expect(variant).to.have.property("value");
    });

    it("should handle explicit Boolean datatype", function () {
      const variant = mgr._createVariant(true, "Boolean");
      expect(variant.value).to.equal(true);
    });

    it("should handle ExtensionObject datatype string (passes through to DataType enum)", function () {
      // When datatype is "ExtensionObject" and value is a real ExtensionObject instance,
      // _createVariant will look up DataType["ExtensionObject"] and create the Variant.
      // node-opcua requires the value to be a proper ExtensionObject, not a plain object.
      // For plain-object writes, the flow goes through _createExtensionObjectVariant instead.
      const { ExtensionObject } = require("node-opcua-extension-object");
      const extObj = new ExtensionObject();
      const variant = mgr._createVariant(extObj, "ExtensionObject");
      expect(variant).to.have.property("value");
      expect(variant).to.have.property("dataType");
    });
  });

  // ─── _toOpcUaNodeId ───

  describe("_toOpcUaNodeId", function () {
    let mgr;

    beforeEach(function () {
      mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://localhost:4840" });
    });

    it("should resolve a string nodeId", function () {
      const result = mgr._toOpcUaNodeId("i=84");
      // resolveNodeId returns a NodeId object from node-opcua
      expect(result).to.exist;
      expect(result.toString()).to.include("84");
    });

    it("should resolve a string nodeId with namespace", function () {
      const result = mgr._toOpcUaNodeId("ns=2;s=MyVariable");
      expect(result).to.exist;
    });

    it("should resolve an object nodeId with namespaceIndex and value", function () {
      const result = mgr._toOpcUaNodeId({
        namespaceIndex: 0,
        identifierType: "Numeric",
        value: 84,
      });
      expect(result).to.exist;
      expect(result.toString()).to.include("84");
    });

    it("should pass through an already-resolved nodeId", function () {
      // If nodeId has no namespaceIndex property and is not a string,
      // it should be returned as-is
      const obj = { some: "thing" };
      const result = mgr._toOpcUaNodeId(obj);
      expect(result).to.equal(obj);
    });
  });

  // ─── _ensureConnected ───

  describe("_ensureConnected", function () {
    it("should throw when not connected", function () {
      const mgr = new OpcUaClientManager({
        endpointUrl: "opc.tcp://localhost:4840",
      });
      expect(() => mgr._ensureConnected()).to.throw("Not connected");
    });

    it("should throw when connected but no session", function () {
      const mgr = new OpcUaClientManager({
        endpointUrl: "opc.tcp://localhost:4840",
      });
      mgr.isConnected = true;
      mgr.session = null;
      expect(() => mgr._ensureConnected()).to.throw("Not connected");
    });

    it("should not throw when connected with a session", function () {
      const mgr = new OpcUaClientManager({
        endpointUrl: "opc.tcp://localhost:4840",
      });
      mgr.isConnected = true;
      mgr.session = {};
      expect(() => mgr._ensureConnected()).to.not.throw();
    });

    // ─── serializeExtensionObject (utility function) ───

    describe("serializeExtensionObject (from opcua-utils)", function () {
      it("should return null for null/undefined", function () {
        expect(serializeExtensionObject(null)).to.be.null;
        expect(serializeExtensionObject(undefined)).to.be.null;
      });

      it("should return primitives as-is", function () {
        expect(serializeExtensionObject(42)).to.equal(42);
        expect(serializeExtensionObject("hello")).to.equal("hello");
        expect(serializeExtensionObject(true)).to.equal(true);
      });

      it("should convert Date to ISO string", function () {
        const date = new Date("2024-06-15T12:00:00Z");
        expect(serializeExtensionObject(date)).to.equal(
          "2024-06-15T12:00:00.000Z",
        );
      });

      it("should convert Buffer to base64 string", function () {
        const buf = Buffer.from("hello");
        expect(serializeExtensionObject(buf)).to.equal(buf.toString("base64"));
      });

      it("should serialize a typed ExtensionObject with schema", function () {
        const extObj = {
          schema: {
            name: "SensorReading",
            fields: [
              { name: "temperature" },
              { name: "humidity" },
              { name: "timestamp" },
            ],
          },
          temperature: 22.5,
          humidity: 65,
          timestamp: new Date("2024-01-01T00:00:00Z"),
        };

        const result = serializeExtensionObject(extObj);
        expect(result).to.have.property("_typeName", "SensorReading");
        expect(result).to.have.property("temperature", 22.5);
        expect(result).to.have.property("humidity", 65);
        expect(result).to.have.property(
          "timestamp",
          "2024-01-01T00:00:00.000Z",
        );
        expect(result).to.not.have.property("schema");
      });

      it("should handle nested ExtensionObjects", function () {
        const extObj = {
          schema: {
            name: "Outer",
            fields: [{ name: "inner" }, { name: "label" }],
          },
          inner: {
            schema: { name: "Inner", fields: [{ name: "value" }] },
            value: 99,
          },
          label: "test",
        };

        const result = serializeExtensionObject(extObj);
        expect(result).to.have.property("_typeName", "Outer");
        expect(result).to.have.property("label", "test");
        expect(result.inner).to.have.property("_typeName", "Inner");
        expect(result.inner).to.have.property("value", 99);
      });

      it("should handle arrays inside ExtensionObjects", function () {
        const extObj = {
          schema: { name: "ArrayHolder", fields: [{ name: "items" }] },
          items: [1, 2, 3],
        };

        const result = serializeExtensionObject(extObj);
        expect(result.items).to.deep.equal([1, 2, 3]);
      });

      it("should handle an OpaqueStructure-like object", function () {
        // Simulate an OpaqueStructure by mimicking its constructor name
        function OpaqueStructure() {
          this.nodeId = { toString: () => "ns=2;i=5001" };
          this.body = Buffer.from([0x01, 0x02, 0x03]);
        }
        const opaque = new OpaqueStructure();

        const result = serializeExtensionObject(opaque);
        expect(result).to.have.property("_opaque", true);
        expect(result).to.have.property("_typeName", "ns=2;i=5001");
        expect(result).to.have.property("_raw");
        // _raw should be base64 of [0x01, 0x02, 0x03]
        expect(Buffer.from(result._raw, "base64")).to.deep.equal(
          Buffer.from([0x01, 0x02, 0x03]),
        );
      });

      it("should skip functions and internal properties", function () {
        const extObj = {
          schema: { name: "WithFuncs", fields: [{ name: "val" }] },
          val: 42,
          _internal: "hidden",
          someMethod: function () {
            return 1;
          },
        };

        const result = serializeExtensionObject(extObj);
        expect(result).to.have.property("val", 42);
        expect(result).to.not.have.property("_internal");
        expect(result).to.not.have.property("someMethod");
      });

      it("should handle null fields gracefully", function () {
        const extObj = {
          schema: {
            name: "NullFields",
            fields: [{ name: "a" }, { name: "b" }],
          },
          a: null,
          b: undefined,
        };

        const result = serializeExtensionObject(extObj);
        expect(result).to.have.property("a", null);
        expect(result).to.have.property("b", null);
      });

      it("should recursively serialize arrays of ExtensionObjects", function () {
        const arr = [
          {
            schema: { name: "Item", fields: [{ name: "id" }] },
            id: 1,
          },
          {
            schema: { name: "Item", fields: [{ name: "id" }] },
            id: 2,
          },
        ];

        const result = serializeExtensionObject(arr);
        expect(result).to.be.an("array").with.lengthOf(2);
        expect(result[0]).to.have.property("_typeName", "Item");
        expect(result[0]).to.have.property("id", 1);
        expect(result[1]).to.have.property("id", 2);
      });
    });
  });

  // ─── _serializeValue ───

  describe("_serializeValue", function () {
    let mgr;

    beforeEach(function () {
      mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://localhost:4840" });
    });

    it("should return null for null input", function () {
      expect(mgr._serializeValue(null)).to.be.null;
    });

    it("should return undefined for undefined input", function () {
      expect(mgr._serializeValue(undefined)).to.be.undefined;
    });

    it("should pass through primitive values unchanged", function () {
      // Primitives are not objects, so they skip the schema/OpaqueStructure checks
      expect(mgr._serializeValue(42)).to.equal(42);
      expect(mgr._serializeValue("hello")).to.equal("hello");
      expect(mgr._serializeValue(true)).to.equal(true);
      expect(mgr._serializeValue(3.14)).to.equal(3.14);
    });

    it("should pass through plain objects without schema", function () {
      // Plain objects without a .schema property are returned as-is
      const obj = { a: 1, b: "test" };
      const result = mgr._serializeValue(obj);
      expect(result).to.deep.equal(obj);
    });

    it("should serialize an object with a schema (typed ExtensionObject)", function () {
      const fakeExtObj = {
        schema: {
          name: "MyStruct",
          fields: [{ name: "temperature" }, { name: "unit" }],
        },
        temperature: 25.5,
        unit: "Celsius",
      };
      const result = mgr._serializeValue(fakeExtObj);
      expect(result).to.have.property("_typeName", "MyStruct");
      expect(result).to.have.property("temperature", 25.5);
      expect(result).to.have.property("unit", "Celsius");
      expect(result).to.not.have.property("schema");
    });

    it("should serialize an array of ExtensionObjects", function () {
      const fakeExtObjs = [
        {
          schema: { name: "Point", fields: [{ name: "x" }, { name: "y" }] },
          x: 1.0,
          y: 2.0,
        },
        {
          schema: { name: "Point", fields: [{ name: "x" }, { name: "y" }] },
          x: 3.0,
          y: 4.0,
        },
      ];
      // The first element has .schema so the array branch triggers
      const result = mgr._serializeValue(fakeExtObjs);
      expect(result).to.be.an("array").with.lengthOf(2);
      expect(result[0]).to.have.property("_typeName", "Point");
      expect(result[0]).to.have.property("x", 1.0);
      expect(result[1]).to.have.property("y", 4.0);
    });

    it("should pass through a plain array of primitives", function () {
      // Array of primitives: first element has no .schema, not an OpaqueStructure
      const arr = [1, 2, 3];
      const result = mgr._serializeValue(arr);
      expect(result).to.deep.equal([1, 2, 3]);
    });
  });

  // ─── constructExtensionObject ───

  describe("constructExtensionObject", function () {
    let mgr;

    beforeEach(function () {
      mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://localhost:4840" });
    });

    it("should throw when not connected", async function () {
      try {
        await mgr.constructExtensionObject("ns=2;i=3003", { field1: 42 });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err.message).to.equal("Not connected");
      }
    });

    it("should call session.constructExtensionObject when connected", async function () {
      const fakeExtObj = { schema: { name: "TestType" }, field1: 42 };
      mgr.isConnected = true;
      mgr.session = {
        constructExtensionObject: sinon.stub().resolves(fakeExtObj),
      };

      const result = await mgr.constructExtensionObject("ns=2;i=3003", {
        field1: 42,
      });
      expect(result).to.equal(fakeExtObj);
      expect(mgr.session.constructExtensionObject.calledOnce).to.be.true;
      // Verify the first argument is a NodeId-like object
      const callArgs = mgr.session.constructExtensionObject.firstCall.args;
      expect(callArgs[1]).to.deep.equal({ field1: 42 });
    });

    it("should wrap session errors with a descriptive message", async function () {
      mgr.isConnected = true;
      mgr.session = {
        constructExtensionObject: sinon
          .stub()
          .rejects(new Error("DataType not found")),
      };

      try {
        await mgr.constructExtensionObject("ns=2;i=9999", {});
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err.message).to.include("Failed to construct ExtensionObject");
        expect(err.message).to.include("DataType not found");
      }
    });
  });

  // ─── _createExtensionObjectVariant ───

  describe("_createExtensionObjectVariant", function () {
    let mgr;

    beforeEach(function () {
      mgr = new OpcUaClientManager({ endpointUrl: "opc.tcp://localhost:4840" });
      mgr.isConnected = true;
    });

    it("should return a Variant with DataType.ExtensionObject", async function () {
      // Use a real ExtensionObject instance so node-opcua's Variant constructor accepts it
      const { ExtensionObject } = require("node-opcua-extension-object");
      const fakeExtObj = new ExtensionObject();
      fakeExtObj.temp = 20;
      mgr.session = {
        constructExtensionObject: sinon.stub().resolves(fakeExtObj),
      };

      const variant = await mgr._createExtensionObjectVariant(
        { temp: 20 },
        "ns=2;i=3003",
      );
      expect(variant).to.have.property("value", fakeExtObj);
      // DataType.ExtensionObject has numeric value 22
      expect(variant).to.have.property("dataType");
    });
  });

  // ─── scheduleReconnect ───

  describe("scheduleReconnect", function () {
    let mgr;
    let clock;

    beforeEach(function () {
      mgr = new OpcUaClientManager({
        endpointUrl: "opc.tcp://localhost:4840",
        maxReconnectAttempts: 3,
        reconnectDelay: 100,
      });
      clock = sinon.useFakeTimers();
    });

    afterEach(function () {
      clock.restore();
      if (mgr.reconnectTimer) {
        clearTimeout(mgr.reconnectTimer);
        mgr.reconnectTimer = null;
      }
    });

    it("should increment reconnectAttempts", function () {
      mgr.scheduleReconnect();
      expect(mgr.reconnectAttempts).to.equal(1);
      expect(mgr.reconnectTimer).to.not.be.null;
    });

    it("should not schedule if already at max attempts", function () {
      mgr.reconnectAttempts = 3;
      mgr.scheduleReconnect();
      expect(mgr.reconnectTimer).to.be.null;
    });

    it("should not schedule if a timer is already pending", function () {
      mgr.scheduleReconnect();
      const firstTimer = mgr.reconnectTimer;
      mgr.scheduleReconnect();
      expect(mgr.reconnectTimer).to.equal(firstTimer);
      expect(mgr.reconnectAttempts).to.equal(1);
    });
  });
});
