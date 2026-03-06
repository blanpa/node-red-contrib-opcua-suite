'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const path = require('path');

// Mock OpcUaClientManager
class MockClientManager {
    constructor(config) {
        this.config = config;
        this.isConnected = false;
        this._listeners = {};
    }
    on(event, cb) { (this._listeners[event] = this._listeners[event] || []).push(cb); }
    emit(event, ...args) { (this._listeners[event] || []).forEach(cb => cb(...args)); }
    async connect() { this.isConnected = true; this.emit('connected'); }
    async disconnect() { this.isConnected = false; this.emit('disconnected'); }
}

// Intercept require for opcua-client-manager
const Module = require('module');
const originalResolve = Module._resolveFilename;
let mockManagerClass = MockClientManager;

function createRED() {
    const nodes = {};
    const types = {};
    return {
        nodes: {
            createNode: function(node, config) { Object.assign(node, config); node._events = {}; },
            registerType: function(name, ctor, opts) { types[name] = { constructor: ctor, opts }; },
            getNode: function(id) { return nodes[id] || null; },
            _types: types,
            _nodes: nodes
        }
    };
}

describe('Connection Sharing', function() {

    let RED, endpointModule, endpointCtor;

    before(function() {
        // Patch require to inject mock
        Module._resolveFilename = function(request, parent) {
            if (request === '../lib/opcua-client-manager') {
                return 'mock-opcua-client-manager';
            }
            return originalResolve.apply(this, arguments);
        };
        require.cache['mock-opcua-client-manager'] = {
            id: 'mock-opcua-client-manager',
            filename: 'mock-opcua-client-manager',
            loaded: true,
            exports: mockManagerClass
        };
    });

    after(function() {
        Module._resolveFilename = originalResolve;
        delete require.cache['mock-opcua-client-manager'];
    });

    beforeEach(function() {
        RED = createRED();
        // Clear require cache for endpoint module
        const epPath = path.resolve(__dirname, '..', 'nodes', 'opcua-endpoint.js');
        delete require.cache[require.resolve(epPath)];
        endpointModule = require(epPath);
        endpointModule(RED);
        endpointCtor = RED.nodes._types['opcua-endpoint'].constructor;
    });

    function createEndpoint(overrides) {
        const config = {
            id: 'ep1',
            type: 'opcua-endpoint',
            endpointUrl: 'opc.tcp://localhost:4840',
            securityMode: 'None',
            securityPolicy: 'None',
            ...overrides
        };
        const node = {};
        // Simulate RED.nodes.createNode
        Object.assign(node, config);
        node._events = {};
        node.on = function(event, cb) { (node._events[event] = node._events[event] || []).push(cb); };
        node.log = sinon.stub();
        node.warn = sinon.stub();
        node.error = sinon.stub();
        node.credentials = {};
        endpointCtor.call(node, config);
        return node;
    }

    describe('getSharedManager', function() {

        it('should return a ClientManager instance on first call', function() {
            const ep = createEndpoint();
            const mgr = ep.getSharedManager();
            expect(mgr).to.exist;
            expect(mgr.config.endpointUrl).to.equal('opc.tcp://localhost:4840');
        });

        it('should return the SAME instance on subsequent calls', function() {
            const ep = createEndpoint();
            const mgr1 = ep.getSharedManager();
            const mgr2 = ep.getSharedManager();
            expect(mgr1).to.equal(mgr2);
        });

        it('should increment refCount on each call', function() {
            const ep = createEndpoint();
            expect(ep._refCount).to.equal(0);
            ep.getSharedManager();
            expect(ep._refCount).to.equal(1);
            ep.getSharedManager();
            expect(ep._refCount).to.equal(2);
            ep.getSharedManager();
            expect(ep._refCount).to.equal(3);
        });

        it('should use clientConfig for applicationName', function() {
            const ep = createEndpoint();
            const mgr = ep.getSharedManager({ applicationName: 'MyApp' });
            expect(mgr.config.applicationName).to.equal('MyApp');
        });
    });

    describe('releaseSharedManager', function() {

        it('should decrement refCount', async function() {
            const ep = createEndpoint();
            ep.getSharedManager();
            ep.getSharedManager();
            expect(ep._refCount).to.equal(2);
            await ep.releaseSharedManager();
            expect(ep._refCount).to.equal(1);
        });

        it('should NOT disconnect when other clients remain', async function() {
            const ep = createEndpoint();
            ep.getSharedManager();
            ep.getSharedManager();
            const mgr = ep._sharedManager;
            const disconnectSpy = sinon.spy(mgr, 'disconnect');
            await ep.releaseSharedManager();
            expect(disconnectSpy.called).to.be.false;
            expect(ep._sharedManager).to.exist;
        });

        it('should disconnect when last client releases', async function() {
            const ep = createEndpoint();
            ep.getSharedManager();
            const mgr = ep._sharedManager;
            const disconnectSpy = sinon.spy(mgr, 'disconnect');
            await ep.releaseSharedManager();
            expect(disconnectSpy.calledOnce).to.be.true;
            expect(ep._sharedManager).to.be.null;
            expect(ep._refCount).to.equal(0);
        });

        it('should not go below zero', async function() {
            const ep = createEndpoint();
            await ep.releaseSharedManager();
            await ep.releaseSharedManager();
            expect(ep._refCount).to.equal(0);
        });
    });

    describe('status propagation', function() {

        it('should call registered status callbacks on connected', function() {
            const ep = createEndpoint();
            const mgr = ep.getSharedManager();
            const cb = sinon.stub();
            ep.registerStatusCallback(cb);
            mgr.emit('connected');
            expect(cb.calledWith('connected')).to.be.true;
        });

        it('should call registered status callbacks on error', function() {
            const ep = createEndpoint();
            const mgr = ep.getSharedManager();
            const cb = sinon.stub();
            ep.registerStatusCallback(cb);
            const err = new Error('test error');
            mgr.emit('error', err);
            expect(cb.calledWith('error', err)).to.be.true;
        });

        it('should stop calling unregistered callbacks', function() {
            const ep = createEndpoint();
            const mgr = ep.getSharedManager();
            const cb = sinon.stub();
            ep.registerStatusCallback(cb);
            ep.unregisterStatusCallback(cb);
            mgr.emit('connected');
            expect(cb.called).to.be.false;
        });

        it('should propagate to multiple callbacks', function() {
            const ep = createEndpoint();
            const mgr = ep.getSharedManager();
            const cb1 = sinon.stub();
            const cb2 = sinon.stub();
            ep.registerStatusCallback(cb1);
            ep.registerStatusCallback(cb2);
            mgr.emit('reconnecting');
            expect(cb1.calledWith('reconnecting')).to.be.true;
            expect(cb2.calledWith('reconnecting')).to.be.true;
        });
    });

    describe('endpoint close cleanup', function() {

        it('should disconnect and cleanup on endpoint close', async function() {
            const ep = createEndpoint();
            ep.getSharedManager();
            ep.getSharedManager();
            const mgr = ep._sharedManager;
            const disconnectSpy = sinon.spy(mgr, 'disconnect');

            // Simulate close event
            const closeFn = ep._events['close'] && ep._events['close'][0];
            expect(closeFn).to.be.a('function');
            await new Promise(resolve => closeFn(resolve));

            expect(disconnectSpy.calledOnce).to.be.true;
            expect(ep._sharedManager).to.be.null;
            expect(ep._refCount).to.equal(0);
        });
    });
});
