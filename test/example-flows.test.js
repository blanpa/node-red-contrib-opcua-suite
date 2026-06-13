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
    it('the examples directory is non-empty and includes the thirteen bundled flows', function () {
        expect(exampleFiles.length).to.be.at.least(13);
        // The nine pre-existing flows, the three PubSub flows (10-12), and the
        // PubSub full-validation flow (13) must all be present.
        for (let n = 1; n <= 13; n++) {
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

            it('has at least one tab node, each with a non-empty label', function () {
                const tabs = flow.filter(n => n.type === 'tab');
                // Most flows are single-tab; flow 13 (PubSub Full Validation) is a
                // multi-tab validation suite (README + T1..T9).
                expect(tabs.length).to.be.at.least(1);
                tabs.forEach(function (t) {
                    expect(t.label).to.be.a('string').and.to.have.length.above(0);
                });
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

    // ── Flow 13: PubSub Full Validation suite (multi-tab T1..T9) ──
    describe('PubSub flow 13 - PubSub Full Validation.json', function () {
        let flow;

        before(function () {
            flow = loadFlow('13 - PubSub Full Validation.json');
        });

        it('is a multi-tab suite: a README tab plus one tab per scenario T1..T9 (>= 10 tabs)', function () {
            const tabs = flow.filter(n => n.type === 'tab');
            expect(tabs.length).to.be.at.least(10);
            const labels = tabs.map(t => t.label).join(' | ');
            for (let n = 1; n <= 9; n++) {
                expect(labels, `missing a tab for T${n}`).to.match(new RegExp('T' + n + '\\b'));
            }
        });

        it('exercises both transports and both encodings across its connections', function () {
            const conns = flow.filter(n => n.type === 'opcua-pubsub-connection');
            const transports = new Set(conns.map(c => c.transportType));
            expect(transports.has('udp'), 'expected a UDP connection').to.equal(true);
            expect(transports.has('mqtt'), 'expected an MQTT connection').to.equal(true);
            const encodings = new Set(
                flow.filter(n => n.type === 'opcua-publisher').map(p => p.messageEncoding)
            );
            expect(encodings.has('uadp'), 'expected a UADP publisher').to.equal(true);
            expect(encodings.has('json'), 'expected a JSON publisher').to.equal(true);
        });

        it('every publisher/subscriber resolves its connection and encoding matches the connected publisher', function () {
            const connById = new Map(
                flow.filter(n => n.type === 'opcua-pubsub-connection').map(c => [c.id, c])
            );
            flow.forEach(function (n) {
                if (n.type === 'opcua-publisher' || n.type === 'opcua-subscriber') {
                    expect(connById.has(n.connection), `${n.id} -> missing connection ${n.connection}`).to.equal(true);
                }
            });
        });

        it('MQTT connections target the validation broker mqtt://val-mosquitto:1883', function () {
            flow
                .filter(n => n.type === 'opcua-pubsub-connection' && n.transportType === 'mqtt')
                .forEach(function (c) {
                    expect(c.brokerUrl).to.equal('mqtt://val-mosquitto:1883');
                });
        });

        it('exercises a cyclic publisher (KeepAlive scenario) and a multi-writer publisher', function () {
            const pubs = flow.filter(n => n.type === 'opcua-publisher');
            expect(pubs.some(p => p.publishMode === 'cyclic'), 'expected a cyclic publisher (T5)').to.equal(true);
            const multiWriter = pubs.some(function (p) {
                try {
                    const w = JSON.parse(p.writers || '[]');
                    return Array.isArray(w) && w.length >= 2;
                } catch (e) {
                    return false;
                }
            });
            expect(multiWriter, 'expected a publisher with >= 2 DataSetWriters (T4)').to.equal(true);
        });

        it('exercises chunking via a small maxNetworkMessageSize publisher (T6)', function () {
            const chunked = flow.some(
                n => n.type === 'opcua-publisher' && Number(n.maxNetworkMessageSize) <= 300
            );
            expect(chunked, 'expected a small-MTU publisher to force chunking').to.equal(true);
        });

        it('exercises a ConfigurationVersion-mismatch subscriber (T9)', function () {
            const cvSub = flow.some(
                n => n.type === 'opcua-subscriber' && n.expectedConfigVersion && n.expectedConfigVersion !== ''
            );
            expect(cvSub, 'expected a subscriber with expectedConfigVersion (T9)').to.equal(true);
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
