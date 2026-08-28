"use strict";

/**
 * End-to-end regression tests for the server node's setValue command.
 *
 * `handleSetValue` used to resolve the target DataType with
 * `DataType[msg.datatype || node.dataType]`. UAVariable.dataType is a NodeId
 * object, so that lookup was ALWAYS undefined and every datatype-less setValue
 * silently became a Double — which node-opcua then rejected with
 * "the provided variant must have the expected dataType". setValue therefore
 * only ever worked on Double variables, and only the shipped examples (which
 * happen to pass datatype: "Double") hid it.
 *
 * Also covers the msg.func opt-in gate and the SByte/Byte default value.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");
const { OPCUAClient, DataType } = require("node-opcua");

const PORT = 45901;

function createRED() {
  const types = {};
  return {
    nodes: {
      createNode: function (node, config) {
        Object.assign(node, config);
        node._events = {};
        node.on = function (event, cb) {
          (node._events[event] = node._events[event] || []).push(cb);
        };
        node.status = sinon.stub();
        node.log = sinon.stub();
        node.warn = sinon.stub();
        node.error = sinon.stub();
      },
      registerType: function (name, ctor, opts) {
        types[name] = { constructor: ctor, opts };
      },
      getNode: () => null,
      _types: types,
    },
  };
}

describe("opcua-server setValue datatype resolution", function () {
  this.timeout(25000);

  let node;
  let handler;

  async function invoke(msg) {
    let doneErr = null;
    await handler(
      msg,
      () => {},
      (err) => {
        doneErr = err || null;
      },
    );
    return { msg, err: doneErr };
  }

  async function readValue(nodeId) {
    const client = OPCUAClient.create({ endpointMustExist: false });
    await client.connect(node.endpointUrl);
    const session = await client.createSession();
    try {
      return await session.read({ nodeId, attributeId: 13 });
    } finally {
      await session.close();
      await client.disconnect();
    }
  }

  before(async function () {
    const RED = createRED();
    const p = path.resolve(__dirname, "..", "nodes", "opcua-server.js");
    delete require.cache[require.resolve(p)];
    require(p)(RED);
    const Ctor = RED.nodes._types["opcua-server"].constructor;
    node = {};
    // allowMsgFunc deliberately left at its default (false)
    Ctor.call(node, { port: PORT, serverName: "SetValueTest" });

    for (let i = 0; i < 400 && !node.server; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(node.server, "server failed to start").to.exist;
    handler = node._events.input[0];
  });

  after(async function () {
    const closeCb = node && node._events.close && node._events.close[0];
    if (closeCb) {
      await new Promise((resolve) => closeCb(false, resolve));
    }
  });

  // ─── setValue without msg.datatype ───

  const cases = [
    {
      name: "Boolean",
      datatype: "Boolean",
      value: true,
      expect: DataType.Boolean,
    },
    { name: "Int32", datatype: "Int32", value: 4711, expect: DataType.Int32 },
    {
      name: "String",
      datatype: "String",
      value: "hello",
      expect: DataType.String,
    },
    {
      name: "Double",
      datatype: "Double",
      value: 25.5,
      expect: DataType.Double,
    },
  ];

  for (const c of cases) {
    it(`setValue without msg.datatype works on a ${c.name} variable`, async function () {
      const nodeId = `ns=1;s=SV_${c.name}`;
      const add = await invoke({
        command: "addVariable",
        variableName: `SV_${c.name}`,
        datatype: c.datatype,
        nodeId,
      });
      expect(add.err).to.equal(null);

      const set = await invoke({
        command: "setValue",
        nodeId,
        payload: c.value,
      });
      expect(set.err, `setValue errored: ${set.msg.error}`).to.equal(null);
      expect(set.msg.error).to.be.undefined;

      const dv = await readValue(nodeId);
      expect(dv.statusCode.name).to.equal("Good");
      expect(dv.value.dataType).to.equal(c.expect);
      expect(dv.value.value).to.deep.equal(c.value);
    });
  }

  it("an explicit msg.datatype still wins", async function () {
    const nodeId = "ns=1;s=SV_Explicit";
    await invoke({
      command: "addVariable",
      variableName: "SV_Explicit",
      datatype: "Int32",
      nodeId,
    });
    const set = await invoke({
      command: "setValue",
      nodeId,
      datatype: "Int32",
      payload: 7,
    });
    expect(set.err).to.equal(null);
    const dv = await readValue(nodeId);
    expect(dv.value.dataType).to.equal(DataType.Int32);
    expect(dv.value.value).to.equal(7);
  });

  // ─── getDefaultValue: SByte / Byte ───

  it("addVariable defaults a Byte variable to 0, not null", async function () {
    const nodeId = "ns=1;s=SV_Byte";
    const add = await invoke({
      command: "addVariable",
      variableName: "SV_Byte",
      datatype: "Byte",
      nodeId,
    });
    expect(add.err).to.equal(null);
    const dv = await readValue(nodeId);
    expect(dv.value.dataType).to.equal(DataType.Byte);
    expect(dv.value.value).to.equal(0);
  });

  it("addVariable defaults an SByte variable to 0, not null", async function () {
    const nodeId = "ns=1;s=SV_SByte";
    const add = await invoke({
      command: "addVariable",
      variableName: "SV_SByte",
      datatype: "SByte",
      nodeId,
    });
    expect(add.err).to.equal(null);
    const dv = await readValue(nodeId);
    expect(dv.value.dataType).to.equal(DataType.SByte);
    expect(dv.value.value).to.equal(0);
  });

  // ─── msg.func gate ───

  it("rejects msg.func when allowMsgFunc is not enabled", async function () {
    const obj = await invoke({
      command: "addObject",
      objectName: "GateTestObj",
    });
    expect(obj.err).to.equal(null);

    const res = await invoke({
      command: "addMethod",
      methodName: "Gated",
      parentNodeId: obj.msg.nodeId,
      outputArguments: [{ name: "out", dataType: "String" }],
      func: "return { statusCode: StatusCodes.Good, outputArguments: [] };",
    });
    expect(res.err).to.be.an("error");
    expect(res.msg.error).to.include("msg.func is disabled");
  });

  it("addMethod without msg.func still works with allowMsgFunc off", async function () {
    const obj = await invoke({
      command: "addObject",
      objectName: "GateTestObj2",
    });
    const res = await invoke({
      command: "addMethod",
      methodName: "Ungated",
      parentNodeId: obj.msg.nodeId,
      outputArguments: [{ name: "out", dataType: "String" }],
    });
    expect(res.err).to.equal(null);
    expect(res.msg.nodeId).to.match(/^ns=1;/);
  });
});
