'use strict';

/**
 * End-to-end regression test for issue #16: the addMethod server command
 * used to call namespace.addMethod(options) with a single argument, but the
 * node-opcua signature is addMethod(parentObject, options) — every call
 * failed with "expecting a valid parent object". These tests run a real
 * node-opcua server through the Node-RED node and call the created method
 * with a real OPC UA client.
 */

const { expect } = require('chai');
const sinon = require('sinon');
const path = require('path');
const { OPCUAClient, Variant, DataType } = require('node-opcua');

const PORT = 45899;

function createRED() {
    const types = {};
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
            getNode: () => null,
            _types: types
        }
    };
}

describe('opcua-server addMethod end-to-end (issue #16)', function() {
    this.timeout(25000);

    let node;
    let handler;
    let objectNodeId;
    let methodNodeId;

    // Sends a msg through the node's input handler like Node-RED would and
    // returns the (mutated) msg plus the error passed to done(), if any.
    async function invoke(msg) {
        let doneErr = null;
        await handler(msg, () => {}, (err) => { doneErr = err || null; });
        return { msg, err: doneErr };
    }

    before(async function() {
        const RED = createRED();
        const p = path.resolve(__dirname, '..', 'nodes', 'opcua-server.js');
        // opcua-nodes.test.js loads this module against a mocked node-opcua;
        // force a fresh load so we bind to the real library here.
        delete require.cache[require.resolve(p)];
        require(p)(RED);
        const Ctor = RED.nodes._types['opcua-server'].constructor;
        node = {};
        Ctor.call(node, { port: PORT, serverName: 'AddMethodTest' });

        for (let i = 0; i < 400 && !node.server; i++) {
            await new Promise(r => setTimeout(r, 50));
        }
        expect(node.server, 'server failed to start').to.exist;
        handler = node._events.input[0];
    });

    after(async function() {
        const closeCb = node && node._events.close && node._events.close[0];
        if (closeCb) {
            await new Promise(resolve => closeCb(false, resolve));
        }
    });

    async function withSession(fn) {
        const client = OPCUAClient.create({ endpointMustExist: false });
        await client.connect(node.endpointUrl);
        const session = await client.createSession();
        try {
            return await fn(session);
        } finally {
            await session.close();
            await client.disconnect();
        }
    }

    it('adds a method under an object created via addObject (the issue #16 flow)', async function() {
        const objResult = await invoke({ command: 'addObject', objectName: 'IndicatorOverride' });
        expect(objResult.err).to.equal(null);
        objectNodeId = objResult.msg.nodeId;
        expect(objectNodeId).to.match(/^ns=1;/);

        const methodResult = await invoke({
            command: 'addMethod',
            methodName: 'ExampleMethod',
            parentNodeId: objectNodeId,
            inputArguments: [{ name: 'input1', dataType: 'String' }],
            outputArguments: [{ name: 'output1', dataType: 'String' }]
        });
        expect(methodResult.err).to.equal(null);
        expect(methodResult.msg.error).to.be.undefined;
        methodNodeId = methodResult.msg.nodeId;
        expect(methodNodeId).to.match(/^ns=1;/);
        expect(methodResult.msg.methodName).to.equal('ExampleMethod');
    });

    it('created method is callable from a real OPC UA client (default handler)', async function() {
        const result = await withSession(session => session.call({
            objectId: objectNodeId,
            methodId: methodNodeId,
            inputArguments: [new Variant({ dataType: DataType.String, value: 'ping' })]
        }));

        expect(result.statusCode.name).to.equal('Good');
        expect(result.outputArguments).to.have.length(1);
        expect(result.outputArguments[0].dataType).to.equal(DataType.String);
        expect(result.outputArguments[0].value).to.equal('');
    });

    it('binds and executes a custom msg.func handler', async function() {
        const methodResult = await invoke({
            command: 'addMethod',
            methodName: 'EchoMethod',
            parentNodeId: objectNodeId,
            inputArguments: [{ name: 'text', dataType: 'String' }],
            outputArguments: [{ name: 'echo', dataType: 'String' }],
            func: `return {
                statusCode: StatusCodes.Good,
                outputArguments: [new Variant({
                    dataType: DataType.String,
                    value: 'echo:' + inputArguments[0].value
                })]
            };`
        });
        expect(methodResult.err).to.equal(null);

        const result = await withSession(session => session.call({
            objectId: objectNodeId,
            methodId: methodResult.msg.nodeId,
            inputArguments: [new Variant({ dataType: DataType.String, value: 'hello' })]
        }));

        expect(result.statusCode.name).to.equal('Good');
        expect(result.outputArguments[0].value).to.equal('echo:hello');
    });

    it('rejects addMethod without parentNodeId with a clear error', async function() {
        const { msg, err } = await invoke({ command: 'addMethod', methodName: 'NoParent' });
        expect(err).to.be.an('error');
        expect(msg.error).to.include('parentNodeId');
    });

    it('rejects addMethod under the standard Objects folder with a clear error', async function() {
        for (const parent of ['ObjectsFolder', 'i=85', 'ns=0;i=85']) {
            const { msg, err } = await invoke({
                command: 'addMethod',
                methodName: 'UnderObjects',
                parentNodeId: parent
            });
            expect(err, `parent=${parent}`).to.be.an('error');
            expect(msg.error, `parent=${parent}`).to.include('Objects folder');
        }
    });

    it('rejects addMethod with a nonexistent parent', async function() {
        const { msg, err } = await invoke({
            command: 'addMethod',
            methodName: 'Orphan',
            parentNodeId: 'ns=1;i=99999'
        });
        expect(err).to.be.an('error');
        expect(msg.error).to.include('Parent node not found');
    });

    it('rejects addMethod with a variable node as parent', async function() {
        const varResult = await invoke({
            command: 'addVariable',
            variableName: 'NotAnObject',
            parentNodeId: objectNodeId,
            datatype: 'Double',
            initialValue: 1.5
        });
        expect(varResult.err).to.equal(null);

        const { msg, err } = await invoke({
            command: 'addMethod',
            methodName: 'OnVariable',
            parentNodeId: varResult.msg.nodeId
        });
        expect(err).to.be.an('error');
        expect(msg.error).to.include('not an Object');
    });
});
