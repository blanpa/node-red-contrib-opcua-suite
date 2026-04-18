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

    // Regression test for issue #11: port from <input type="number"> arrives
    // as string from Node-RED. node-opcua then throws
    // "expecting a valid port (number)". Verify that opcua-server coerces
    // string ports (and other limits) to real numbers.
    describe('config coercion (issue #11)', function() {
        let capturedOpts;
        const opcuaPath = require.resolve('node-opcua');
        let originalOpcua;

        beforeEach(function() {
            capturedOpts = null;
            originalOpcua = require.cache[opcuaPath];
            require.cache[opcuaPath] = {
                id: opcuaPath,
                filename: opcuaPath,
                loaded: true,
                exports: {
                    OPCUAServer: function(opts) {
                        capturedOpts = opts;
                        this.initialize = () => Promise.resolve();
                        this.start = () => Promise.resolve();
                        this.shutdown = () => Promise.resolve();
                        this.getEndpointUrl = () => `opc.tcp://test:${opts.port}/UA/NodeRED`;
                        this.engine = { addressSpace: { getOwnNamespace: () => ({ index: 1 }) } };
                    },
                    Variant: function(o) { Object.assign(this, o); },
                    DataType: { Double: 11, String: 12 },
                    StatusCodes: { Good: { toString: () => 'Good' } },
                    coerceLocalizedText: (t) => t,
                    AccessLevelFlag: { CurrentRead: 1, CurrentWrite: 2 }
                }
            };
            const p = path.resolve(__dirname, '..', 'nodes', 'opcua-server.js');
            delete require.cache[require.resolve(p)];
        });

        afterEach(function() {
            if (originalOpcua) {
                require.cache[opcuaPath] = originalOpcua;
            } else {
                delete require.cache[opcuaPath];
            }
        });

        function buildNode(config) {
            const RED = createRED({});
            const p = path.resolve(__dirname, '..', 'nodes', 'opcua-server.js');
            require(p)(RED);
            const Ctor = RED.nodes._types['opcua-server'].constructor;
            const node = {};
            Ctor.call(node, config);
            return node;
        }

        it('should coerce string port from Node-RED editor to number', function(done) {
            buildNode({
                port: '4855',
                serverName: 'Issue11',
                maxAllowedSessionNumber: '20',
                maxConnectionsPerEndpoint: '15'
            });
            setImmediate(() => {
                expect(capturedOpts).to.not.be.null;
                expect(capturedOpts.port).to.equal(4855);
                expect(capturedOpts.port).to.be.a('number');
                expect(capturedOpts.maxAllowedSessionNumber).to.equal(20);
                expect(capturedOpts.maxConnectionsPerEndpoint).to.equal(15);
                done();
            });
        });

        it('should fall back to default 4840 when port is invalid', function(done) {
            buildNode({ port: 'abc', serverName: 'X' });
            setImmediate(() => {
                expect(capturedOpts.port).to.equal(4840);
                done();
            });
        });

        it('should fall back to default 4840 when port is empty string', function(done) {
            buildNode({ port: '', serverName: 'X' });
            setImmediate(() => {
                expect(capturedOpts.port).to.equal(4840);
                done();
            });
        });
    });

    // Regression test for issue #12: addVariable with the default parent
    // ObjectsFolder used to call namespace.addVariable({ componentOf: ... })
    // which node-opcua rejects with:
    //   "Only Organizes References are used to relate Objects to the
    //    'Objects' standard Object."
    // For the standard ObjectsFolder we must use { organizedBy: ... }.
    describe('addVariable parent reference (issue #12)', function() {
        let capturedAddVariable;
        let capturedAddMethod;
        const opcuaPath = require.resolve('node-opcua');
        let originalOpcua;

        beforeEach(function() {
            capturedAddVariable = null;
            capturedAddMethod = null;
            originalOpcua = require.cache[opcuaPath];
            const fakeNamespace = {
                index: 1,
                addFolder: () => ({ nodeId: { toString: () => 'ns=1;s=Folder' } }),
                addVariable: (opts) => {
                    capturedAddVariable = opts;
                    if ('componentOf' in opts && isStandardObjects(opts.componentOf)) {
                        throw new Error(
                            "Only Organizes References are used to relate Objects to the 'Objects' standard Object."
                        );
                    }
                    return { nodeId: { toString: () => 'ns=1;s=Var' } };
                },
                addMethod: (opts) => {
                    capturedAddMethod = opts;
                    if ('componentOf' in opts && isStandardObjects(opts.componentOf)) {
                        throw new Error(
                            "Only Organizes References are used to relate Objects to the 'Objects' standard Object."
                        );
                    }
                    return { nodeId: { toString: () => 'ns=1;s=Method' } };
                },
                addObject: () => ({ nodeId: { toString: () => 'ns=1;s=Obj' } })
            };
            function isStandardObjects(id) {
                const s = String(id);
                return s === 'ObjectsFolder' || s === 'i=85' || s === 'ns=0;i=85';
            }
            require.cache[opcuaPath] = {
                id: opcuaPath,
                filename: opcuaPath,
                loaded: true,
                exports: {
                    OPCUAServer: function() {
                        this.initialize = () => Promise.resolve();
                        this.start = () => Promise.resolve();
                        this.shutdown = () => Promise.resolve();
                        this.getEndpointUrl = () => 'opc.tcp://test:4840/UA/NodeRED';
                        this.engine = {
                            addressSpace: { getOwnNamespace: () => fakeNamespace }
                        };
                    },
                    Variant: function(o) { Object.assign(this, o); },
                    DataType: { Double: 11, String: 12 },
                    StatusCodes: { Good: { toString: () => 'Good' } },
                    coerceLocalizedText: (t) => t,
                    AccessLevelFlag: { CurrentRead: 1, CurrentWrite: 2 }
                }
            };
            const p = path.resolve(__dirname, '..', 'nodes', 'opcua-server.js');
            delete require.cache[require.resolve(p)];
        });

        afterEach(function() {
            if (originalOpcua) {
                require.cache[opcuaPath] = originalOpcua;
            } else {
                delete require.cache[opcuaPath];
            }
        });

        function buildServerNode() {
            const RED = createRED({});
            const p = path.resolve(__dirname, '..', 'nodes', 'opcua-server.js');
            require(p)(RED);
            const Ctor = RED.nodes._types['opcua-server'].constructor;
            const node = {};
            Ctor.call(node, { port: 4840, serverName: 'Test' });
            return node;
        }

        async function waitForServerReady(node) {
            for (let i = 0; i < 50 && !node.server; i++) {
                await new Promise(r => setImmediate(r));
            }
        }

        it('uses organizedBy when adding a variable to the standard ObjectsFolder', async function() {
            const node = buildServerNode();
            await waitForServerReady(node);

            const handler = node._events.input[0];
            const msg = {
                command: 'addVariable',
                variableName: 'Temperature',
                datatype: 'Double',
                initialValue: 20.0
            };
            await handler(msg, () => {}, () => {});

            expect(capturedAddVariable).to.not.be.null;
            expect(capturedAddVariable).to.have.property('organizedBy', 'ObjectsFolder');
            expect(capturedAddVariable).to.not.have.property('componentOf');
        });

        it('uses componentOf when adding a variable under a user-created folder', async function() {
            const node = buildServerNode();
            await waitForServerReady(node);

            const handler = node._events.input[0];
            const msg = {
                command: 'addVariable',
                variableName: 'Temperature',
                parentNodeId: 'ns=1;s=Sensors',
                datatype: 'Double',
                initialValue: 20.0
            };
            await handler(msg, () => {}, () => {});

            expect(capturedAddVariable).to.have.property('componentOf', 'ns=1;s=Sensors');
            expect(capturedAddVariable).to.not.have.property('organizedBy');
        });

        it('uses organizedBy when adding a method to the standard ObjectsFolder', async function() {
            const node = buildServerNode();
            await waitForServerReady(node);

            const handler = node._events.input[0];
            const msg = {
                command: 'addMethod',
                methodName: 'Reset',
                inputArguments: [],
                outputArguments: []
            };
            await handler(msg, () => {}, () => {});

            expect(capturedAddMethod).to.not.be.null;
            expect(capturedAddMethod).to.have.property('organizedBy', 'ObjectsFolder');
            expect(capturedAddMethod).to.not.have.property('componentOf');
        });
    });
});
