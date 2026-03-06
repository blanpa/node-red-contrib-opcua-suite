'use strict';

const { expect } = require('chai');
const {
    parseNodeId,
    nodeIdToString,
    createError,
    parseDataType,
    isValidEndpointUrl,
    WELL_KNOWN_NODES
} = require('../lib/opcua-utils');

describe('opcua-utils', function () {

    // ─── WELL_KNOWN_NODES ───

    describe('WELL_KNOWN_NODES', function () {
        it('should contain RootFolder mapped to i=84', function () {
            expect(WELL_KNOWN_NODES).to.have.property('RootFolder', 'i=84');
        });

        it('should contain ObjectsFolder mapped to i=85', function () {
            expect(WELL_KNOWN_NODES).to.have.property('ObjectsFolder', 'i=85');
        });

        it('should contain TypesFolder mapped to i=86', function () {
            expect(WELL_KNOWN_NODES).to.have.property('TypesFolder', 'i=86');
        });

        it('should contain ViewsFolder mapped to i=87', function () {
            expect(WELL_KNOWN_NODES).to.have.property('ViewsFolder', 'i=87');
        });

        it('should contain Server mapped to i=2253', function () {
            expect(WELL_KNOWN_NODES).to.have.property('Server', 'i=2253');
        });

        it('should contain ServerStatus mapped to i=2256', function () {
            expect(WELL_KNOWN_NODES).to.have.property('ServerStatus', 'i=2256');
        });
    });

    // ─── parseNodeId ───

    describe('parseNodeId', function () {
        it('should parse "ns=2;s=Var" as String identifier with namespace 2', function () {
            const result = parseNodeId('ns=2;s=Var');
            expect(result).to.deep.equal({
                namespaceIndex: 2,
                identifierType: 'String',
                value: 'Var'
            });
        });

        it('should parse "i=84" as Numeric identifier with namespace 0', function () {
            const result = parseNodeId('i=84');
            expect(result).to.deep.equal({
                namespaceIndex: 0,
                identifierType: 'Numeric',
                value: 84
            });
        });

        it('should parse "s=MyVar" as String identifier with namespace 0', function () {
            const result = parseNodeId('s=MyVar');
            expect(result).to.deep.equal({
                namespaceIndex: 0,
                identifierType: 'String',
                value: 'MyVar'
            });
        });

        it('should resolve "RootFolder" to Numeric i=84', function () {
            const result = parseNodeId('RootFolder');
            expect(result).to.deep.equal({
                namespaceIndex: 0,
                identifierType: 'Numeric',
                value: 84
            });
        });

        it('should resolve "ObjectsFolder" to Numeric i=85', function () {
            const result = parseNodeId('ObjectsFolder');
            expect(result).to.deep.equal({
                namespaceIndex: 0,
                identifierType: 'Numeric',
                value: 85
            });
        });

        it('should parse "ns=0;i=84" as Numeric identifier with namespace 0', function () {
            const result = parseNodeId('ns=0;i=84');
            expect(result).to.deep.equal({
                namespaceIndex: 0,
                identifierType: 'Numeric',
                value: 84
            });
        });

        it('should parse "ns=3;i=1000" as Numeric identifier with namespace 3', function () {
            const result = parseNodeId('ns=3;i=1000');
            expect(result).to.deep.equal({
                namespaceIndex: 3,
                identifierType: 'Numeric',
                value: 1000
            });
        });

        it('should parse "g=some-guid" as Guid identifier', function () {
            const result = parseNodeId('g=some-guid');
            expect(result).to.deep.equal({
                namespaceIndex: 0,
                identifierType: 'Guid',
                value: 'some-guid'
            });
        });

        it('should parse "b=base64data" as ByteString identifier', function () {
            const result = parseNodeId('b=base64data');
            expect(result).to.deep.equal({
                namespaceIndex: 0,
                identifierType: 'ByteString',
                value: 'base64data'
            });
        });

        it('should parse pure numeric string "1234" as Numeric identifier', function () {
            const result = parseNodeId('1234');
            expect(result).to.deep.equal({
                namespaceIndex: 0,
                identifierType: 'Numeric',
                value: 1234
            });
        });

        it('should return null for null input', function () {
            expect(parseNodeId(null)).to.be.null;
        });

        it('should return null for undefined input', function () {
            expect(parseNodeId(undefined)).to.be.null;
        });

        it('should return null for empty string', function () {
            expect(parseNodeId('')).to.be.null;
        });

        it('should return null for non-string input', function () {
            expect(parseNodeId(123)).to.be.null;
        });

        it('should treat unknown string as String identifier', function () {
            const result = parseNodeId('SomeUnknownNode');
            expect(result).to.deep.equal({
                namespaceIndex: 0,
                identifierType: 'String',
                value: 'SomeUnknownNode'
            });
        });

        it('should parse "ns=1;g=abcd-1234" as Guid with namespace 1', function () {
            const result = parseNodeId('ns=1;g=abcd-1234');
            expect(result).to.deep.equal({
                namespaceIndex: 1,
                identifierType: 'Guid',
                value: 'abcd-1234'
            });
        });
    });

    // ─── nodeIdToString ───

    describe('nodeIdToString', function () {
        it('should convert a String nodeId to "ns=0;s=MyVar"', function () {
            const result = nodeIdToString({
                namespaceIndex: 0,
                identifierType: 'String',
                value: 'MyVar'
            });
            expect(result).to.equal('ns=0;s=MyVar');
        });

        it('should convert a Numeric nodeId to "ns=2;i=1000"', function () {
            const result = nodeIdToString({
                namespaceIndex: 2,
                identifierType: 'Numeric',
                value: 1000
            });
            expect(result).to.equal('ns=2;i=1000');
        });

        it('should convert a Guid nodeId', function () {
            const result = nodeIdToString({
                namespaceIndex: 0,
                identifierType: 'Guid',
                value: 'abc-123'
            });
            expect(result).to.equal('ns=0;g=abc-123');
        });

        it('should convert a ByteString nodeId', function () {
            const result = nodeIdToString({
                namespaceIndex: 0,
                identifierType: 'ByteString',
                value: 'data'
            });
            expect(result).to.equal('ns=0;b=data');
        });

        it('should default namespace to 0 when not specified', function () {
            const result = nodeIdToString({
                identifierType: 'String',
                value: 'Test'
            });
            expect(result).to.equal('ns=0;s=Test');
        });

        it('should return empty string for null/undefined input', function () {
            expect(nodeIdToString(null)).to.equal('');
            expect(nodeIdToString(undefined)).to.equal('');
        });

        it('should infer type from value when identifierType is missing', function () {
            const numResult = nodeIdToString({ value: 42 });
            expect(numResult).to.equal('ns=0;i=42');

            const strResult = nodeIdToString({ value: 'Hello' });
            expect(strResult).to.equal('ns=0;s=Hello');
        });
    });

    // ─── createError ───

    describe('createError', function () {
        it('should create an error object with just a message', function () {
            const result = createError('something went wrong');
            expect(result).to.deep.equal({
                message: 'something went wrong',
                error: undefined,
                stack: undefined
            });
        });

        it('should include error details when an Error object is passed', function () {
            const err = new Error('inner error');
            const result = createError('outer message', err);
            expect(result.message).to.equal('outer message');
            expect(result.error).to.equal('inner error');
            expect(result.stack).to.be.a('string');
            expect(result.stack).to.include('inner error');
        });
    });

    // ─── parseDataType ───

    describe('parseDataType', function () {
        it('should return default Double for null input', function () {
            expect(parseDataType(null)).to.deep.equal({ name: 'Double', dimensions: null });
        });

        it('should parse a simple type name', function () {
            expect(parseDataType('Int32')).to.deep.equal({ name: 'Int32', dimensions: null });
        });

        it('should parse an array type with dimensions', function () {
            expect(parseDataType('FloatArray[5,5]')).to.deep.equal({
                name: 'FloatArray',
                dimensions: [5, 5]
            });
        });

        it('should parse a single-dimension array', function () {
            expect(parseDataType('Int32[10]')).to.deep.equal({
                name: 'Int32',
                dimensions: [10]
            });
        });
    });

    // ─── isValidEndpointUrl ───

    describe('isValidEndpointUrl', function () {
        it('should accept valid opc.tcp URL', function () {
            expect(isValidEndpointUrl('opc.tcp://localhost:4840')).to.be.true;
        });

        it('should accept URL with path', function () {
            expect(isValidEndpointUrl('opc.tcp://server:4840/UA/Server')).to.be.true;
        });

        it('should reject http URL', function () {
            expect(isValidEndpointUrl('http://localhost:4840')).to.be.false;
        });

        it('should reject null', function () {
            expect(isValidEndpointUrl(null)).to.be.false;
        });

        it('should reject empty string', function () {
            expect(isValidEndpointUrl('')).to.be.false;
        });
    });
});
