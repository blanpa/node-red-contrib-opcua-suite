/**
 * OPC UA Utility Functions
 */

const WELL_KNOWN_NODES = {
    'RootFolder': 'i=84',
    'ObjectsFolder': 'i=85',
    'TypesFolder': 'i=86',
    'ViewsFolder': 'i=87',
    'ObjectTypesFolder': 'i=88',
    'VariableTypesFolder': 'i=89',
    'DataTypesFolder': 'i=90',
    'ReferenceTypesFolder': 'i=91',
    'Server': 'i=2253',
    'ServerStatus': 'i=2256',
};

/**
 * Parses a NodeId string into a NodeId object
 * Supports: ns=2;s=MyVar, ns=2;i=1234, i=84, s=MyVar, RootFolder, etc.
 */
function parseNodeId(nodeIdString) {
    if (!nodeIdString || typeof nodeIdString !== 'string') {
        return null;
    }

    // Resolve well-known node names
    if (WELL_KNOWN_NODES[nodeIdString]) {
        nodeIdString = WELL_KNOWN_NODES[nodeIdString];
    }

    try {
        // Format: ns=X;type=value
        if (nodeIdString.includes(';')) {
            const parts = nodeIdString.split(';');
            let namespaceIndex = 0;
            let identifierPart = parts[0];

            if (parts[0].startsWith('ns=')) {
                namespaceIndex = parseInt(parts[0].substring(3), 10);
                identifierPart = parts[1];
            } else {
                // No ns= prefix, first part is the identifier
                identifierPart = parts.join(';');
            }

            return parseIdentifier(identifierPart, namespaceIndex);
        }

        // Format without namespace: i=84, s=MyVar
        if (/^[sibg]=/.test(nodeIdString)) {
            return parseIdentifier(nodeIdString, 0);
        }

        // Pure numeric value
        if (/^\d+$/.test(nodeIdString)) {
            return {
                namespaceIndex: 0,
                identifierType: 'Numeric',
                value: parseInt(nodeIdString, 10)
            };
        }

        // Treat as string identifier
        return {
            namespaceIndex: 0,
            identifierType: 'String',
            value: nodeIdString
        };
    } catch (error) {
        return null;
    }
}

function parseIdentifier(identifier, namespaceIndex) {
    if (identifier.startsWith('s=')) {
        return { namespaceIndex, identifierType: 'String', value: identifier.substring(2) };
    } else if (identifier.startsWith('i=')) {
        return { namespaceIndex, identifierType: 'Numeric', value: parseInt(identifier.substring(2), 10) };
    } else if (identifier.startsWith('g=')) {
        return { namespaceIndex, identifierType: 'Guid', value: identifier.substring(2) };
    } else if (identifier.startsWith('b=')) {
        return { namespaceIndex, identifierType: 'ByteString', value: identifier.substring(2) };
    }
    return null;
}

/**
 * Converts a NodeId object to a string
 */
function nodeIdToString(nodeId) {
    if (!nodeId) return '';

    const ns = nodeId.namespaceIndex !== undefined ? nodeId.namespaceIndex : 0;
    let identifier = '';

    if (nodeId.identifierType === 'Guid') {
        identifier = `g=${nodeId.value}`;
    } else if (nodeId.identifierType === 'ByteString') {
        identifier = `b=${nodeId.value}`;
    } else if (nodeId.identifierType === 'String' || typeof nodeId.value === 'string') {
        identifier = `s=${nodeId.value}`;
    } else if (nodeId.identifierType === 'Numeric' || typeof nodeId.value === 'number') {
        identifier = `i=${nodeId.value}`;
    } else {
        identifier = `s=${nodeId.value}`;
    }

    return `ns=${ns};${identifier}`;
}

/**
 * Parses a DataType string (e.g. "Int32", "FloatArray[5,5]")
 */
function parseDataType(datatypeString) {
    if (!datatypeString || typeof datatypeString !== 'string') {
        return { name: 'Double', dimensions: null };
    }

    const arrayMatch = datatypeString.match(/^(\w+)\[([\d,]+)\]$/);
    if (arrayMatch) {
        const name = arrayMatch[1];
        const dimensions = arrayMatch[2].split(',').map(d => parseInt(d, 10));
        return { name, dimensions };
    }

    return { name: datatypeString, dimensions: null };
}

/**
 * Creates an error message in Node-RED format
 */
function createError(message, error = null) {
    return {
        message: message,
        error: error ? error.message : undefined,
        stack: error ? error.stack : undefined
    };
}

/**
 * Validates an OPC UA endpoint URL
 */
function isValidEndpointUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /^opc\.tcp:\/\/[^\/]+(:\d+)?(\/.*)?$/.test(url);
}

module.exports = {
    parseNodeId,
    nodeIdToString,
    parseDataType,
    createError,
    isValidEndpointUrl,
    WELL_KNOWN_NODES
};
