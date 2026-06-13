"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const path = require("path");
const fs = require("fs");
const EventEmitter = require("events");

const uadp = require("../lib/uadp-encoder");
const json = require("../lib/json-encoder");

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

// ─── Fake transport + stub connection ───

function createFakeTransport() {
    const t = new EventEmitter();
    t.send = sinon.stub();
    return t;
}

function createStubConnection(transportType, transport) {
    return {
        transportType: transportType,
        publisherId: "pub-1",
        publisherIdType: "String",
        acquireTransport: sinon.stub().returns(transport),
        releaseTransport: sinon.stub(),
        registerStatusCallback: sinon.stub(),
        unregisterStatusCallback: sinon.stub()
    };
}

const SUB_PATH = path.resolve(__dirname, "..", "nodes", "opcua-subscriber.js");

function loadSubscriber(RED) {
    delete require.cache[require.resolve(SUB_PATH)];
    require(SUB_PATH)(RED);
    return RED.nodes._types["opcua-subscriber"].constructor;
}

// Construct a subscriber node with the createRED mock + a send stub.
function buildNode(ctor, config) {
    const node = {};
    ctor.call(node, config);
    return node;
}

// Build a NetworkMessage model used across tests.
function sampleNM(extra) {
    return Object.assign({
        publisherId: "pub-1",
        groupHeader: { writerGroupId: 1, sequenceNumber: 7 },
        payloadHeader: { dataSetWriterIds: [10] },
        payload: [
            {
                dataSetWriterId: 10,
                messageType: "keyframe",
                sequenceNumber: 7,
                status: 0,
                configurationVersion: { major: 1, minor: 0 },
                fields: { Temp: { dataType: "Double", value: 21.5 } }
            }
        ]
    }, extra || {});
}

function uadpBuffer(nm) {
    const encoded = uadp.encodeNetworkMessage(nm);
    return Buffer.isBuffer(encoded) ? encoded : encoded[0];
}

function jsonBuffer(nm) {
    return Buffer.from(json.encodeNetworkMessage(nm));
}

// ─── Task 1: runtime node behaviour ───

describe("opcua-subscriber node (Task 1)", function () {

    it("registers type 'opcua-subscriber'", function () {
        const RED = createRED({});
        loadSubscriber(RED);
        expect(RED.nodes._types).to.have.property("opcua-subscriber");
    });

    it("missing connection → red ring 'no connection' and no listener registered", function () {
        const RED = createRED({}); // getNode returns null
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "missing", writerGroupId: 1 });
        expect(node.status.calledWithMatch({ fill: "red", shape: "ring", text: "no connection" })).to.be.true;
    });

    it("DataSetReader with no filter fields → node.error + red status 'invalid reader', returns early", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("udp", transport);
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1" }); // no filter fields
        expect(node.error.called).to.be.true;
        expect(node.error.firstCall.args[0]).to.match(/DataSetReader/);
        expect(conn.acquireTransport.called).to.be.false;
        expect(node.status.calledWithMatch({ fill: "red", shape: "ring", text: "invalid reader" })).to.be.true;
    });

    it("builds DataSetReader from writerGroupId filter and registers a message listener on the transport", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("udp", transport);
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1", writerGroupId: 1 });
        expect(transport.listenerCount("message")).to.equal(1);
        expect(conn.acquireTransport.calledOnce).to.be.true;
    });

    it("UDP + json encoding → rejected at startup with node.error + red status, no listener registered", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("udp", transport);
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1", messageEncoding: "json", writerGroupId: 1 });
        expect(node.error.called).to.be.true;
        expect(node.status.calledWithMatch({ fill: "red", shape: "ring" })).to.be.true;
        expect(transport.listenerCount("message")).to.equal(0);
    });

    it("UADP message → emits one msg with the exact D4-09 shape (UDP, no topic)", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("udp", transport);
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1", writerGroupId: 1 });

        transport.emit("message", uadpBuffer(sampleNM()), {});

        expect(node.send.calledOnce).to.be.true;
        const sent = node.send.firstCall.args[0];
        expect(sent.payload).to.deep.equal({ Temp: 21.5 });
        expect(sent.publisherId).to.equal("pub-1");
        expect(sent.writerGroupId).to.equal(1);
        expect(sent.dataSetWriterId).to.equal(10);
        expect(sent.sequenceNumber).to.equal(7);
        expect(sent.statusCode).to.equal(0);
        expect(sent.encoding).to.equal("uadp");
        expect(sent.transport).to.equal("udp");
        expect(sent.timestamp).to.be.an.instanceof(Date);
        expect(sent).to.not.have.property("topic");
    });

    it("MQTT-JSON message → Buffer.toString() decoded, emits msg with topic from metadata", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("mqtt", transport);
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1", messageEncoding: "json", dataSetWriterId: 10 });

        transport.emit("message", jsonBuffer(sampleNM()), { topic: "ua/json/pub-1" });

        expect(node.send.calledOnce).to.be.true;
        const sent = node.send.firstCall.args[0];
        expect(sent.encoding).to.equal("json");
        expect(sent.transport).to.equal("mqtt");
        expect(sent.topic).to.equal("ua/json/pub-1");
        expect(sent.payload.Temp).to.equal(21.5);
        expect(sent.dataSetWriterId).to.equal(10);
    });

    it("filter non-match → message silently skipped, NO node.error, NO send", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("udp", transport);
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1", writerGroupId: 99 });

        transport.emit("message", uadpBuffer(sampleNM()), {}); // writerGroupId 1 ≠ 99

        expect(node.send.called).to.be.false;
        expect(node.error.called).to.be.false;
    });

    it("ConfigurationVersion mismatch on a matched message → VISIBLE node.error, msg NOT sent", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("udp", transport);
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1", writerGroupId: 1, expectedConfigVersion: "2.0" });

        transport.emit("message", uadpBuffer(sampleNM()), {}); // cv {1,0} matches filter

        expect(node.send.called).to.be.false;
        expect(node.error.called).to.be.true;
        expect(node.error.firstCall.args[0]).to.match(/ConfigurationVersion mismatch: expected 2\.0, got 1\.0/);
    });

    it("decode error in handler → node.error, listener does NOT throw, transport stays alive", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("udp", transport);
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1", writerGroupId: 1 });

        const fire = function () {
            transport.emit("message", Buffer.from([0x00, 0x01, 0x02]), {});
        };
        expect(fire).to.not.throw();
        expect(node.error.called).to.be.true;

        // A subsequent valid message still emits — the listener survived.
        transport.emit("message", uadpBuffer(sampleNM()), {});
        expect(node.send.calledOnce).to.be.true;
    });

    it("close: removeListener('message') runs BEFORE releaseTransport, and unregisterStatusCallback is called", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("udp", transport);
        let listenersAtRelease = -1;
        conn.releaseTransport = sinon.stub().callsFake(function () {
            listenersAtRelease = transport.listenerCount("message");
        });
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1", writerGroupId: 1 });

        const registeredCb = conn.registerStatusCallback.firstCall.args[0];
        const done = sinon.stub();
        node._events["close"][0](false, done);

        expect(transport.listenerCount("message")).to.equal(0);
        expect(listenersAtRelease).to.equal(0); // removeListener ran BEFORE release
        expect(conn.unregisterStatusCallback.calledWith(registeredCb)).to.be.true;
        expect(conn.releaseTransport.called).to.be.true;
        expect(done.calledOnce).to.be.true;
    });

    it("status callback maps connected→green ring 'subscribed' after listener registered, disconnected→yellow, error→red", function () {
        const transport = createFakeTransport();
        const conn = createStubConnection("udp", transport);
        const RED = createRED({ conn1: conn });
        const ctor = loadSubscriber(RED);
        const node = {};
        node.send = sinon.stub();
        ctor.call(node, { id: "s1", connection: "conn1", writerGroupId: 1 });

        const cb = conn.registerStatusCallback.firstCall.args[0];
        cb("connected");
        expect(node.status.calledWithMatch({ fill: "green", shape: "ring", text: "subscribed" })).to.be.true;
        cb("disconnected");
        expect(node.status.calledWithMatch({ fill: "yellow", shape: "ring", text: "disconnected" })).to.be.true;
        cb("error");
        expect(node.status.calledWithMatch({ fill: "red", shape: "ring", text: "error" })).to.be.true;
    });

    it("20 sequential construct→close cycles leave the fake transport with 0 message listeners (no leak across redeploy, D4-07)", function () {
        for (let i = 0; i < 20; i++) {
            const transport = createFakeTransport();
            const conn = createStubConnection("udp", transport);
            const RED = createRED({ conn1: conn });
            const ctor = loadSubscriber(RED);
            const node = {};
            node.send = sinon.stub();
            ctor.call(node, { id: "s" + i, connection: "conn1", writerGroupId: 1 });
            expect(transport.listenerCount("message")).to.equal(1);
            const done = sinon.stub();
            node._events["close"][0](false, done);
            expect(transport.listenerCount("message")).to.equal(0);
            expect(conn.unregisterStatusCallback.called).to.be.true;
        }
    });
});

// ─── Task 2: editor HTML + package.json registration ───

describe("opcua-subscriber editor + registration (Task 2)", function () {

    const htmlPath = path.resolve(__dirname, "..", "nodes", "opcua-subscriber.html");
    function html() {
        return fs.readFileSync(htmlPath, "utf8");
    }

    it("HTML registers type 'opcua-subscriber' with category 'function'", function () {
        const h = html();
        expect(h).to.contain('registerType("opcua-subscriber"');
        expect(h).to.contain('category: "function"');
    });

    it("HTML defaults declare connection (type opcua-pubsub-connection), messageEncoding, publisherId, writerGroupId, dataSetWriterId", function () {
        const h = html();
        expect(h).to.contain('type: "opcua-pubsub-connection"');
        expect(h).to.contain("messageEncoding");
        expect(h).to.contain("publisherId");
        expect(h).to.contain("writerGroupId");
        expect(h).to.contain("dataSetWriterId");
    });

    it("HTML has inputs: 0 and outputs: 1 (receive-only worker node)", function () {
        const h = html();
        expect(h).to.contain("inputs: 0");
        expect(h).to.contain("outputs: 1");
    });

    it("HTML template exposes the three DataSetReader filter inputs", function () {
        const h = html();
        expect(h).to.contain("node-input-publisherId");
        expect(h).to.contain("node-input-writerGroupId");
        expect(h).to.contain("node-input-dataSetWriterId");
    });

    it("package.json registers opcua-subscriber → nodes/opcua-subscriber.js in node-red.nodes", function () {
        const pkg = require("../package.json");
        expect(pkg["node-red"].nodes["opcua-subscriber"]).to.equal("nodes/opcua-subscriber.js");
    });

    it("package.json keeps opcua-subscriber positioned after opcua-pubsub-connection", function () {
        const pkg = require("../package.json");
        const keys = Object.keys(pkg["node-red"].nodes);
        expect(keys.indexOf("opcua-subscriber")).to.be.greaterThan(keys.indexOf("opcua-pubsub-connection"));
    });
});
