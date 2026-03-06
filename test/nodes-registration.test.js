'use strict';

const { expect } = require('chai');
const path = require('path');

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

const NODE_FILES = [
    { file: 'opcua-client.js', expectedType: 'opcua-client' },
    { file: 'opcua-server.js', expectedType: 'opcua-server' },
    { file: 'opcua-item.js', expectedType: 'opcua-item' },
    { file: 'opcua-endpoint.js', expectedType: 'opcua-endpoint' },
    { file: 'opcua-event.js', expectedType: 'opcua-event' },
    { file: 'opcua-method.js', expectedType: 'opcua-method' },
    { file: 'opcua-browser.js', expectedType: 'opcua-browser' }
];

describe('Node registration', function () {

    describe('each node file exports a function', function () {
        NODE_FILES.forEach(function ({ file }) {
            it(`${file} should export a function`, function () {
                const modulePath = path.resolve(__dirname, '..', 'nodes', file);
                const mod = require(modulePath);
                expect(mod).to.be.a('function');
            });
        });
    });

    describe('each node registers with correct type name', function () {
        NODE_FILES.forEach(function ({ file, expectedType }) {
            it(`${file} should register type "${expectedType}"`, function () {
                const RED = createRED();
                const modulePath = path.resolve(__dirname, '..', 'nodes', file);
                // Clear require cache so the module re-executes with our fresh RED mock
                delete require.cache[require.resolve(modulePath)];
                const mod = require(modulePath);
                mod(RED);
                expect(RED.nodes._types).to.have.property(expectedType);
                expect(RED.nodes._types[expectedType].constructor).to.be.a('function');
            });
        });
    });
});
