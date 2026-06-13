"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");
const fs = require("fs");

// ─── Shared RED mock (verbatim from test/opcua-nodes.test.js pattern) ───

function createRED(nodeOverrides) {
    const types = {};
    const registeredNodes = {};
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
            getNode: function (id) {
                return registeredNodes[id] || (nodeOverrides && nodeOverrides[id]) || null;
            },
            _types: types,
            _registered: registeredNodes
        }
    };
}

// Helper: fake opcua-pubsub-connection config node.
function makeConn(overrides) {
    overrides = overrides || {};
    const fakeTransport = overrides.transport || { send: sinon.stub() };
    return Object.assign({
        transportType: "udp",
        publisherId: "pub-1",
        publisherIdType: "String",
        registerStatusCallback: sinon.stub(),
        unregisterStatusCallback: sinon.stub(),
        acquireTransport: sinon.stub().returns(fakeTransport),
        releaseTransport: sinon.stub(),
        _fakeTransport: fakeTransport
    }, overrides);
}

const PUBLISHER_PATH = path.resolve(__dirname, "..", "nodes", "opcua-publisher.js");

function loadPublisher(RED) {
    delete require.cache[require.resolve(PUBLISHER_PATH)];
    require(PUBLISHER_PATH)(RED);
    return RED.nodes._types["opcua-publisher"].constructor;
}

// A valid one-writer config (single PublishedDataSet field temp:Double).
function validConfig(extra) {
    return Object.assign({
        id: "p1",
        connection: "conn1",
        publishMode: "acyclic",
        publishingInterval: 1000,
        writerGroupId: 10,
        priority: 128,
        maxNetworkMessageSize: 1400,
        writers: JSON.stringify([
            {
                dataSetWriterId: 1,
                dataSetName: "DataSet1",
                publishedDataSet: {
                    name: "DataSet1",
                    fields: [{ name: "temp", dataType: "Double" }]
                }
            }
        ])
    }, extra || {});
}

// ─── Task 1: config build, encoding selection, acyclic publish, status ───

describe("opcua-publisher node (Task 1)", function () {

    it("registers type 'opcua-publisher'", function () {
        const RED = createRED({ conn1: makeConn() });
        loadPublisher(RED);
        expect(RED.nodes._types).to.have.property("opcua-publisher");
    });

    it("no connection → red ring 'no connection' and no acquireTransport", function () {
        const conn = makeConn();
        const RED = createRED({});  // getNode(conn1) → null
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig());
        const statusArgs = node.status.getCalls().map(c => c.args[0]);
        expect(statusArgs.some(s => s && s.text === "no connection" && s.fill === "red")).to.be.true;
        expect(conn.acquireTransport.called).to.be.false;
    });

    it("builds WriterGroup/DataSetWriter/PublishedDataSet from config; node.writers length 1", function () {
        const RED = createRED({ conn1: makeConn() });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig());
        expect(node.writers).to.be.an("array").with.lengthOf(1);
        expect(node.writers[0].dataSetWriterId).to.equal(1);
        expect(node.writerGroup.writerGroupId).to.equal(10);
    });

    it("invalid WriterGroup (writerGroupId=0) → node.error + red 'config error', no transport acquired", function () {
        const conn = makeConn();
        const RED = createRED({ conn1: conn });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig({ writerGroupId: 0 }));
        expect(node.error.called).to.be.true;
        const statusArgs = node.status.getCalls().map(c => c.args[0]);
        expect(statusArgs.some(s => s && s.text === "config error" && s.fill === "red")).to.be.true;
        expect(conn.acquireTransport.called).to.be.false;
    });

    it("UDP + messageEncoding='json' → node.error + red status + early return (no acquireTransport)", function () {
        const conn = makeConn({ transportType: "udp" });
        const RED = createRED({ conn1: conn });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig({ messageEncoding: "json" }));
        expect(node.error.called).to.be.true;
        const msg = node.error.firstCall.args[0];
        expect(/UDP|UADP/i.test(msg)).to.be.true;
        expect(conn.acquireTransport.called).to.be.false;
    });

    it("udp default encoding is uadp; registers status callback and acquires transport; idle blue dot", function () {
        const conn = makeConn({ transportType: "udp" });
        const RED = createRED({ conn1: conn });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig());
        expect(node.messageEncoding).to.equal("uadp");
        expect(conn.registerStatusCallback.called).to.be.true;
        expect(conn.acquireTransport.called).to.be.true;
        const statusArgs = node.status.getCalls().map(c => c.args[0]);
        expect(statusArgs.some(s => s && s.fill === "blue" && s.shape === "dot" && s.text === "idle")).to.be.true;
    });

    it("acyclic input: one msg → transport.send called once", function () {
        const conn = makeConn();
        const RED = createRED({ conn1: conn });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig());
        const send = sinon.stub();
        const done = sinon.stub();
        node._events["input"][0]({ payload: { temp: 21.5 } }, send, done);
        expect(conn._fakeTransport.send.calledOnce).to.be.true;
        expect(send.calledOnce).to.be.true;
        expect(done.calledOnce).to.be.true;
    });

    it("acyclic NetworkMessage shape: publisherId, groupHeader, payloadHeader, keyframe DataSetMessage w/ Variant", function () {
        const RED = createRED({ conn1: makeConn() });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig());
        const nm = node._buildNetworkMessage({ temp: 21.5 });
        expect(nm.publisherId).to.equal("pub-1");
        expect(nm.groupHeader.writerGroupId).to.equal(10);
        expect(nm.payloadHeader.dataSetWriterIds[0]).to.equal(1);
        expect(nm.payload[0].messageType).to.equal("keyframe");
        expect(nm.payload[0].fields.temp.dataType).to.equal("Double");
        expect(nm.payload[0].fields.temp.value).to.equal(21.5);
    });

    it("missing field is OMITTED, not fabricated (D4-05)", function () {
        const RED = createRED({ conn1: makeConn() });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig({
            writers: JSON.stringify([
                {
                    dataSetWriterId: 1,
                    dataSetName: "DataSet1",
                    publishedDataSet: {
                        name: "DataSet1",
                        fields: [
                            { name: "temp", dataType: "Double" },
                            { name: "humidity", dataType: "Double" }
                        ]
                    }
                }
            ])
        }));
        const nm = node._buildNetworkMessage({ temp: 21.5 });
        expect(nm.payload[0].fields.humidity).to.be.undefined;
        expect(Object.keys(nm.payload[0].fields)).to.deep.equal(["temp"]);
    });

    it("sequenceNumber increments across emitted NetworkMessages", function () {
        const RED = createRED({ conn1: makeConn() });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig());
        const nm1 = node._buildNetworkMessage({ temp: 1 });
        const nm2 = node._buildNetworkMessage({ temp: 2 });
        expect(nm2.groupHeader.sequenceNumber).to.equal(nm1.groupHeader.sequenceNumber + 1);
    });

    it("status mapping: 'connected'→green dot, 'error'→red ring", function () {
        const conn = makeConn();
        const RED = createRED({ conn1: conn });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig());
        const cb = conn.registerStatusCallback.firstCall.args[0];
        cb("connected");
        cb("error", new Error("boom"));
        const statusArgs = node.status.getCalls().map(c => c.args[0]);
        expect(statusArgs.some(s => s && s.fill === "green" && s.shape === "dot")).to.be.true;
        expect(statusArgs.some(s => s && s.fill === "red" && s.shape === "ring")).to.be.true;
    });

    it("close: unregisters status callback and releases transport", function () {
        const conn = makeConn();
        const RED = createRED({ conn1: conn });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig());
        const doneCb = sinon.stub();
        node._events["close"][0](false, doneCb);
        expect(conn.unregisterStatusCallback.called).to.be.true;
        expect(conn.releaseTransport.called).to.be.true;
        expect(doneCb.calledOnce).to.be.true;
    });
});

// ─── Task 2: cyclic mode + KeepAlive + interval cleanup + HTML ───

describe("opcua-publisher node (Task 2 - cyclic)", function () {

    it("cyclic mode: input msg merges values but does NOT emit immediately", function () {
        const conn = makeConn();
        const RED = createRED({ conn1: conn });
        const ctor = loadPublisher(RED);
        const node = {};
        ctor.call(node, validConfig({ publishMode: "cyclic", publishingInterval: 100, writers: validConfig().writers.replace("temp", "value") }));
        const send = sinon.stub();
        const done = sinon.stub();
        node._events["input"][0]({ payload: { value: 1 } }, send, done);
        expect(conn._fakeTransport.send.called).to.be.false;
        expect(node._dirty).to.be.true;
        expect(node._latestValues.value).to.equal(1);
        // cleanup the interval
        node._events["close"][0](false, sinon.stub());
    });

    it("cyclic tick after a value change emits a keyframe", function () {
        const clock = sinon.useFakeTimers();
        try {
            const conn = makeConn();
            const RED = createRED({ conn1: conn });
            const ctor = loadPublisher(RED);
            const node = {};
            ctor.call(node, validConfig({ publishMode: "cyclic", publishingInterval: 100 }));
            const emitted = [];
            const origEmit = node._emit;
            node._emit = function (nm) { emitted.push(nm); return origEmit.call(node, nm); };
            node._events["input"][0]({ payload: { temp: 1 } }, sinon.stub(), sinon.stub());
            clock.tick(100);
            expect(conn._fakeTransport.send.calledOnce).to.be.true;
            expect(emitted[0].payload[0].messageType).to.equal("keyframe");
            node._events["close"][0](false, sinon.stub());
        } finally {
            clock.restore();
        }
    });

    it("cyclic tick with NO change emits a KeepAlive (messageType 'keepalive', empty fields)", function () {
        const clock = sinon.useFakeTimers();
        try {
            const conn = makeConn();
            const RED = createRED({ conn1: conn });
            const ctor = loadPublisher(RED);
            const node = {};
            ctor.call(node, validConfig({ publishMode: "cyclic", publishingInterval: 100 }));
            const emitted = [];
            const origEmit = node._emit;
            node._emit = function (nm) { emitted.push(nm); return origEmit.call(node, nm); };
            node._events["input"][0]({ payload: { temp: 1 } }, sinon.stub(), sinon.stub());
            clock.tick(100); // keyframe
            clock.tick(100); // no change → keepalive
            expect(emitted[1].payload[0].messageType).to.equal("keepalive");
            expect(Object.keys(emitted[1].payload[0].fields).length).to.equal(0);
            node._events["close"][0](false, sinon.stub());
        } finally {
            clock.restore();
        }
    });

    it("sequenceNumber increments on keepalive too", function () {
        const clock = sinon.useFakeTimers();
        try {
            const conn = makeConn();
            const RED = createRED({ conn1: conn });
            const ctor = loadPublisher(RED);
            const node = {};
            ctor.call(node, validConfig({ publishMode: "cyclic", publishingInterval: 100 }));
            const emitted = [];
            const origEmit = node._emit;
            node._emit = function (nm) { emitted.push(nm); return origEmit.call(node, nm); };
            node._events["input"][0]({ payload: { temp: 1 } }, sinon.stub(), sinon.stub());
            clock.tick(100); // keyframe
            clock.tick(100); // keepalive
            expect(emitted[1].groupHeader.sequenceNumber).to.equal(emitted[0].groupHeader.sequenceNumber + 1);
            node._events["close"][0](false, sinon.stub());
        } finally {
            clock.restore();
        }
    });

    it("close clears the cyclic interval (no further sends after close)", function () {
        const clock = sinon.useFakeTimers();
        try {
            const conn = makeConn();
            const RED = createRED({ conn1: conn });
            const ctor = loadPublisher(RED);
            const node = {};
            ctor.call(node, validConfig({ publishMode: "cyclic", publishingInterval: 100 }));
            node._events["input"][0]({ payload: { temp: 1 } }, sinon.stub(), sinon.stub());
            clock.tick(100);
            const countAfterTick = conn._fakeTransport.send.callCount;
            const doneCb = sinon.stub();
            node._events["close"][0](false, doneCb);
            clock.tick(500);
            expect(conn._fakeTransport.send.callCount).to.equal(countAfterTick);
            expect(doneCb.calledOnce).to.be.true;
        } finally {
            clock.restore();
        }
    });
});

// ─── Task 2: editor HTML ───

describe("opcua-publisher.html (Task 2 - editor)", function () {
    const HTML_PATH = path.resolve(__dirname, "..", "nodes", "opcua-publisher.html");
    let html;

    before(function () {
        html = fs.readFileSync(HTML_PATH, "utf8");
    });

    it("registers type 'opcua-publisher' with category 'function'", function () {
        expect(html).to.match(/RED\.nodes\.registerType\(\s*["']opcua-publisher["']/);
        expect(html).to.match(/category:\s*["']function["']/);
    });

    it("defaults include connection, messageEncoding, publishMode, publishingInterval, writerGroupId, writers", function () {
        ["connection", "messageEncoding", "publishMode", "publishingInterval", "writerGroupId", "writers"].forEach(function (k) {
            expect(html).to.contain(k);
        });
    });

    it("connection picker references the opcua-pubsub-connection config node type", function () {
        expect(html).to.match(/type:\s*["']opcua-pubsub-connection["']/);
    });
});
