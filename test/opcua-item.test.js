'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

function createRED() {
    const types = {};
    return {
        nodes: {
            createNode: function (node, config) { Object.assign(node, config); },
            registerType: function (name, constructor, opts) { types[name] = { constructor, opts }; },
            getNode: function () { return null; },
            _types: types
        }
    };
}

describe('opcua-item node', function () {
    let RED;
    let OpcUaItemConstructor;

    before(function () {
        RED = createRED();
        require('../nodes/opcua-item')(RED);
        OpcUaItemConstructor = RED.nodes._types['opcua-item'].constructor;
    });

    function createItemNode(config) {
        const node = {};
        const handlers = {};
        node.on = function (event, handler) {
            handlers[event] = handler;
        };
        node.status = sinon.stub();
        OpcUaItemConstructor.call(node, config);
        return { node, handlers };
    }

    function triggerInput(handlers, msg) {
        const send = sinon.stub();
        const done = sinon.stub();
        handlers['input'](msg, send, done);
        return { send, done };
    }

    // ─── Collector mode ───

    describe('collector mode', function () {
        it('should add item to msg.items array', function () {
            const { handlers } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Temp', datatype: 'Double', itemName: '' }],
                collector: true
            });
            const msg = {};
            const { send, done } = triggerInput(handlers, msg);

            expect(send.calledOnce).to.be.true;
            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items).to.be.an('array').with.length(1);
            expect(sentMsg.items[0].nodeId).to.equal('ns=2;s=Temp');
            expect(sentMsg.items[0].datatype).to.equal('Double');
            expect(done.calledOnce).to.be.true;
        });

        it('should append to existing msg.items array', function () {
            const { handlers } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Pressure', datatype: '', itemName: '' }],
                collector: true
            });
            const msg = { items: [{ nodeId: 'ns=2;s=Temp' }] };
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items).to.have.length(2);
            expect(sentMsg.items[1].nodeId).to.equal('ns=2;s=Pressure');
        });

        it('should activate collector mode when msg.items is already an array even if collector is false', function () {
            const { handlers } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Val', datatype: '', itemName: '' }],
                collector: false
            });
            const msg = { items: [{ nodeId: 'ns=2;s=Existing' }] };
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items).to.have.length(2);
        });

        it('should include value from msg.payload for write operations', function () {
            const { handlers } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Setpoint', datatype: '', itemName: '' }],
                collector: true
            });
            const msg = { payload: 42, operation: 'write' };
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items[0].value).to.equal(42);
        });

        it('should include value for writemultiple operations', function () {
            const { handlers } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Setpoint', datatype: '', itemName: '' }],
                collector: true
            });
            const msg = { payload: 100, operation: 'writemultiple' };
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items[0].value).to.equal(100);
        });

        it('should not include value for read operations', function () {
            const { handlers } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Temp', datatype: '', itemName: '' }],
                collector: true
            });
            const msg = { payload: 'ignored', operation: 'read' };
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items[0]).to.not.have.property('value');
        });
    });

    // ─── Legacy mode ───

    describe('legacy mode', function () {
        it('should set msg.topic to nodeId', function () {
            const { handlers } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Temp', datatype: 'Double', itemName: '' }],
                collector: false
            });
            const msg = {};
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.topic).to.equal('ns=2;s=Temp');
            expect(sentMsg.nodeId).to.equal('ns=2;s=Temp');
            expect(sentMsg.datatype).to.equal('Double');
        });

        it('should set itemName when configured', function () {
            const { handlers } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Temp', datatype: '', itemName: 'Temperature' }],
                collector: false
            });
            const msg = {};
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.itemName).to.equal('Temperature');
        });

        it('should not set datatype on msg if not configured', function () {
            const { handlers } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Val', datatype: '', itemName: '' }],
                collector: false
            });
            const msg = {};
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg).to.not.have.property('datatype');
        });
    });

    // ─── Pass-through ───

    describe('pass-through when no items', function () {
        it('should pass message through unchanged when items is empty', function () {
            const { handlers } = createItemNode({ items: [] });
            const msg = { payload: 'test', existing: true };
            const { send, done } = triggerInput(handlers, msg);

            expect(send.calledOnce).to.be.true;
            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.payload).to.equal('test');
            expect(sentMsg.existing).to.be.true;
            expect(sentMsg).to.not.have.property('items');
            expect(done.calledOnce).to.be.true;
        });

        it('should pass through when items is not configured at all', function () {
            const { handlers } = createItemNode({});
            const msg = { payload: 'data' };
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg).to.not.have.property('items');
            expect(sentMsg).to.not.have.property('topic');
        });
    });

    // ─── Migration from old format ───

    describe('migration from old single-item format', function () {
        it('should migrate old nodeId/datatype/itemName to items array', function () {
            const { handlers } = createItemNode({
                nodeId: 'ns=2;s=OldVar',
                datatype: 'Int32',
                itemName: 'OldName',
                collector: true
            });
            const msg = {};
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items).to.be.an('array').with.length(1);
            expect(sentMsg.items[0].nodeId).to.equal('ns=2;s=OldVar');
            expect(sentMsg.items[0].datatype).to.equal('Int32');
        });

        it('should not migrate if items already has entries', function () {
            const { handlers } = createItemNode({
                nodeId: 'ns=2;s=ShouldBeIgnored',
                items: [{ nodeId: 'ns=2;s=NewVar', datatype: '', itemName: '' }],
                collector: true
            });
            const msg = {};
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items).to.have.length(1);
            expect(sentMsg.items[0].nodeId).to.equal('ns=2;s=NewVar');
        });
    });

    // ─── Multiple items in one node ───

    describe('multiple items in one node', function () {
        it('should add all items to msg.items', function () {
            const { handlers } = createItemNode({
                items: [
                    { nodeId: 'ns=2;s=Temp', datatype: 'Double', itemName: 'Temperature' },
                    { nodeId: 'ns=2;s=Press', datatype: 'Float', itemName: 'Pressure' }
                ],
                collector: true
            });
            const msg = {};
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items).to.be.an('array').with.length(2);
            expect(sentMsg.items[0].nodeId).to.equal('ns=2;s=Temp');
            expect(sentMsg.items[1].nodeId).to.equal('ns=2;s=Press');
        });

        it('should skip items with empty nodeId', function () {
            const { handlers } = createItemNode({
                items: [
                    { nodeId: 'ns=2;s=Temp', datatype: '', itemName: '' },
                    { nodeId: '', datatype: '', itemName: '' }
                ],
                collector: true
            });
            const msg = {};
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items).to.be.an('array').with.length(1);
        });

        it('should attach write value to all items', function () {
            const { handlers } = createItemNode({
                items: [
                    { nodeId: 'ns=2;s=Var1', datatype: 'Int32', itemName: '' },
                    { nodeId: 'ns=2;s=Var2', datatype: 'Int32', itemName: '' }
                ],
                collector: true
            });
            const msg = { payload: 99, operation: 'writemultiple' };
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.items[0].value).to.equal(99);
            expect(sentMsg.items[1].value).to.equal(99);
        });

        it('should use legacy mode with first item only', function () {
            const { handlers } = createItemNode({
                items: [
                    { nodeId: 'ns=2;s=First', datatype: 'Double', itemName: 'FirstItem' },
                    { nodeId: 'ns=2;s=Second', datatype: '', itemName: '' }
                ],
                collector: false
            });
            const msg = {};
            const { send } = triggerInput(handlers, msg);

            const sentMsg = send.firstCall.args[0];
            expect(sentMsg.topic).to.equal('ns=2;s=First');
            expect(sentMsg.datatype).to.equal('Double');
            expect(sentMsg.itemName).to.equal('FirstItem');
            expect(sentMsg).to.not.have.property('items');
        });
    });

    // ─── Node status ───

    describe('node status', function () {
        it('should show nodeId for single item', function () {
            const { node } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Temp', datatype: '', itemName: '' }]
            });
            expect(node.status.calledOnce).to.be.true;
            expect(node.status.firstCall.args[0].text).to.equal('ns=2;s=Temp');
        });

        it('should prefer itemName for status text', function () {
            const { node } = createItemNode({
                items: [{ nodeId: 'ns=2;s=Temp', datatype: '', itemName: 'Temperature' }]
            });
            expect(node.status.firstCall.args[0].text).to.equal('Temperature');
        });

        it('should show count for multiple items', function () {
            const { node } = createItemNode({
                items: [
                    { nodeId: 'ns=2;s=Temp', datatype: '', itemName: '' },
                    { nodeId: 'ns=2;s=Press', datatype: '', itemName: '' },
                    { nodeId: 'ns=2;s=Flow', datatype: '', itemName: '' }
                ]
            });
            expect(node.status.firstCall.args[0].text).to.equal('3 items');
        });

        it('should not set status when no items', function () {
            const { node } = createItemNode({ items: [] });
            expect(node.status.called).to.be.false;
        });
    });

    // ─── Registration ───

    describe('registration', function () {
        it('should register as "opcua-item" type', function () {
            expect(RED.nodes._types).to.have.property('opcua-item');
        });
    });
});
