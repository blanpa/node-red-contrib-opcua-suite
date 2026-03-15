/**
 * OPC UA Utility Functions
 */

const WELL_KNOWN_NODES = {
  RootFolder: "i=84",
  ObjectsFolder: "i=85",
  TypesFolder: "i=86",
  ViewsFolder: "i=87",
  ObjectTypesFolder: "i=88",
  VariableTypesFolder: "i=89",
  DataTypesFolder: "i=90",
  ReferenceTypesFolder: "i=91",
  Server: "i=2253",
  ServerStatus: "i=2256",
};

/**
 * Parses a NodeId string into a NodeId object
 * Supports: ns=2;s=MyVar, ns=2;i=1234, i=84, s=MyVar, RootFolder, etc.
 */
function parseNodeId(nodeIdString) {
  if (!nodeIdString || typeof nodeIdString !== "string") {
    return null;
  }

  // Resolve well-known node names
  if (WELL_KNOWN_NODES[nodeIdString]) {
    nodeIdString = WELL_KNOWN_NODES[nodeIdString];
  }

  try {
    // Format: ns=X;type=value
    if (nodeIdString.includes(";")) {
      const parts = nodeIdString.split(";");
      let namespaceIndex = 0;
      let identifierPart = parts[0];

      if (parts[0].startsWith("ns=")) {
        namespaceIndex = parseInt(parts[0].substring(3), 10);
        identifierPart = parts[1];
      } else {
        // No ns= prefix, first part is the identifier
        identifierPart = parts.join(";");
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
        identifierType: "Numeric",
        value: parseInt(nodeIdString, 10),
      };
    }

    // Treat as string identifier
    return {
      namespaceIndex: 0,
      identifierType: "String",
      value: nodeIdString,
    };
  } catch (error) {
    return null;
  }
}

function parseIdentifier(identifier, namespaceIndex) {
  if (identifier.startsWith("s=")) {
    return {
      namespaceIndex,
      identifierType: "String",
      value: identifier.substring(2),
    };
  } else if (identifier.startsWith("i=")) {
    return {
      namespaceIndex,
      identifierType: "Numeric",
      value: parseInt(identifier.substring(2), 10),
    };
  } else if (identifier.startsWith("g=")) {
    return {
      namespaceIndex,
      identifierType: "Guid",
      value: identifier.substring(2),
    };
  } else if (identifier.startsWith("b=")) {
    return {
      namespaceIndex,
      identifierType: "ByteString",
      value: identifier.substring(2),
    };
  }
  return null;
}

/**
 * Converts a NodeId object to a string
 */
function nodeIdToString(nodeId) {
  if (!nodeId) return "";

  const ns = nodeId.namespaceIndex !== undefined ? nodeId.namespaceIndex : 0;
  let identifier = "";

  if (nodeId.identifierType === "Guid") {
    identifier = `g=${nodeId.value}`;
  } else if (nodeId.identifierType === "ByteString") {
    identifier = `b=${nodeId.value}`;
  } else if (
    nodeId.identifierType === "String" ||
    typeof nodeId.value === "string"
  ) {
    identifier = `s=${nodeId.value}`;
  } else if (
    nodeId.identifierType === "Numeric" ||
    typeof nodeId.value === "number"
  ) {
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
  if (!datatypeString || typeof datatypeString !== "string") {
    return { name: "Double", dimensions: null };
  }

  const arrayMatch = datatypeString.match(/^(\w+)\[([\d,]+)\]$/);
  if (arrayMatch) {
    const name = arrayMatch[1];
    const dimensions = arrayMatch[2].split(",").map((d) => parseInt(d, 10));
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
    stack: error ? error.stack : undefined,
  };
}

/**
 * Validates an OPC UA endpoint URL
 */
function isValidEndpointUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /^opc\.tcp:\/\/[^\/]+(:\d+)?(\/.*)?$/.test(url);
}

/**
 * Recursively serializes an OPC UA ExtensionObject (or OpaqueStructure)
 * into a plain JSON-friendly object suitable for Node-RED messages.
 *
 * - Named fields of typed ExtensionObjects become object properties
 * - OpaqueStructure (undecoded) returns { _raw: Buffer, _typeName: '...' }
 * - Nested ExtensionObjects are recursively serialized
 * - Date, Buffer, NodeId and other special types are converted to strings
 */
function serializeExtensionObject(extObj) {
  if (extObj === null || extObj === undefined) {
    return null;
  }

  // OpaqueStructure — raw bytes that couldn't be decoded
  if (extObj.constructor && extObj.constructor.name === "OpaqueStructure") {
    return {
      _opaque: true,
      _typeName: extObj.nodeId ? extObj.nodeId.toString() : "unknown",
      _raw: extObj.body ? Buffer.from(extObj.body).toString("base64") : null,
    };
  }

  // If it's not an object, return as-is
  if (typeof extObj !== "object") {
    return extObj;
  }

  // If it's a Date, return ISO string
  if (extObj instanceof Date) {
    return extObj.toISOString();
  }

  // If it's a Buffer, return base64
  if (Buffer.isBuffer(extObj)) {
    return extObj.toString("base64");
  }

  // If it has a toJSON method (some node-opcua types do), use it
  // but NOT for generic objects or ExtensionObjects which we want to flatten
  if (typeof extObj.toJSON === "function" && !extObj.schema) {
    return extObj.toJSON();
  }

  // Array handling
  if (Array.isArray(extObj)) {
    return extObj.map((item) => serializeExtensionObject(item));
  }

  // Typed ExtensionObject with a schema — extract named fields
  const result = {};
  if (extObj.schema && extObj.schema.name) {
    result._typeName = extObj.schema.name;
  }

  // Get all enumerable own properties plus any from the schema fields
  const keys = new Set(Object.keys(extObj));
  if (extObj.schema && extObj.schema.fields) {
    for (const field of extObj.schema.fields) {
      if (field.name) {
        keys.add(field.name);
      }
    }
  }

  for (const key of keys) {
    // Skip internal/private properties
    if (key.startsWith("_") || key === "schema" || key === "nodeId") continue;

    const val = extObj[key];
    if (typeof val === "function") continue;

    if (val === null || val === undefined) {
      result[key] = null;
    } else if (typeof val === "object") {
      result[key] = serializeExtensionObject(val);
    } else {
      result[key] = val;
    }
  }

  return result;
}

module.exports = {
  parseNodeId,
  nodeIdToString,
  parseDataType,
  createError,
  isValidEndpointUrl,
  serializeExtensionObject,
  WELL_KNOWN_NODES,
};
