"use strict";

/**
 * Integration test: writing every kind of value through OpcUaClientManager
 * to a real node-opcua server and reading it back.
 *
 * Covers the JSON-to-Variant conversion (DateTime / NodeId / ExpandedNodeId /
 * ByteString / Int64 from plain message values) and user-defined structures
 * (UDTs): nested structures, arrays of structures — which used to be
 * replaced by a single default record while the server answered Good — and
 * writes without a dataTypeNodeId, which is now read from the variable.
 */

const { expect } = require("chai");
const {
  OPCUAServer,
  DataType,
  Variant,
  VariantArrayType,
  StatusCodes,
  MessageSecurityMode,
  SecurityPolicy,
  resolveNodeId,
  ExpandedNodeId,
} = require("node-opcua");

const OpcUaClientManager = require("../lib/opcua-client-manager");

const PORT = 48600 + Math.floor(Math.random() * 300);
const ENDPOINT = `opc.tcp://localhost:${PORT}/UA/DataTypeTest`;

describe("Integration: data types and UDT writes", function () {
  this.timeout(60000);

  let server;
  let mgr;

  before(async function () {
    server = new OPCUAServer({
      port: PORT,
      resourcePath: "/UA/DataTypeTest",
      securityModes: [MessageSecurityMode.None],
      securityPolicies: [SecurityPolicy.None],
      allowAnonymous: true,
    });
    await server.initialize();

    const addressSpace = server.engine.addressSpace;
    const ns = addressSpace.getOwnNamespace();
    const objects = addressSpace.rootFolder.objects;
    const dtm = addressSpace.getDataTypeManager();

    // Same registration steps as test-server/server.js
    async function registerStructure(dataType) {
      const enc = ns.addObject({ browseName: "Default Binary" });
      dataType.addReference({
        referenceType: "HasEncoding",
        isForward: true,
        nodeId: enc.nodeId,
      });
      if (dataType._cache) dataType._cache._encoding = undefined;
      await dtm.getExtensionObjectConstructorFromDataTypeAsync(dataType.nodeId);
    }
    function construct(dataType, fields) {
      const obj = addressSpace.constructExtensionObject(
        dataType.nodeId,
        fields,
      );
      if (
        obj.schema &&
        (!obj.schema.encodingDefaultBinary ||
          obj.schema.encodingDefaultBinary.isEmpty())
      ) {
        obj.schema.encodingDefaultBinary = dataType.binaryEncodingNodeId;
      }
      return obj;
    }
    const rw = "CurrentRead | CurrentWrite";
    function addVariable(name, dataType, value, valueRank = -1) {
      ns.addVariable({
        organizedBy: objects,
        browseName: name,
        nodeId: `s=${name}`,
        dataType,
        valueRank,
        accessLevel: rw,
        userAccessLevel: rw,
        value,
      });
    }

    const mode = ns.addEnumerationType({
      browseName: "ModeEnum",
      enumeration: ["Off", "On", "Fault"],
    });
    const inner = ns.createDataType({
      browseName: "InnerType",
      nodeId: "s=InnerType",
      isAbstract: false,
      subtypeOf: "Structure",
      partialDefinition: [
        { name: "A", dataType: DataType.Double },
        { name: "B", dataType: DataType.String },
      ],
    });
    await registerStructure(inner);
    const outer = ns.createDataType({
      browseName: "OuterType",
      nodeId: "s=OuterType",
      isAbstract: false,
      subtypeOf: "Structure",
      partialDefinition: [
        { name: "Name", dataType: DataType.String },
        { name: "Inner", dataType: inner.nodeId },
        { name: "Values", dataType: DataType.Double, valueRank: 1 },
        { name: "Mode", dataType: mode.nodeId },
        { name: "Big", dataType: DataType.Int64 },
        { name: "When", dataType: DataType.DateTime },
      ],
    });
    await registerStructure(outer);

    addVariable(
      "Outer",
      outer.nodeId,
      new Variant({
        dataType: DataType.ExtensionObject,
        value: construct(outer, {
          name: "x",
          inner: { a: 1.5, b: "in" },
          values: [1, 2, 3],
          mode: 1,
          big: [0, 7],
          when: new Date(0),
        }),
      }),
    );
    addVariable(
      "InnerArr",
      inner.nodeId,
      new Variant({
        dataType: DataType.ExtensionObject,
        arrayType: VariantArrayType.Array,
        value: [construct(inner, { a: 1, b: "p" })],
      }),
      1,
    );

    const scalars = {
      DateTimeVar: [DataType.DateTime, new Date(0)],
      NodeIdVar: [DataType.NodeId, resolveNodeId("i=85")],
      ExpandedNodeIdVar: [
        DataType.ExpandedNodeId,
        ExpandedNodeId.fromNodeId(resolveNodeId("i=85")),
      ],
      ByteStringVar: [DataType.ByteString, Buffer.alloc(0)],
      Int64Var: [DataType.Int64, [0, 0]],
      LocalizedTextVar: [DataType.LocalizedText, { text: "" }],
    };
    for (const [name, [dataType, value]] of Object.entries(scalars)) {
      addVariable(
        name,
        dataType,
        new Variant({ dataType, arrayType: VariantArrayType.Scalar, value }),
      );
    }

    const methodHolder = ns.addObject({
      organizedBy: objects,
      browseName: "Methods",
      nodeId: "s=Methods",
    });
    const echo = ns.addMethod(methodHolder, {
      browseName: "EchoDate",
      nodeId: "s=EchoDate",
      inputArguments: [{ name: "when", dataType: DataType.DateTime }],
      outputArguments: [{ name: "iso", dataType: DataType.String }],
    });
    echo.bindMethod((inputArguments, _context, callback) => {
      callback(null, {
        statusCode: StatusCodes.Good,
        outputArguments: [
          {
            dataType: DataType.String,
            value: inputArguments[0].value.toISOString(),
          },
        ],
      });
    });

    await server.start();

    mgr = new OpcUaClientManager({
      endpointUrl: ENDPOINT,
      operationTimeout: 10000,
      maxReconnectAttempts: 0,
    });
    await mgr.connect();
  });

  after(async function () {
    if (mgr) await mgr.disconnect();
    if (server) await server.shutdown();
  });

  async function readValue(nodeId) {
    return (await mgr.read(nodeId)).value;
  }

  // ─── Built-in types from plain JSON ───

  it("writes a DateTime given as ISO string and as epoch ms", async function () {
    await mgr.write("ns=1;s=DateTimeVar", "2026-05-01T08:00:00Z", "DateTime");
    expect((await readValue("ns=1;s=DateTimeVar")).toISOString()).to.equal(
      "2026-05-01T08:00:00.000Z",
    );
    await mgr.write("ns=1;s=DateTimeVar", 1000, "DateTime");
    expect((await readValue("ns=1;s=DateTimeVar")).getTime()).to.equal(1000);
  });

  it("writes NodeId and ExpandedNodeId strings faithfully", async function () {
    await mgr.write("ns=1;s=NodeIdVar", "ns=1;s=Outer", "NodeId");
    expect(String(await readValue("ns=1;s=NodeIdVar"))).to.equal(
      "ns=1;s=Outer",
    );
    await mgr.write(
      "ns=1;s=ExpandedNodeIdVar",
      "ns=1;s=Outer",
      "ExpandedNodeId",
    );
    // Used to arrive as ns=0;i=0 with a Good status.
    expect(String(await readValue("ns=1;s=ExpandedNodeIdVar"))).to.equal(
      "ns=1;s=Outer",
    );
  });

  it("writes a ByteString given as base64", async function () {
    await mgr.write("ns=1;s=ByteStringVar", "aGVsbG8=", "ByteString");
    expect((await readValue("ns=1;s=ByteStringVar")).toString()).to.equal(
      "hello",
    );
  });

  it("writes back an Int64 exactly as it was read", async function () {
    await mgr.write("ns=1;s=Int64Var", "9007199254740993", "Int64");
    const read = await readValue("ns=1;s=Int64Var");
    expect(read).to.deep.equal([2097152, 1]);
    const res = await mgr.write("ns=1;s=Int64Var", read, "Int64");
    expect(res.statusCode).to.match(/^Good/);
    expect(await readValue("ns=1;s=Int64Var")).to.deep.equal([2097152, 1]);
  });

  it("auto mode writes a built-in object type using the variable's DataType", async function () {
    await mgr.write("ns=1;s=LocalizedTextVar", { locale: "de", text: "Hallo" });
    const lt = await readValue("ns=1;s=LocalizedTextVar");
    expect(lt.text).to.equal("Hallo");
    expect(lt.locale).to.equal("de");
  });

  it("rejects an unknown datatype name", async function () {
    let error;
    try {
      await mgr.write("ns=1;s=DateTimeVar", 1, "Dattime");
    } catch (e) {
      error = e;
    }
    expect(error).to.be.an("error");
    expect(error.message).to.include("Unknown DataType: Dattime");
  });

  it("converts method arguments the same way", async function () {
    const result = await mgr.callMethod("ns=1;s=Methods", "ns=1;s=EchoDate", [
      { dataType: "DateTime", value: "2026-03-04T05:06:07Z" },
    ]);
    expect(result.statusCode).to.match(/^Good/);
    expect(result.outputArguments[0].value).to.equal(
      "2026-03-04T05:06:07.000Z",
    );
  });

  // ─── UDTs ───

  it("reads a nested UDT as JSON", async function () {
    const value = await readValue("ns=1;s=Outer");
    expect(value._typeName).to.equal("OuterType");
    expect(value.inner).to.include({ a: 1.5, b: "in" });
    expect(value.values).to.deep.equal([1, 2, 3]);
  });

  it("writes a nested UDT with an explicit dataTypeNodeId", async function () {
    await mgr.write(
      "ns=1;s=Outer",
      {
        name: "y",
        inner: { a: 9, b: "nest" },
        values: [4, 5],
        mode: 2,
        big: 5,
        when: "2026-01-01T00:00:00Z",
      },
      "ExtensionObject",
      "ns=1;s=OuterType",
    );
    const value = await readValue("ns=1;s=Outer");
    expect(value.name).to.equal("y");
    expect(value.inner).to.include({ a: 9, b: "nest" });
    expect(value.values).to.deep.equal([4, 5]);
    expect(value.mode).to.equal(2);
    expect(value.big).to.deep.equal([0, 5]);
    expect(value.when).to.equal("2026-01-01T00:00:00.000Z");
  });

  it("writes a UDT without dataTypeNodeId (read from the variable)", async function () {
    await mgr.write("ns=1;s=Outer", { name: "auto-dt" }, "ExtensionObject");
    expect((await readValue("ns=1;s=Outer")).name).to.equal("auto-dt");
  });

  it("writes a UDT in auto mode with no type information at all", async function () {
    await mgr.write("ns=1;s=Outer", {
      name: "auto",
      inner: { a: 2, b: "z" },
    });
    const value = await readValue("ns=1;s=Outer");
    expect(value.name).to.equal("auto");
    expect(value.inner).to.include({ a: 2, b: "z" });
  });

  it("writes back a UDT exactly as it was read", async function () {
    const before = await readValue("ns=1;s=Outer");
    await mgr.write("ns=1;s=Outer", before);
    expect(await readValue("ns=1;s=Outer")).to.deep.equal(before);
  });

  it("resets fields a partial UDT write leaves out (documented)", async function () {
    await mgr.write("ns=1;s=Outer", { name: "full", values: [1] });
    await mgr.write("ns=1;s=Outer", { name: "partial" });
    const value = await readValue("ns=1;s=Outer");
    expect(value.name).to.equal("partial");
    expect(value.values).to.deep.equal([]);
  });

  it("writes an array of UDTs", async function () {
    const res = await mgr.write(
      "ns=1;s=InnerArr",
      [
        { a: 7, b: "r" },
        { a: 8, b: "s" },
      ],
      "ExtensionObject",
      "ns=1;s=InnerType",
      "Array",
    );
    expect(res.statusCode).to.match(/^Good/);
    const value = await readValue("ns=1;s=InnerArr");
    expect(value).to.have.length(2);
    expect(value[0]).to.include({ a: 7, b: "r" });
    expect(value[1]).to.include({ a: 8, b: "s" });
  });

  it("writes an array of UDTs in auto mode", async function () {
    await mgr.write("ns=1;s=InnerArr", [
      { a: 1, b: "one" },
      { a: 2, b: "two" },
      { a: 3, b: "three" },
    ]);
    const value = await readValue("ns=1;s=InnerArr");
    expect(value.map((v) => v.b)).to.deep.equal(["one", "two", "three"]);
  });

  it("writeMultiple mixes UDTs and converted built-ins", async function () {
    const results = await mgr.writeMultiple([
      {
        nodeId: "ns=1;s=Outer",
        value: { name: "multi" },
        datatype: "ExtensionObject",
      },
      { nodeId: "ns=1;s=InnerArr", value: [{ a: 5, b: "m" }] },
      {
        nodeId: "ns=1;s=DateTimeVar",
        value: "2026-02-02T00:00:00Z",
        datatype: "DateTime",
      },
    ]);
    expect(results.map((r) => r.statusCode)).to.satisfy((codes) =>
      codes.every((c) => c.startsWith("Good")),
    );
    expect((await readValue("ns=1;s=Outer")).name).to.equal("multi");
    expect(await readValue("ns=1;s=InnerArr")).to.have.length(1);
    expect((await readValue("ns=1;s=DateTimeVar")).toISOString()).to.equal(
      "2026-02-02T00:00:00.000Z",
    );
  });

  it("writeMultiple names the item whose value is invalid", async function () {
    let error;
    try {
      await mgr.writeMultiple([
        { nodeId: "ns=1;s=DateTimeVar", value: "soon", datatype: "DateTime" },
      ]);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.an("error");
    expect(error.message).to.include("ns=1;s=DateTimeVar");
    expect(error.message).to.include('Invalid DateTime value "soon"');
  });
});
