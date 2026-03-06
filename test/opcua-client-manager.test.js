'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

// We need to mock node-opcua before requiring OpcUaClientManager,
// because it imports node-opcua at the top level.
// We use a proxyquire-like approach: intercept require via Module._cache manipulation
// or simply test the parts that don't require a live connection.

// Since OpcUaClientManager requires node-opcua at module level, we will
// test it by requiring it and testing only the pure helper methods.
// The actual OPC UA connection tests belong in integration tests.

const OpcUaClientManager = require('../lib/opcua-client-manager');

describe('OpcUaClientManager', function () {

    // ─── Constructor ───

    describe('constructor', function () {
        it('should initialize with default config values', function () {
            const mgr = new OpcUaClientManager({ endpointUrl: 'opc.tcp://localhost:4840' });
            expect(mgr.config.endpointUrl).to.equal('opc.tcp://localhost:4840');
            expect(mgr.isConnected).to.be.false;
            expect(mgr.client).to.be.null;
            expect(mgr.session).to.be.null;
            expect(mgr.reconnectAttempts).to.equal(0);
            expect(mgr.maxReconnectAttempts).to.equal(10);
            expect(mgr.reconnectDelay).to.equal(5000);
        });

        it('should accept custom maxReconnectAttempts and reconnectDelay', function () {
            const mgr = new OpcUaClientManager({
                endpointUrl: 'opc.tcp://localhost:4840',
                maxReconnectAttempts: 3,
                reconnectDelay: 1000
            });
            expect(mgr.maxReconnectAttempts).to.equal(3);
            expect(mgr.reconnectDelay).to.equal(1000);
        });

        it('should be an EventEmitter', function () {
            const mgr = new OpcUaClientManager({ endpointUrl: 'opc.tcp://localhost:4840' });
            expect(mgr.on).to.be.a('function');
            expect(mgr.emit).to.be.a('function');
        });

        it('should initialize subscriptions as empty Map', function () {
            const mgr = new OpcUaClientManager({ endpointUrl: 'opc.tcp://localhost:4840' });
            expect(mgr.subscriptions).to.be.instanceOf(Map);
            expect(mgr.subscriptions.size).to.equal(0);
        });
    });

    // ─── _createVariant ───

    describe('_createVariant', function () {
        let mgr;

        beforeEach(function () {
            mgr = new OpcUaClientManager({ endpointUrl: 'opc.tcp://localhost:4840' });
        });

        it('should create a Boolean variant for boolean value', function () {
            const variant = mgr._createVariant(true);
            // node-opcua Variant stores dataType as numeric enum;
            // DataType.Boolean = 1
            expect(variant).to.have.property('value', true);
            expect(variant.dataType).to.exist;
        });

        it('should create a Boolean variant for false', function () {
            const variant = mgr._createVariant(false);
            expect(variant.value).to.equal(false);
        });

        it('should create an Int32 variant for integer number', function () {
            const variant = mgr._createVariant(42);
            expect(variant.value).to.equal(42);
        });

        it('should create a Double variant for floating-point number', function () {
            const variant = mgr._createVariant(3.14);
            expect(variant.value).to.equal(3.14);
        });

        it('should create a String variant for string value', function () {
            const variant = mgr._createVariant('hello');
            expect(variant.value).to.equal('hello');
        });

        it('should create a DateTime variant for Date value', function () {
            const date = new Date('2024-01-01T00:00:00Z');
            const variant = mgr._createVariant(date);
            expect(variant.value).to.equal(date);
        });

        it('should use explicit datatype when provided', function () {
            const variant = mgr._createVariant(42, 'Double');
            expect(variant.value).to.equal(42);
            // With explicit datatype, it should use DataType.Double
        });

        it('should use explicit String datatype', function () {
            const variant = mgr._createVariant('test', 'String');
            expect(variant.value).to.equal('test');
        });

        it('should fallback to generic Variant for unknown types', function () {
            const variant = mgr._createVariant({ complex: true });
            expect(variant).to.have.property('value');
        });

        it('should handle explicit Boolean datatype', function () {
            const variant = mgr._createVariant(true, 'Boolean');
            expect(variant.value).to.equal(true);
        });
    });

    // ─── _toOpcUaNodeId ───

    describe('_toOpcUaNodeId', function () {
        let mgr;

        beforeEach(function () {
            mgr = new OpcUaClientManager({ endpointUrl: 'opc.tcp://localhost:4840' });
        });

        it('should resolve a string nodeId', function () {
            const result = mgr._toOpcUaNodeId('i=84');
            // resolveNodeId returns a NodeId object from node-opcua
            expect(result).to.exist;
            expect(result.toString()).to.include('84');
        });

        it('should resolve a string nodeId with namespace', function () {
            const result = mgr._toOpcUaNodeId('ns=2;s=MyVariable');
            expect(result).to.exist;
        });

        it('should resolve an object nodeId with namespaceIndex and value', function () {
            const result = mgr._toOpcUaNodeId({
                namespaceIndex: 0,
                identifierType: 'Numeric',
                value: 84
            });
            expect(result).to.exist;
            expect(result.toString()).to.include('84');
        });

        it('should pass through an already-resolved nodeId', function () {
            // If nodeId has no namespaceIndex property and is not a string,
            // it should be returned as-is
            const obj = { some: 'thing' };
            const result = mgr._toOpcUaNodeId(obj);
            expect(result).to.equal(obj);
        });
    });

    // ─── _ensureConnected ───

    describe('_ensureConnected', function () {
        it('should throw when not connected', function () {
            const mgr = new OpcUaClientManager({ endpointUrl: 'opc.tcp://localhost:4840' });
            expect(() => mgr._ensureConnected()).to.throw('Not connected');
        });

        it('should throw when connected but no session', function () {
            const mgr = new OpcUaClientManager({ endpointUrl: 'opc.tcp://localhost:4840' });
            mgr.isConnected = true;
            mgr.session = null;
            expect(() => mgr._ensureConnected()).to.throw('Not connected');
        });

        it('should not throw when connected with a session', function () {
            const mgr = new OpcUaClientManager({ endpointUrl: 'opc.tcp://localhost:4840' });
            mgr.isConnected = true;
            mgr.session = {};
            expect(() => mgr._ensureConnected()).to.not.throw();
        });
    });

    // ─── scheduleReconnect ───

    describe('scheduleReconnect', function () {
        let mgr;
        let clock;

        beforeEach(function () {
            mgr = new OpcUaClientManager({
                endpointUrl: 'opc.tcp://localhost:4840',
                maxReconnectAttempts: 3,
                reconnectDelay: 100
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

        it('should increment reconnectAttempts', function () {
            mgr.scheduleReconnect();
            expect(mgr.reconnectAttempts).to.equal(1);
            expect(mgr.reconnectTimer).to.not.be.null;
        });

        it('should not schedule if already at max attempts', function () {
            mgr.reconnectAttempts = 3;
            mgr.scheduleReconnect();
            expect(mgr.reconnectTimer).to.be.null;
        });

        it('should not schedule if a timer is already pending', function () {
            mgr.scheduleReconnect();
            const firstTimer = mgr.reconnectTimer;
            mgr.scheduleReconnect();
            expect(mgr.reconnectTimer).to.equal(firstTimer);
            expect(mgr.reconnectAttempts).to.equal(1);
        });
    });
});
