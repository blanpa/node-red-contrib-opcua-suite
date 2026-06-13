'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const sinon = require('sinon');

const { BaseTransport } = require('../lib/transports/base-transport');
const { UdpTransport } = require('../lib/transports/udp-transport');

const NODE_PATH = path.resolve(__dirname, '..', 'nodes', 'opcua-pubsub-connection.js');
const HTML_PATH = path.resolve(__dirname, '..', 'nodes', 'opcua-pubsub-connection.html');

// NOTE: we deliberately do NOT require('../lib/transports/mqtt-transport') nor
// require('mqtt') at module top level. The transports/mqtt-transport.test.js
// suite poisons require.cache[mqtt] in a ROOT before() hook (which runs before
// ALL tests in the whole run) and then re-requires mqtt-transport against the
// stub. If THIS file had already cached mqtt-transport (bound to the real mqtt),
// that poison would silently no-op and break the transports suite whenever both
// files run together. The connection node under test requires mqtt-transport
// lazily inside acquireTransport(), so for the MQTT dispatch test (#8) we assert
// on the constructor NAME rather than an instanceof against a class identity we
// would otherwise have to import here.

// ─── RED mock (mirrors connection-sharing.test.js + httpAdmin for cert routes) ───
function createRED() {
    const types = {};
    return {
        httpAdmin: {
            post: sinon.spy(),
            get: sinon.spy(),
            delete: sinon.spy()
        },
        settings: { userDir: '/tmp' },
        nodes: {
            createNode: function(node, config) { Object.assign(node, config); node._events = {}; },
            registerType: function(name, ctor, opts) { types[name] = { constructor: ctor, opts }; },
            getNode: function() { return null; },
            _types: types
        }
    };
}

describe('opcua-pubsub-connection config node', function() {

    let RED, ctor;

    function loadModule() {
        delete require.cache[require.resolve(NODE_PATH)];
        const mod = require(NODE_PATH);
        mod(RED);
        ctor = RED.nodes._types['opcua-pubsub-connection'].constructor;
    }

    function createNode(overrides) {
        const config = Object.assign({
            id: 'pubsub1',
            type: 'opcua-pubsub-connection',
            transportType: 'udp',
            multicastGroup: '239.0.0.1',
            multicastInterface: '0.0.0.0',
            port: 4840,
            mtu: 1400,
            brokerUrl: 'mqtt://localhost:1883',
            topicPrefix: 'ua',
            qos: 1,
            publisherIdType: 'String',
            publisherId: ''
        }, overrides);
        const node = {};
        Object.assign(node, config);
        node._events = {};
        node.on = function(event, cb) { (node._events[event] = node._events[event] || []).push(cb); };
        node.log = sinon.stub();
        node.warn = sinon.stub();
        node.error = sinon.stub();
        node.credentials = (overrides && overrides.credentials) || {};
        ctor.call(node, config);
        return node;
    }

    beforeEach(function() {
        RED = createRED();
        loadModule();
    });

    afterEach(function() {
        sinon.restore();
    });


    // ─── Module load ───

    it('1. module load registers type opcua-pubsub-connection with credentials block', function() {
        const reg = RED.nodes._types['opcua-pubsub-connection'];
        expect(reg).to.exist;
        expect(reg.opts).to.have.property('credentials');
        expect(reg.opts.credentials.userName.type).to.equal('text');
        expect(reg.opts.credentials.password.type).to.equal('password');
    });

    it('2. module load registers cert routes via registerCertRoutes', function() {
        expect(RED.httpAdmin.post.called).to.be.true;
        const postUrls = RED.httpAdmin.post.getCalls().map(c => c.args[0]);
        expect(postUrls).to.include('/opcua-pubsub-connection/upload-cert');
    });

    // ─── Constructor ───

    it('3. constructor with empty publisherId + type=String defaults to a UUID-shaped value', function() {
        const node = createNode({ publisherId: '', publisherIdType: 'String' });
        expect(node.publisherId).to.be.a('string');
        expect(node.publisherId).to.have.length(36);
        expect((node.publisherId.match(/-/g) || []).length).to.equal(4);
    });

    it('4. constructor stores publisherId and publisherIdType on node instance', function() {
        const node = createNode({ publisherId: 'pub-A', publisherIdType: 'UInt16' });
        expect(node.publisherId).to.equal('pub-A');
        expect(node.publisherIdType).to.equal('UInt16');
        expect(node.transportType).to.equal('udp');
    });

    // ─── acquireTransport ───

    it('5. acquireTransport: refCount 0 -> 1, returns BaseTransport instance', function() {
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const t = node.acquireTransport();
        expect(node._refCount).to.equal(1);
        expect(t).to.be.instanceof(BaseTransport);
    });

    it('6. acquireTransport: second acquire reuses the SAME _sharedTransport instance', function() {
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const t1 = node.acquireTransport();
        const t2 = node.acquireTransport();
        expect(t1).to.equal(t2);
        expect(node._refCount).to.equal(2);
    });

    it('7. acquireTransport: dispatches to UdpTransport when transportType=udp', function() {
        const node = createNode({ transportType: 'udp' });
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const t = node.acquireTransport();
        expect(t).to.be.instanceof(UdpTransport);
    });

    it('8. acquireTransport: dispatches to MqttTransport when transportType=mqtt', function() {
        // We assert on the constructor name (not an instanceof against an imported
        // class) so this file never needs to require mqtt-transport at top level —
        // that keeps require.cache clean for the transports suite (see header note).
        // The MqttTransport instance is created but connect() is fired async and
        // would no-op against the (stubbed-in-other-suite or real-but-unconnected)
        // mqtt client; we never reach the network here.
        // Stub connect on the SAME MqttTransport class the node uses (resolved
        // from require.cache) so no real mqtt client/socket is opened.
        const MqttTransport = require('../lib/transports/mqtt-transport').MqttTransport;
        sinon.stub(MqttTransport.prototype, 'connect').resolves();
        const node = createNode({ transportType: 'mqtt' });
        const t = node.acquireTransport();
        expect(t).to.be.instanceof(BaseTransport);
        expect(t.constructor.name).to.equal('MqttTransport');
    });

    it('9. acquireTransport: unknown transportType throws OPCUA_PUBSUB_UNKNOWN_TRANSPORT', function() {
        const node = createNode({ transportType: 'carrier-pigeon' });
        expect(() => node.acquireTransport()).to.throw(/OPCUA_PUBSUB_UNKNOWN_TRANSPORT/);
    });

    // ─── releaseTransport + grace timer ───

    it('10. releaseTransport: refCount drops; when 0 starts a setTimeout for RECONNECT_GRACE_MS=500', function() {
        const clock = sinon.useFakeTimers();
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        sinon.stub(UdpTransport.prototype, 'close').resolves();
        node.acquireTransport();
        expect(node._refCount).to.equal(1);
        node.releaseTransport();
        expect(node._refCount).to.equal(0);
        expect(clock.countTimers()).to.equal(1);
        expect(node._sharedTransport).to.not.be.null;
        clock.tick(499);
        expect(node._sharedTransport).to.not.be.null;
        clock.tick(2);
        expect(node._sharedTransport).to.be.null;
        clock.restore();
    });

    it('11. re-acquire within grace window cancels timer and reuses transport (D-06)', function() {
        const clock = sinon.useFakeTimers();
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        sinon.stub(UdpTransport.prototype, 'close').resolves();
        const t1 = node.acquireTransport();
        node.releaseTransport();
        expect(node._sharedTransport).to.not.be.null;
        const t2 = node.acquireTransport();
        expect(t2).to.equal(t1);
        expect(node._graceTimer).to.be.null;
        clock.tick(501);
        expect(node._sharedTransport).to.equal(t1);
        expect(node._sharedTransport).to.not.be.null;
        clock.restore();
    });

    it('11b. ME-05: grace-timer fire then re-acquire yields a FRESH usable transport (not the closing one)', function() {
        const clock = sinon.useFakeTimers();
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const closeStub = sinon.stub(UdpTransport.prototype, 'close').resolves();

        const t1 = node.acquireTransport();
        node.releaseTransport();          // refCount -> 0, grace timer armed
        clock.tick(501);                  // grace timer FIRES -> closes t1, nulls _sharedTransport

        expect(closeStub.calledOnce).to.be.true;
        expect(node._sharedTransport).to.be.null;

        // Re-acquire in the redeploy window AFTER the close fired: must build a
        // FRESH instance, never hand back the closed t1.
        const t2 = node.acquireTransport();
        expect(node._refCount).to.equal(1);
        expect(node._sharedTransport).to.equal(t2);
        expect(t2).to.not.equal(t1);      // fresh instance, not the closed one
        expect(t2).to.be.instanceof(UdpTransport);
        clock.restore();
    });

    it('11c. ME-05: a re-acquire BEFORE the grace callback runs is not closed out from under it', function() {
        // Simulate the race where the timer is scheduled, a re-acquire bumps
        // refCount back to 1, and the (already-pending) callback then runs. The
        // re-check on refCount must prevent the close so the live consumer keeps
        // a usable transport (no *_SEND_NOT_CONNECTED).
        const clock = sinon.useFakeTimers();
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const closeStub = sinon.stub(UdpTransport.prototype, 'close').resolves();

        const t1 = node.acquireTransport();
        node.releaseTransport();          // refCount -> 0, grace timer armed

        // Force the refCount back up WITHOUT cancelling the timer, to model a
        // re-acquire whose clearTimeout lost the race with the timer firing.
        node._refCount = 1;
        clock.tick(501);                  // pending grace callback runs

        expect(closeStub.called).to.be.false;        // guarded by refCount re-check
        expect(node._sharedTransport).to.equal(t1);  // live transport retained
        clock.restore();
    });

    // ─── status fan-out ───

    it('12. status fan-out: connected event reaches all registered callbacks', function() {
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const t = node.acquireTransport();
        const cbs = [sinon.stub(), sinon.stub(), sinon.stub()];
        cbs.forEach(cb => node.registerStatusCallback(cb));
        t.emit('connected');
        cbs.forEach(cb => expect(cb.calledWith('connected')).to.be.true);
    });

    it('13. status fan-out: error event passes the error object as second arg', function() {
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const t = node.acquireTransport();
        const cb = sinon.stub();
        node.registerStatusCallback(cb);
        const err = new Error('boom');
        t.emit('error', err);
        expect(cb.calledWith('error', err)).to.be.true;
    });

    it('14. status fan-out: a throwing callback does NOT prevent the others (safeCb)', function() {
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const t = node.acquireTransport();
        const bad = sinon.stub().throws(new Error('bad subscriber'));
        const good = sinon.stub();
        node.registerStatusCallback(bad);
        node.registerStatusCallback(good);
        expect(() => t.emit('connected')).to.not.throw();
        expect(good.calledWith('connected')).to.be.true;
    });

    it('15. registerStatusCallback / unregisterStatusCallback add/remove from the Set', function() {
        const node = createNode();
        const cb = sinon.stub();
        node.registerStatusCallback(cb);
        expect(node._statusCallbacks.has(cb)).to.be.true;
        node.unregisterStatusCallback(cb);
        expect(node._statusCallbacks.has(cb)).to.be.false;
    });

    // ─── close handler ───

    it('16. node.on(close, removed, done): grace timer canceled, close() awaited, done() called', async function() {
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const closeStub = sinon.stub(UdpTransport.prototype, 'close').resolves();
        node.acquireTransport();
        node.releaseTransport(); // start grace timer
        const closeFn = node._events['close'][0];
        expect(closeFn).to.be.a('function');
        const done = sinon.stub();
        await closeFn(false, done);
        expect(closeStub.called).to.be.true;
        expect(done.calledOnce).to.be.true;
        expect(node._sharedTransport).to.be.null;
        expect(node._graceTimer).to.be.null;
        expect(node._refCount).to.equal(0);
    });

    // ─── credential redaction ───

    it('17. credential redaction: node.error never receives password value (T-03-03)', function() {
        const node = createNode({
            transportType: 'carrier-pigeon',
            credentials: { userName: 'u', password: 'SECRET' }
        });
        try { node.acquireTransport(); } catch (e) { /* expected throw */ }
        // Whatever was logged via node.error must not leak the password.
        const logged = node.error.getCalls()
            .map(c => JSON.stringify(c.args))
            .join(' ');
        expect(logged).to.not.contain('SECRET');
    });

    // ─── thrash / leak ───

    it('18. 20 sequential acquire/release/acquire cycles leave no leaked timers or stale transport', function() {
        const clock = sinon.useFakeTimers();
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        sinon.stub(UdpTransport.prototype, 'close').resolves();
        for (let i = 0; i < 20; i++) {
            node.acquireTransport();
            node.releaseTransport();
            node.acquireTransport();
            node.releaseTransport();
            clock.tick(501); // let grace fire each cycle
        }
        expect(node._refCount).to.equal(0);
        expect(node._sharedTransport).to.be.null;
        expect(node._graceTimer).to.be.null;
        expect(clock.countTimers()).to.equal(0);
        clock.restore();
    });

    it('18b. W-4: transport warn event (UDP_REASSEMBLY_OVERFLOW) is surfaced via node.warn', function() {
        const node = createNode();
        sinon.stub(UdpTransport.prototype, 'connect').resolves();
        const t = node.acquireTransport();
        const warnCb = sinon.stub();
        node.registerStatusCallback(warnCb);
        t.emit('warn', { message: 'UDP_REASSEMBLY_OVERFLOW: dropped oldest key x' });
        expect(node.warn.called).to.be.true;
        const warnArg = node.warn.firstCall.args[0];
        expect(String(warnArg)).to.contain('UDP_REASSEMBLY_OVERFLOW');
        // warn is NOT part of the status fan-out set
        expect(warnCb.calledWith('warn')).to.be.false;
    });

    // ─── Task 2: HTML file content smoke checks ───

    describe('editor HTML', function() {
        let html;
        before(function() {
            html = fs.existsSync(HTML_PATH) ? fs.readFileSync(HTML_PATH, 'utf8') : '';
        });

        it('19. HTML declares CERT_ROUTE_PREFIX = opcua-pubsub-connection (no leading slash)', function() {
            expect(html).to.match(/CERT_ROUTE_PREFIX\s*=\s*["']opcua-pubsub-connection["']/);
        });

        it('20. HTML registers type opcua-pubsub-connection via RED.nodes.registerType', function() {
            expect(html).to.match(/RED\.nodes\.registerType\(\s*["']opcua-pubsub-connection["']/);
        });

        it('21. HTML defaults include transport/publisher/broker/multicast/qos/topic fields', function() {
            ['transportType', 'publisherIdType', 'publisherId', 'brokerUrl', 'multicastGroup', 'qos', 'topicPrefix']
                .forEach(f => expect(html, f).to.contain(f));
        });

        it('22. HTML defaults include the three cert placeholder fields', function() {
            ['certificateFile', 'privateKeyFile', 'caCertificateFile']
                .forEach(f => expect(html, f).to.contain(f));
        });

        it('23. HTML credentials block declares userName (text) and password (password)', function() {
            expect(html).to.match(/credentials:\s*\{[\s\S]*userName[\s\S]*password[\s\S]*\}/);
            expect(html).to.match(/type:\s*["']password["']/);
        });

        it('24. HTML contains updateTransportUI function bound to transportType change', function() {
            expect(html).to.contain('updateTransportUI');
            expect(html).to.match(/node-config-input-transportType[\s\S]{0,80}updateTransportUI|updateTransportUI[\s\S]{0,200}node-config-input-transportType/);
        });

        it('25. HTML contains updatePublisherIdUI function bound to publisherIdType change', function() {
            expect(html).to.contain('updatePublisherIdUI');
            expect(html).to.match(/node-config-input-publisherIdType[\s\S]{0,80}updatePublisherIdUI|updatePublisherIdUI[\s\S]{0,200}node-config-input-publisherIdType/);
        });

        it('26. HTML contains the three cert-dropzone divs', function() {
            const matches = html.match(/cert-dropzone/g) || [];
            expect(matches.length).to.be.at.least(3);
        });
    });
});
