'use strict';

// Static validation of every bundled example flow under examples/*.json.
// Runs under `npm test` with no Node-RED runtime and no network: it only
// parses the JSON and asserts structural + referential integrity, plus
// explicit transport/encoding rules for the three PubSub flows (10-12).

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');
const exampleFiles = fs
    .readdirSync(EXAMPLES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

// Properties whose value is a single node id referencing another node in the
// SAME flow file. wires[][] entries are handled separately below.
const ID_REF_PROPS = ['connection', 'endpoint'];

function loadFlow(file) {
    const raw = fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8');
    return JSON.parse(raw);
}

// Explicit transport/encoding expectations for the PubSub example flows.
const PUBSUB_FLOWS = [
    { file: '10 - PubSub UDP-UADP Loopback.json', transport: 'udp', encoding: 'uadp' },
    { file: '11 - PubSub MQTT-UADP.json', transport: 'mqtt', encoding: 'uadp' },
    { file: '12 - PubSub MQTT-JSON.json', transport: 'mqtt', encoding: 'json' }
];

describe('example flows (static validation)', function () {
    it('the examples directory is non-empty and includes the twelve bundled flows', function () {
        expect(exampleFiles.length).to.be.at.least(12);
        // The nine pre-existing flows plus the three new PubSub flows must all be present.
        for (let n = 1; n <= 12; n++) {
            const prefix = String(n).padStart(2, '0') + ' - ';
            const found = exampleFiles.some(f => f.startsWith(prefix));
            expect(found, `expected an example flow starting with "${prefix}"`).to.equal(true);
        }
    });

    // ── Per-file generic structural + referential assertions ──
    exampleFiles.forEach(function (file) {
        describe(file, function () {
            let flow;

            before(function () {
                flow = loadFlow(file);
            });

            it('parses as a JSON array', function () {
                expect(Array.isArray(flow)).to.equal(true);
            });

            it('has exactly one tab node with a non-empty label', function () {
                const tabs = flow.filter(n => n.type === 'tab');
                expect(tabs.length).to.equal(1);
                expect(tabs[0].label).to.be.a('string').and.to.have.length.above(0);
            });

            it('every node has a string type and a unique id', function () {
                const seen = new Set();
                flow.forEach(function (n) {
                    expect(n.type, 'node missing type').to.be.a('string');
                    expect(n.id, 'node missing id').to.be.a('string');
                    expect(seen.has(n.id), `duplicate id ${n.id}`).to.equal(false);
                    seen.add(n.id);
                });
            });

            it('every node reference (connection/endpoint/wires) resolves within the file', function () {
                const ids = new Set(flow.map(n => n.id));
                flow.forEach(function (n) {
                    ID_REF_PROPS.forEach(function (prop) {
                        if (n[prop]) {
                            expect(ids.has(n[prop]), `${n.id}.${prop} -> missing node ${n[prop]}`).to.equal(true);
                        }
                    });
                    if (Array.isArray(n.wires)) {
                        n.wires.forEach(function (port) {
                            (port || []).forEach(function (target) {
                                expect(ids.has(target), `${n.id} wires -> missing node ${target}`).to.equal(true);
                            });
                        });
                    }
                });
            });
        });
    });

    // ── Explicit PubSub coverage for flows 10, 11, 12 ──
    PUBSUB_FLOWS.forEach(function (spec) {
        describe(`PubSub flow ${spec.file}`, function () {
            let flow, conn, pub, sub;

            before(function () {
                flow = loadFlow(spec.file);
                conn = flow.find(n => n.type === 'opcua-pubsub-connection');
                pub = flow.find(n => n.type === 'opcua-publisher');
                sub = flow.find(n => n.type === 'opcua-subscriber');
            });

            it('contains one connection, one publisher, one subscriber, an inject and a debug', function () {
                expect(flow.filter(n => n.type === 'opcua-pubsub-connection').length).to.equal(1);
                expect(flow.filter(n => n.type === 'opcua-publisher').length).to.equal(1);
                expect(flow.filter(n => n.type === 'opcua-subscriber').length).to.equal(1);
                expect(flow.filter(n => n.type === 'inject').length).to.be.at.least(1);
                expect(flow.filter(n => n.type === 'debug').length).to.be.at.least(1);
            });

            it(`connection transportType is "${spec.transport}"`, function () {
                expect(conn.transportType).to.equal(spec.transport);
            });

            it(`publisher and subscriber messageEncoding is "${spec.encoding}" and identical`, function () {
                expect(pub.messageEncoding).to.equal(spec.encoding);
                expect(sub.messageEncoding).to.equal(spec.encoding);
                expect(pub.messageEncoding).to.equal(sub.messageEncoding);
            });

            it('publisher and subscriber connection reference the in-file connection node', function () {
                expect(pub.connection).to.equal(conn.id);
                expect(sub.connection).to.equal(conn.id);
            });

            it('MQTT flows target mqtt://localhost:1883', function () {
                if (spec.transport === 'mqtt') {
                    expect(conn.brokerUrl).to.equal('mqtt://localhost:1883');
                }
            });
        });
    });

    // ── D4-03: no flow combines a UDP connection with JSON encoding ──
    it('no example uses a UDP connection with messageEncoding "json" (D4-03)', function () {
        exampleFiles.forEach(function (file) {
            const flow = loadFlow(file);
            const udpConnIds = new Set(
                flow.filter(n => n.type === 'opcua-pubsub-connection' && n.transportType === 'udp').map(n => n.id)
            );
            flow.forEach(function (n) {
                if (
                    (n.type === 'opcua-publisher' || n.type === 'opcua-subscriber') &&
                    udpConnIds.has(n.connection)
                ) {
                    expect(n.messageEncoding, `${file}:${n.id} uses UDP+json`).to.not.equal('json');
                }
            });
        });
    });
});
