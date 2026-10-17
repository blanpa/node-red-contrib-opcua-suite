/**
 * Builds node-opcua Variants from Node-RED message values.
 *
 * Message values arrive as plain JSON (inject node, HTTP, MQTT, ...), while
 * node-opcua expects typed JS values: a Date for DateTime, a NodeId instance
 * for NodeId, a Buffer for ByteString, ... Handed a plain value it either
 * throws an assertion with an empty message or — worse — silently encodes
 * something else (an ExpandedNodeId string became ns=0;i=0, a plain Variant
 * object became Null). Every write path converts through here so a value is
 * either encoded faithfully or rejected with an error naming the value.
 */

const {
  Variant,
  VariantArrayType,
  DataType,
  ExtensionObject,
  ExpandedNodeId,
  NodeId,
  resolveNodeId,
} = require("node-opcua");

/** Values that mean "infer the DataType from the JS value". */
const AUTO_NAMES = new Set(["", "auto", "Auto"]);

/**
 * Resolves a DataType given by name ("UInt16") or enum number.
 * Returns null for "no type given" (auto detection). An unknown name throws:
 * it used to fall back to auto detection (or Null / Double) silently.
 */
function resolveDataType(datatype) {
  if (datatype === null || datatype === undefined) return null;
  if (typeof datatype === "number") {
    if (DataType[datatype] === undefined) {
      throw new Error(`Unknown DataType: ${datatype}`);
    }
    return datatype;
  }
  if (typeof datatype === "string") {
    if (AUTO_NAMES.has(datatype.trim())) return null;
    const dt = DataType[datatype.trim()];
    if (typeof dt === "number") return dt;
  }
  throw new Error(`Unknown DataType: ${datatype}`);
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/** A Buffer serialized to JSON by Node-RED: { type: "Buffer", data: [...] } */
function isSerializedBuffer(value) {
  return (
    isPlainObject(value) && value.type === "Buffer" && Array.isArray(value.data)
  );
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function toByteString(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (isSerializedBuffer(value)) return Buffer.from(value.data);
  if (Array.isArray(value)) {
    if (!value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new Error("ByteString array must contain bytes (0-255)");
    }
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    // OPC UA JSON encodes ByteString as base64 — the same form a read of a
    // structure field or a PubSub JSON message delivers. Only accept strings
    // that round-trip, so plain text is rejected instead of being turned
    // into garbage bytes.
    const s = value.trim();
    if (
      s.length % 4 === 0 &&
      BASE64_RE.test(s) &&
      Buffer.from(s, "base64").toString("base64") === s
    ) {
      return Buffer.from(s, "base64");
    }
    throw new Error(
      "ByteString string must be base64 encoded (use a Buffer for raw bytes)",
    );
  }
  throw new Error("ByteString value must be a Buffer, byte array or base64");
}

function toDate(value) {
  const date =
    value instanceof Date
      ? value
      : typeof value === "number" || typeof value === "string"
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(
      "DateTime value must be a Date, an ISO 8601 string or epoch milliseconds",
    );
  }
  return date;
}

/** Converts the { namespace, identifierType, value } shape of parseNodeId(). */
function fromParsedNodeId(value) {
  const type = { Numeric: "i", String: "s", Guid: "g", ByteString: "b" }[
    value.identifierType
  ];
  if (!type || value.value === undefined) return null;
  return resolveNodeId(`ns=${value.namespace || 0};${type}=${value.value}`);
}

function toNodeId(value) {
  if (value instanceof NodeId) return value;
  if (typeof value === "string") return resolveNodeId(value.trim());
  if (isPlainObject(value)) {
    const nodeId = fromParsedNodeId(value);
    if (nodeId) return nodeId;
  }
  throw new Error("NodeId value must be a string like ns=2;s=Name");
}

/**
 * ExpandedNodeId from its string form: an optional `svr=<index>;` prefix,
 * then either `nsu=<namespace uri>;<id>` or a plain NodeId.
 */
function toExpandedNodeId(value) {
  if (value instanceof ExpandedNodeId) return value;
  if (value instanceof NodeId) return ExpandedNodeId.fromNodeId(value);
  if (typeof value !== "string") {
    throw new Error(
      "ExpandedNodeId value must be a string like ns=2;s=Name or nsu=<uri>;s=Name",
    );
  }
  let rest = value.trim();
  let serverIndex = 0;
  let namespaceUri = null;
  const svr = /^svr=(\d+);(.*)$/.exec(rest);
  if (svr) {
    serverIndex = parseInt(svr[1], 10);
    rest = svr[2];
  }
  const nsu = /^nsu=([^;]+);(.*)$/.exec(rest);
  if (nsu) {
    namespaceUri = nsu[1];
    rest = nsu[2];
  }
  const nodeId = resolveNodeId(rest);
  return new ExpandedNodeId(
    nodeId.identifierType,
    nodeId.value,
    nodeId.namespace,
    namespaceUri,
    serverIndex,
  );
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  throw new Error("Boolean value must be true/false");
}

/**
 * Converts one scalar message value to what node-opcua expects for
 * `dataType`. Types node-opcua already accepts as JSON are passed through.
 */
function coerceScalar(dataType, value) {
  switch (dataType) {
    case DataType.Boolean:
      return toBoolean(value);
    case DataType.String:
      return typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : value;
    case DataType.DateTime:
      return toDate(value);
    case DataType.ByteString:
      return toByteString(value);
    case DataType.NodeId:
      return toNodeId(value);
    case DataType.ExpandedNodeId:
      return toExpandedNodeId(value);
    case DataType.Int64:
    case DataType.UInt64:
      // node-opcua takes a number, a decimal string or [high, low] (the
      // form a read delivers) — but not a BigInt.
      return typeof value === "bigint" ? value.toString() : value;
    default:
      return value;
  }
}

/**
 * Infers a DataType from a JS value (auto mode). Returns null when there is
 * no sensible built-in type for it.
 */
function inferDataType(value) {
  if (typeof value === "boolean") return DataType.Boolean;
  if (typeof value === "number") {
    return Number.isInteger(value) ? DataType.Int32 : DataType.Double;
  }
  if (typeof value === "string") return DataType.String;
  if (typeof value === "bigint") return DataType.Int64;
  if (value instanceof Date) return DataType.DateTime;
  if (Buffer.isBuffer(value) || isSerializedBuffer(value)) {
    return DataType.ByteString;
  }
  return null;
}

function isScalarArrayForm(dataType, value) {
  if (dataType === DataType.ByteString) {
    return value.every((b) => typeof b === "number");
  }
  if (dataType === DataType.Int64 || dataType === DataType.UInt64) {
    return value.length === 2 && value.every((n) => Number.isInteger(n));
  }
  return false;
}

function wantsArray(arrayType) {
  return (
    arrayType === "Array" ||
    arrayType === true ||
    arrayType === VariantArrayType.Array
  );
}

function preview(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (_e) {
    text = undefined;
  }
  if (text === undefined) text = String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * Builds a Variant from a message value.
 *
 * @param {*} value              message value
 * @param {string|number|null} datatype  DataType name/enum, null/"" = auto
 * @param {string|boolean|null} arrayType "Array"/true for an array (ValueRank 1)
 * @returns {Variant}
 */
function buildVariant(value, datatype = null, arrayType = null) {
  if (value instanceof Variant) return value;

  const dataType = resolveDataType(datatype);
  const isArray = wantsArray(arrayType);

  // A Variant cannot hold a Variant: "Variant" means "the value carries its
  // own type", given as { dataType, value [, arrayType] } or inferred.
  if (dataType === DataType.Variant) {
    if (isPlainObject(value) && value.dataType !== undefined) {
      return buildVariant(value.value, value.dataType, value.arrayType);
    }
    return buildVariant(value, null, arrayType);
  }

  if (isArray && !Array.isArray(value)) {
    throw new Error(`Array value expected, got ${preview(value)}`);
  }

  const resolved =
    dataType ?? inferDataType(Array.isArray(value) ? value[0] : value);

  // A JS array is an OPC UA array unless it is the scalar's own JSON form:
  // the bytes of one ByteString, or the [high, low] pair of one Int64.
  const asArray =
    isArray || (Array.isArray(value) && !isScalarArrayForm(resolved, value));

  // No type to go on (e.g. a plain object in auto mode): keep the old
  // behaviour and let node-opcua decide.
  if (resolved === null) {
    return new Variant({
      ...(asArray ? { arrayType: VariantArrayType.Array } : {}),
      value,
    });
  }

  const typeName = DataType[resolved];
  let converted;
  try {
    converted = asArray
      ? value.map((v) => coerceScalar(resolved, v))
      : coerceScalar(resolved, value);
  } catch (error) {
    throw new Error(
      `Invalid ${typeName} value ${preview(value)}: ${error.message}`,
    );
  }

  try {
    return new Variant({
      dataType: resolved,
      // Int64/UInt64 scalars are [high, low] pairs to node-opcua; without an
      // explicit Scalar it refuses them as ambiguous with an array.
      arrayType: asArray ? VariantArrayType.Array : VariantArrayType.Scalar,
      value: converted,
    });
  } catch (error) {
    // node-opcua's assertions often carry no message at all.
    const reason = error.message && error.message.trim();
    throw new Error(
      `Invalid ${typeName} value ${preview(value)}` +
        (reason ? `: ${reason.split("\n")[0]}` : ""),
    );
  }
}

/**
 * True for a message value that can only be meant as a structure (or an
 * array of structures): a plain object that is not a serialized Buffer.
 */
function looksLikeStructure(value) {
  const probe = Array.isArray(value) ? value[0] : value;
  return (
    isPlainObject(probe) &&
    !isSerializedBuffer(probe) &&
    !(probe instanceof ExtensionObject)
  );
}

module.exports = {
  buildVariant,
  resolveDataType,
  looksLikeStructure,
  wantsArray,
};
