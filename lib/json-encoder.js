/**
 * JSON Encoder / Decoder
 *
 * Stateless pure functions for encoding and decoding OPC UA PubSub
 * NetworkMessages in JSON wire format per OPC UA Part 14 v1.05 §7.2.5
 * and Part 6 §5.4 type mappings.
 *
 * Field emission order is hard-coded per Part 14 §7.2.5 schema (NOT
 * Object.keys() order — D-07). JSON.stringify is called only on per-field
 * converted values, never on the full message object (D-05).
 *
 * Exports:
 *   encodeNetworkMessage(networkMessage, opts?) -> string  (JSON text)
 *   decodeNetworkMessage(jsonString, opts?)     -> NetworkMessage
 *
 * `opts` is reserved for future extension (D-04). Unused in Phase 2.
 */

"use strict";

const crypto = require("crypto");
const { nodeIdToString, parseNodeId, createError } = require("./opcua-utils");

// ─── Constants ───

const UA_TYPE = {
  Boolean: 1, SByte: 2, Byte: 3, Int16: 4, UInt16: 5, Int32: 6, UInt32: 7,
  Int64: 8, UInt64: 9, Float: 10, Double: 11, String: 12, DateTime: 13,
  Guid: 14, ByteString: 15, NodeId: 17, StatusCode: 19,
};
const UA_TYPE_NAME = Object.fromEntries(Object.entries(UA_TYPE).map(([k, v]) => [v, k]));

const MESSAGE_TYPE_WIRE = {
  keyframe:   "ua-keyframe",
  deltaframe: "ua-deltaframe",
  event:      "ua-event",
  keepalive:  "ua-keepalive",
};
const MESSAGE_TYPE_MODEL = Object.fromEntries(Object.entries(MESSAGE_TYPE_WIRE).map(([k, v]) => [v, k]));

// ─── Value Conversion (Part 6 §5.4) ───

/**
 * Converts a domain value to a JSON-safe value for a given OPC UA type.
 * Uses Buffer.isBuffer then instanceof Date dispatch (same idiom as serializeExtensionObject).
 *
 * @param {*} value
 * @param {number} dataType  UA_TYPE ordinal
 * @returns {*} JSON-serializable value
 */
function _convertValueForJson(value, dataType) {
  if (value === null || value === undefined) return null;
  // BigInt → string for safe JSON (UInt64/Int64 exceed Number.MAX_SAFE_INTEGER)
  if (typeof value === "bigint") return value.toString();
  // ByteString (check before Date — Buffer is not a Date)
  if (Buffer.isBuffer(value)) return value.toString("base64");
  // DateTime
  if (value instanceof Date) return value.toISOString();
  // NodeId domain object — TODO Phase 3: add namespace-URI form per Part 6 §5.4
  if (value && typeof value === "object" && "identifierType" in value && "namespaceIndex" in value) {
    return nodeIdToString(value);
  }
  // Array — convert recursively
  if (Array.isArray(value)) return value.map((v) => _convertValueForJson(v, dataType));
  // Fall through: numbers, booleans, strings — already JSON-safe
  return value;
}

/**
 * Converts a JSON value back to a domain value for a given UA_TYPE ordinal.
 *
 * @param {*} value
 * @param {number} uaType  UA_TYPE ordinal
 * @returns {*} domain value
 */
function _convertValueFromJson(value, uaType) {
  if (value === null || value === undefined) return null;
  switch (uaType) {
    case UA_TYPE.DateTime:   return new Date(value);
    case UA_TYPE.ByteString: return Buffer.from(value, "base64");
    case UA_TYPE.NodeId:     return parseNodeId(value);
    case UA_TYPE.Int64:
    case UA_TYPE.UInt64:     return typeof value === "string" ? BigInt(value) : BigInt(value);
    default:
      if (Array.isArray(value)) return value.map((v) => _convertValueFromJson(v, uaType));
      return value;
  }
}

// ─── Variant Encoding ───

/**
 * Encodes a Variant field to a JSON string fragment.
 * Hard-coded order: UaType first, then Value (Part 6 §5.4 SHOULD).
 *
 * @param {{ dataType: string|number, value: * }} field
 * @returns {string} JSON object string
 */
function _encodeVariant(field) {
  // field shape: { dataType: 'Double' | number, value: <any> }
  const uaType = (typeof field.dataType === "number") ? field.dataType : UA_TYPE[field.dataType];
  if (!uaType) throw createError(`JSON_ENCODE_UNKNOWN_TYPE: ${field.dataType}`);
  const converted = _convertValueForJson(field.value, uaType);
  // Hard-coded order: UaType first, then Value (Part 6 §5.4 SHOULD)
  return `{"UaType":${uaType},"Value":${JSON.stringify(converted)}}`;
}

/**
 * Decodes a Variant JSON object to domain form.
 *
 * @param {object} obj
 * @param {string} path  JSON path for error reporting
 * @returns {{ dataType: number, value: * }}
 */
function _decodeVariant(obj, path) {
  if (!obj || typeof obj !== "object") {
    const err = createError(`Required Variant object missing at '${path}'`);
    err.code = "JSON_DECODE_MISSING_FIELD"; err.path = path; throw err;
  }
  if (typeof obj.UaType !== "number") {
    const err = createError(`Variant.UaType must be a number at '${path}'`);
    err.code = "JSON_DECODE_INVALID_TYPE"; err.path = `${path}.UaType`; throw err;
  }
  return { dataType: obj.UaType, value: _convertValueFromJson(obj.Value, obj.UaType) };
}

// ─── DataSetMessage Encoding ───

/**
 * Encodes a DataSetMessage domain object to a JSON string fragment.
 * Field emission order is hard-coded per Part 14 §7.2.5 schema order.
 *
 * @param {object} dsm
 * @returns {string} JSON object string
 */
function _encodeDataSetMessage(dsm) {
  const parts = [];
  if (dsm.dataSetWriterId !== undefined)   parts.push(`"DataSetWriterId":${JSON.stringify(dsm.dataSetWriterId)}`);
  if (dsm.dataSetWriterName !== undefined) parts.push(`"DataSetWriterName":${JSON.stringify(dsm.dataSetWriterName)}`);
  if (dsm.publisherId !== undefined)       parts.push(`"PublisherId":${JSON.stringify(String(dsm.publisherId))}`);
  if (dsm.writerGroupName !== undefined)   parts.push(`"WriterGroupName":${JSON.stringify(dsm.writerGroupName)}`);
  if (dsm.sequenceNumber !== undefined)    parts.push(`"SequenceNumber":${JSON.stringify(dsm.sequenceNumber)}`);
  if (dsm.configurationVersion !== undefined) {
    const cv = dsm.configurationVersion;
    parts.push(`"MetaDataVersion":{"MajorVersion":${JSON.stringify(cv.major)},"MinorVersion":${JSON.stringify(cv.minor)}}`);
  }
  if (dsm.timestamp instanceof Date)       parts.push(`"Timestamp":${JSON.stringify(dsm.timestamp.toISOString())}`);
  if (dsm.status !== undefined)            parts.push(`"Status":${JSON.stringify(dsm.status)}`);

  const messageTypeWire = MESSAGE_TYPE_WIRE[dsm.messageType || "keyframe"];
  if (!messageTypeWire) throw createError(`JSON_ENCODE_INVALID_MESSAGE_TYPE: ${dsm.messageType}`);
  parts.push(`"MessageType":${JSON.stringify(messageTypeWire)}`);

  // Payload — hard-coded last per §7.2.5
  const fields = dsm.fields || {};
  const fieldNames = Object.keys(fields);
  const fieldParts = fieldNames.map((name) => {
    const v = fields[name];
    // Always emit as Variant in JSON encoding (Part 14 JSON form — DataValue/RawData not in scope for v1 JSON)
    return `${JSON.stringify(name)}:${_encodeVariant(v)}`;
  });
  parts.push(`"Payload":{${fieldParts.join(",")}}`);

  return `{${parts.join(",")}}`;
}

/**
 * Decodes a DataSetMessage JSON object to domain form.
 *
 * @param {object} obj
 * @param {string} path  JSON path for error reporting
 * @returns {object} DataSetMessage domain object
 */
function _decodeDataSetMessage(obj, path) {
  if (!obj || typeof obj !== "object") {
    const err = createError(`Required DataSetMessage object missing at '${path}'`);
    err.code = "JSON_DECODE_MISSING_FIELD"; err.path = path; throw err;
  }
  const dsm = {};
  if (obj.DataSetWriterId !== undefined)   dsm.dataSetWriterId   = obj.DataSetWriterId;
  if (obj.DataSetWriterName !== undefined) dsm.dataSetWriterName = obj.DataSetWriterName;
  if (obj.PublisherId !== undefined)       dsm.publisherId       = obj.PublisherId;
  if (obj.WriterGroupName !== undefined)   dsm.writerGroupName   = obj.WriterGroupName;
  if (obj.SequenceNumber !== undefined)    dsm.sequenceNumber    = obj.SequenceNumber;
  if (obj.MetaDataVersion)                 dsm.configurationVersion = { major: obj.MetaDataVersion.MajorVersion, minor: obj.MetaDataVersion.MinorVersion };
  if (obj.Timestamp)                       dsm.timestamp = new Date(obj.Timestamp);
  if (obj.Status !== undefined)            dsm.status = obj.Status;
  dsm.messageType = MESSAGE_TYPE_MODEL[obj.MessageType] || "keyframe";

  if (!obj.Payload || typeof obj.Payload !== "object") {
    const err = createError("Required field 'Payload' is missing");
    err.code = "JSON_DECODE_MISSING_FIELD"; err.path = `${path}.Payload`; throw err;
  }
  dsm.fields = {};
  for (const [name, v] of Object.entries(obj.Payload)) {
    dsm.fields[name] = _decodeVariant(v, `${path}.Payload.${name}`);
  }
  return dsm;
}

// ─── NetworkMessage Encode/Decode ───

/**
 * Encodes a NetworkMessage to a JSON string per Part 14 §7.2.5.
 * Field emission order is hard-coded — Object.keys() order is NOT used.
 *
 * @param {object} networkMessage
 * @param {object} [opts] Reserved for future extension. Unused in Phase 2.
 * @returns {string} JSON text
 */
function encodeNetworkMessage(networkMessage, _opts) {
  if (!networkMessage || typeof networkMessage !== "object") {
    throw createError("JSON_ENCODE_INVALID_INPUT: networkMessage must be an object");
  }
  const messageId = networkMessage.messageId || crypto.randomUUID();

  const parts = [];
  parts.push(`"MessageId":${JSON.stringify(messageId)}`);
  parts.push(`"MessageType":"ua-data"`);
  if (networkMessage.publisherId !== undefined)   parts.push(`"PublisherId":${JSON.stringify(String(networkMessage.publisherId))}`);
  if (networkMessage.writerGroupName !== undefined) parts.push(`"WriterGroupName":${JSON.stringify(networkMessage.writerGroupName)}`);
  if (networkMessage.dataSetClassId)              parts.push(`"DataSetClassId":${JSON.stringify(networkMessage.dataSetClassId)}`);

  const dsms = Array.isArray(networkMessage.payload) ? networkMessage.payload : [];
  const dsmJson = dsms.map((dsm) => _encodeDataSetMessage(dsm));
  parts.push(`"Messages":[${dsmJson.join(",")}]`);

  return `{${parts.join(",")}}`;
}

/**
 * Decodes a JSON NetworkMessage string to the domain model.
 * Throws structured error { code, path, message } on missing required field.
 *
 * @param {string} jsonString
 * @param {object} [opts] Reserved for future extension. Unused in Phase 2.
 * @returns {object} NetworkMessage domain object
 */
function decodeNetworkMessage(jsonString, _opts) {
  let obj;
  try {
    obj = JSON.parse(jsonString);
  } catch (e) {
    const err = createError(`JSON parse error: ${e.message}`, e);
    err.code = "JSON_DECODE_PARSE_ERROR"; err.path = ""; throw err;
  }
  if (!obj || typeof obj !== "object") {
    const err = createError("Top-level JSON must be an object");
    err.code = "JSON_DECODE_INVALID_TYPE"; err.path = ""; throw err;
  }
  const required = ["MessageId", "MessageType", "Messages"];
  for (const f of required) {
    if (obj[f] === undefined) {
      const err = createError(`Required field '${f}' is missing`);
      err.code = "JSON_DECODE_MISSING_FIELD"; err.path = f; throw err;
    }
  }
  if (!Array.isArray(obj.Messages)) {
    const err = createError("'Messages' must be an array");
    err.code = "JSON_DECODE_INVALID_TYPE"; err.path = "Messages"; throw err;
  }
  const nm = { messageId: obj.MessageId };
  if (obj.PublisherId !== undefined)     nm.publisherId     = obj.PublisherId;
  if (obj.WriterGroupName !== undefined) nm.writerGroupName = obj.WriterGroupName;
  if (obj.DataSetClassId)                nm.dataSetClassId  = obj.DataSetClassId;
  nm.payload = obj.Messages.map((dsm, i) => _decodeDataSetMessage(dsm, `Messages[${i}]`));
  return nm;
}

module.exports = {
  encodeNetworkMessage,
  decodeNetworkMessage,
};
