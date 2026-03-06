'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const path = require('path');

// ─── Shared RED mock ───

function createRED(nodeOverrides) {
    const types = {};
    const registeredNodes = {};
    return {
        nodes: {
            createNode: function(node, config) {
                Object.assign(node, config);
                node._events = {};
                node.on = function(event, cb) {
                    (node._events[event] = node._events[event] || []).push(cb);
                };
                node.status = sinon.stub();
                node.log = sinon.stub();
                node.warn = sinon.stub();
                node.error = sinon.stub();
            },
            registerType: function(name, ctor, opts) {
                types[name] = { constructor: ctor, opts };
            },
            getNode: function(id) {
                return registeredNodes[id] || nodeOverrides?.[id] || null;
            },
            _types: types,
            _registered: registeredNodes
        }
    };
}

// Helper: create a mock endpoint config node with getSharedManager
function createMockEndpoint(mockMgr) {
    return {
        getSharedManager: sinon.stub().returns(mockMgr),
        releaseSharedManager: sinon.stub().resolves(),
        registerStatusCallback: sinon.stub(),
        unregisterStatusCallback: sinon.stub()
    };
}

// ─── opcua-browser ───

describe('opcua-browser node', function() {
    let RED, browserCtor;

    beforeEach(function() {
        const mockClientManager = {
            isConnected: true,
            connect: sinon.stub().resolves(),
            browse: sinon.stub().resolves([
                { browseName: { name: 'Objects' }, nodeId: { toString: () => 'i=85' }, nodeClass: 'Object', typeDefinition: { toString: () => 'i=61' }, isForward: true },
                { browseName: { name: 'Types' }, nodeId: { toString: () => 'i=86' }, nodeClass: 'Object', typeDefinition: { toString: () => 'i=61' }, isForward: true }
            ])
        };
        RED = createRED({
            'ep1': createMockEndpoint(mockClientManager)
        });
        const epPath = path.resolve(__dirname, '..', 'nodes', 'opcua-browser.js');
        delete require.cache[require.resolve(epPath)];
        require(epPath)(RED);
        browserCtor = RED.nodes._types['opcua-browser'].constructor;
    });

    it('should register as opcua-browser', function() {
        expect(RED.nodes._types).to.have.property('opcua-browser');
    });

    it('should browse and return references on input', async function() {
        const node = {};
        browserCtor.call(node, { id: 'b1', endpoint: 'ep1' });

        const msg = { topic: 'RootFolder' };
        const send = sinon.stub();
        const done = sinon.stub();

        const inputHandler = node._events['input'][0];
        await inputHandler(msg, send, done);

        expect(send.calledOnce).to.be.true;
        const sent = send.firstCall.args[0];
        expect(sent.payload).to.be.an('array').with.lengthOf(2);
        expect(sent.payload[0].browseName).to.equal('Objects');
        expect(sent.browseResult.count).to.equal(2);
        expect(done.calledOnce).to.be.true;
    });

    it('should error when no endpoint configured', function() {
        const RED2 = createRED({});
        const epPath = path.resolve(__dirname, '..', 'nodes', 'opcua-browser.js');
        delete require.cache[require.resolve(epPath)];
        require(epPath)(RED2);
        const ctor = RED2.nodes._types['opcua-browser'].constructor;
        const node = {};
        ctor.call(node, { id: 'b2', endpoint: 'nonexistent' });
        expect(node.error.calledWith('OPC UA Endpoint missing')).to.be.true;
    });

    it('should auto-connect if not connected', async function() {
        const mgr = {
            isConnected: false,
            connect: sinon.stub().callsFake(async function() { mgr.isConnected = true; }),
            browse: sinon.stub().resolves([])
        };
        const RED2 = createRED({ 'ep1': createMockEndpoint(mgr) });
        const epPath = path.resolve(__dirname, '..', 'nodes', 'opcua-browser.js');
        delete require.cache[require.resolve(epPath)];
        require(epPath)(RED2);
        const ctor = RED2.nodes._types['opcua-browser'].constructor;
        const node = {};
        ctor.call(node, { id: 'b3', endpoint: 'ep1' });

        await node._events['input'][0]({ topic: 'i=85' }, sinon.stub(), sinon.stub());
        expect(mgr.connect.calledOnce).to.be.true;
    });
});

// ─── opcua-method ───

describe('opcua-method node', function() {
    let RED, methodCtor, mockMgr;

    beforeEach(function() {
        mockMgr = {
            isConnected: true,
            connect: sinon.stub().resolves(),
            callMethod: sinon.stub().resolves({
                statusCode: 'Good (0x00000000)',
                outputArguments: [{ dataType: 'Double', value: 10 }],
                inputArgumentResults: []
            })
        };
        RED = createRED({ 'ep1': createMockEndpoint(mockMgr) });
        const p = path.resolve(__dirname, '..', 'nodes', 'opcua-method.js');
        delete require.cache[require.resolve(p)];
        require(p)(RED);
        methodCtor = RED.nodes._types['opcua-method'].constructor;
    });

    it('should register as opcua-method', function() {
        expect(RED.nodes._types).to.have.property('opcua-method');
    });

    it('should call method with configured nodeIds', async function() {
        const node = {};
        methodCtor.call(node, { id: 'm1', endpoint: 'ep1', objectNodeId: 'ns=1;s=Methods', methodNodeId: 'ns=1;s=Methods.Add' });

        const msg = { inputArguments: [{ dataType: 'Double', value: 3 }, { dataType: 'Double', value: 7 }] };
        const send = sinon.stub();
        const done = sinon.stub();

        await node._events['input'][0](msg, send, done);

        expect(mockMgr.callMethod.calledOnce).to.be.true;
        expect(send.calledOnce).to.be.true;
        expect(send.firstCall.args[0].payload).to.deep.equal([10]);
        expect(send.firstCall.args[0].statusCode).to.equal('Good (0x00000000)');
    });

    it('should override nodeIds from msg', async function() {
        const node = {};
        methodCtor.call(node, { id: 'm2', endpoint: 'ep1', objectNodeId: 'ns=1;s=Default', methodNodeId: 'ns=1;s=Default' });

        const msg = { objectNodeId: 'ns=1;s=Methods', methodNodeId: 'ns=1;s=Methods.Multiply', inputArguments: [] };
        await node._events['input'][0](msg, sinon.stub(), sinon.stub());

        const callArgs = mockMgr.callMethod.firstCall.args;
        expect(callArgs[1]).to.include({ value: 'Methods.Multiply' });
    });

    it('should error when method NodeId is missing', async function() {
        const node = {};
        methodCtor.call(node, { id: 'm3', endpoint: 'ep1', objectNodeId: 'ns=1;s=Obj', methodNodeId: '' });

        const msg = {};
        const send = sinon.stub();
        const done = sinon.stub();
        await node._events['input'][0](msg, send, done);

        expect(node.error.called).to.be.true;
        expect(done.calledOnce).to.be.true;
    });

    it('should show kein Endpoint status when no endpoint', function() {
        const RED2 = createRED({});
        const p = path.resolve(__dirname, '..', 'nodes', 'opcua-method.js');
        delete require.cache[require.resolve(p)];
        require(p)(RED2);
        const ctor = RED2.nodes._types['opcua-method'].constructor;
        const node = {};
        ctor.call(node, { id: 'm4', endpoint: 'missing' });
        expect(node.status.calledWith(sinon.match({ text: 'no endpoint' }))).to.be.true;
    });
});

// ─── opcua-event ───

describe('opcua-event node', function() {
    let RED, eventCtor;

    it('should register as opcua-event', function() {
        RED = createRED({});
        const p = path.resolve(__dirname, '..', 'nodes', 'opcua-event.js');
        delete require.cache[require.resolve(p)];
        require(p)(RED);
        expect(RED.nodes._types).to.have.property('opcua-event');
    });

    it('should error when no endpoint configured', function() {
        RED = createRED({});
        const p = path.resolve(__dirname, '..', 'nodes', 'opcua-event.js');
        delete require.cache[require.resolve(p)];
        require(p)(RED);
        const ctor = RED.nodes._types['opcua-event'].constructor;
        const node = {};
        ctor.call(node, { id: 'e1', endpoint: 'missing' });
        expect(node.status.calledWith(sinon.match({ text: 'no endpoint' }))).to.be.true;
    });

    it('should set connected status when endpoint is connected', function() {
        const mockMgr = { isConnected: true, connect: sinon.stub().resolves(), createSubscription: sinon.stub().resolves({}) };
        RED = createRED({ 'ep1': createMockEndpoint(mockMgr) });
        const p = path.resolve(__dirname, '..', 'nodes', 'opcua-event.js');
        delete require.cache[require.resolve(p)];
        require(p)(RED);
        const ctor = RED.nodes._types['opcua-event'].constructor;
        const node = {};
        ctor.call(node, { id: 'e2', endpoint: 'ep1' });
        expect(node.status.calledWith(sinon.match({ text: 'connected' }))).to.be.true;
    });

    it('should cleanup on close', async function() {
        const mockMgr = { isConnected: true, connect: sinon.stub().resolves(), createSubscription: sinon.stub().resolves({}) };
        const mockEp = createMockEndpoint(mockMgr);
        RED = createRED({ 'ep1': mockEp });
        const p = path.resolve(__dirname, '..', 'nodes', 'opcua-event.js');
        delete require.cache[require.resolve(p)];
        require(p)(RED);
        const ctor = RED.nodes._types['opcua-event'].constructor;
        const node = {};
        ctor.call(node, { id: 'e3', endpoint: 'ep1' });

        const closeFn = node._events['close'][0];
        await new Promise(resolve => closeFn(false, resolve));
        expect(mockEp.unregisterStatusCallback.calledOnce).to.be.true;
        expect(mockEp.releaseSharedManager.calledOnce).to.be.true;
    });
});

// ─── opcua-server ───

describe('opcua-server node', function() {
    it('should register as opcua-server', function() {
        const RED = createRED({});
        const p = path.resolve(__dirname, '..', 'nodes', 'opcua-server.js');
        delete require.cache[require.resolve(p)];
        require(p)(RED);
        expect(RED.nodes._types).to.have.property('opcua-server');
        expect(RED.nodes._types['opcua-server'].constructor).to.be.a('function');
    });
});
