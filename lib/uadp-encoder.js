/**
 * UADP Binary Encoder / Decoder
 *
 * Stateless pure functions for encoding and decoding OPC UA PubSub
 * NetworkMessages and DataSetMessages in UADP binary format per
 * OPC UA Part 14 v1.05 §7.2.4.
 *
 * All optional header fields (UADPFlags, ExtendedFlags1, ExtendedFlags2,
 * DataSetFlags1, DataSetFlags2) are derived from model field presence at
 * encode time. Callers must NEVER set flag bytes directly
 * (Pitfall 1 mitigation, per D-09, D-10).
 *
 * Exports:
 *   encodeNetworkMessage(networkMessage, opts?)  -> Buffer | Buffer[]
 *   decodeNetworkMessage(buffer, opts?)          -> NetworkMessage
 *   encodeDataSetMessage(dataSetMessage, opts?)  -> Buffer
 *   decodeDataSetMessage(buffer, opts?)          -> DataSetMessage
 *
 * `opts` is reserved for future extension (security, MTU). `opts.mtu` is
 * honoured by encodeNetworkMessage in Phase 2 for chunking (D-15).
 *
 * encodeNetworkMessage return type:
 *   - Buffer when serialized output fits within mtu
 *   - Array<Buffer> of chunk NetworkMessages when output exceeds mtu
 *     (Part 14 §7.2.4.4.4, D-15, PITFALLS Pitfall 6)
 */

"use strict";

const { createError } = require("./opcua-utils");

// ─── Constants ───

const UADP_VERSION = 0x01;

const PUBLISHER_ID_TYPE = {
  BYTE:   0b000,
  UINT16: 0b001,
  UINT32: 0b010,
  UINT64: 0b011,
  STRING: 0b100,
};

const FILETIME_EPOCH_OFFSET_MS = 11644473600000n; // 1601-01-01 to 1970-01-01 in ms (BigInt)
const DATETIME_TICKS_PER_MS    = 10000n;          // 100ns ticks per ms

// ─── DataSetMessage Constants ─── (Part 14 §7.2.4.5.4)

const BUILTIN_TYPE = {
  Boolean: 1, SByte: 2, Byte: 3, Int16: 4, UInt16: 5, Int32: 6, UInt32: 7,
  Int64: 8, UInt64: 9, Float: 10, Double: 11, String: 12, DateTime: 13,
  Guid: 14, ByteString: 15, StatusCode: 19,
};

// DataSetFlags1 bits 1-2: FieldEncoding (00=Variant, 01=RawData, 10=DataValue)
const FIELD_ENCODING_BITS = { variant: 0b00, rawdata: 0b01, datavalue: 0b10 };
const FIELD_ENCODING_NAME = { 0b00: "variant", 0b01: "rawdata", 0b10: "datavalue" };

// DataSetFlags2 bits 0-3: MessageType (0000=KeyFrame, 0001=DeltaFrame, 0010=Event, 0011=KeepAlive)
const MESSAGE_TYPE_BITS = { keyframe: 0b0000, deltaframe: 0b0001, event: 0b0010, keepalive: 0b0011 };
const MESSAGE_TYPE_NAME = { 0b0000: "keyframe", 0b0001: "deltaframe", 0b0010: "event", 0b0011: "keepalive" };

// Default MTU per D-15 / PITFALLS Pitfall 6 (IPv4 UDP-safe)
const DEFAULT_MTU = 1400;

// ─── BinaryStream (private) ─── (Part 14 §7.2.4 supporting class)

/**
 * Internal cursor-based binary reader/writer.
 * Write mode: constructed with a size estimate (grows automatically on overflow).
 * Read mode: constructed with an existing Buffer; bounds-checked reads prevent
 * out-of-bounds access (T-02-01 mitigation, CWE-125).
 */
class BinaryStream {
  constructor(bufferOrSize) {
    if (Buffer.isBuffer(bufferOrSize)) {
      this._buf = bufferOrSize;
      this._cursor = 0;
      this._mode = "read";
    } else {
      this._buf = Buffer.allocUnsafe(bufferOrSize || 1500);
      this._cursor = 0;
      this._mode = "write";
    }
  }

  _ensureRead(n) {
    if (this._cursor + n > this._buf.length) {
      throw createError(`UADP_DECODE_TRUNCATED at offset ${this._cursor} (need ${n} bytes, have ${this._buf.length - this._cursor})`);
    }
  }

  _ensureWrite(n) {
    if (this._cursor + n > this._buf.length) {
      // grow: allocate new buffer 2x current, copy, reassign
      const grown = Buffer.allocUnsafe(Math.max(this._buf.length * 2, this._cursor + n));
      this._buf.copy(grown, 0, 0, this._cursor);
      this._buf = grown;
    }
  }

  writeUInt8(v)    { this._ensureWrite(1); this._buf.writeUInt8(v, this._cursor); this._cursor += 1; }
  writeUInt16LE(v) { this._ensureWrite(2); this._buf.writeUInt16LE(v, this._cursor); this._cursor += 2; }
  writeUInt32LE(v) { this._ensureWrite(4); this._buf.writeUInt32LE(v, this._cursor); this._cursor += 4; }
  writeUInt64LE(v) { this._ensureWrite(8); this._buf.writeBigUInt64LE(typeof v === "bigint" ? v : BigInt(v), this._cursor); this._cursor += 8; }
  writeInt64LE(v)  { this._ensureWrite(8); this._buf.writeBigInt64LE(typeof v === "bigint" ? v : BigInt(v), this._cursor); this._cursor += 8; }

  writeBytes(buf) {
    this._ensureWrite(buf.length);
    buf.copy(this._buf, this._cursor);
    this._cursor += buf.length;
  }

  writeString(s) {
    if (s === null || s === undefined) { this.writeUInt32LE(0xFFFFFFFF); return; }
    const b = Buffer.from(s, "utf8");
    this.writeUInt32LE(b.length);
    this.writeBytes(b);
  }

  /**
   * Encodes a GUID UUID string per OPC UA Part 6 §5.2.2.7.
   * Mixed-endian: Data1 LE UInt32, Data2 LE UInt16, Data3 LE UInt16, Data4 8 bytes as-is.
   * Input format: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   */
  writeGuid(uuidStr) {
    const parts = uuidStr.split("-");
    if (parts.length !== 5) throw createError(`UADP_ENCODE_INVALID_GUID: ${uuidStr}`);
    this.writeUInt32LE(parseInt(parts[0], 16));
    this.writeUInt16LE(parseInt(parts[1], 16));
    this.writeUInt16LE(parseInt(parts[2], 16));
    this.writeBytes(Buffer.from(parts[3] + parts[4], "hex"));
  }

  /**
   * Encodes a JS Date as OPC UA DateTime (Windows FILETIME: 100ns intervals since 1601-01-01).
   * See RESEARCH.md Pitfall 4 for epoch-mismatch risk.
   */
  writeDateTime(date) {
    const ms = BigInt(date.getTime());
    const ticks = (ms + FILETIME_EPOCH_OFFSET_MS) * DATETIME_TICKS_PER_MS;
    this.writeUInt64LE(ticks);
  }

  readUInt8()    { this._ensureRead(1); const v = this._buf.readUInt8(this._cursor); this._cursor += 1; return v; }
  readUInt16LE() { this._ensureRead(2); const v = this._buf.readUInt16LE(this._cursor); this._cursor += 2; return v; }
  readUInt32LE() { this._ensureRead(4); const v = this._buf.readUInt32LE(this._cursor); this._cursor += 4; return v; }
  readUInt64LE() { this._ensureRead(8); const v = this._buf.readBigUInt64LE(this._cursor); this._cursor += 8; return v; }

  readBytes(n) {
    this._ensureRead(n);
    const v = this._buf.subarray(this._cursor, this._cursor + n);
    this._cursor += n;
    return v;
  }

  readString() {
    const len = this.readUInt32LE();
    if (len === 0xFFFFFFFF) return null;
    return this.readBytes(len).toString("utf8");
  }

  /**
   * Decodes a GUID from wire format per OPC UA Part 6 §5.2.2.7.
   * Returns uppercase UUID string "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".
   */
  readGuid() {
    const d1  = this.readUInt32LE().toString(16).padStart(8, "0");
    const d2  = this.readUInt16LE().toString(16).padStart(4, "0");
    const d3  = this.readUInt16LE().toString(16).padStart(4, "0");
    const d4a = this.readBytes(2).toString("hex");
    const d4b = this.readBytes(6).toString("hex");
    return `${d1}-${d2}-${d3}-${d4a}-${d4b}`.toUpperCase();
  }

  /**
   * Decodes an OPC UA DateTime (Windows FILETIME) to a JS Date.
   * Inverse of writeDateTime.
   */
  readDateTime() {
    const ticks = this.readUInt64LE();
    const ms = Number(ticks / DATETIME_TICKS_PER_MS) - Number(FILETIME_EPOCH_OFFSET_MS);
    return new Date(ms);
  }

  /**
   * Returns only the written portion of the buffer (T-02-02 mitigation, CWE-908).
   * Never returns the full pre-allocated slab — trailing uninitialized bytes are excluded.
   */
  toBuffer() { return this._buf.subarray(0, this._cursor); }

  get remaining() { return this._buf.length - this._cursor; }
  get position()  { return this._cursor; }
}

// ─── Variant Codec (Part 6 §5.2.2.16) ───

/**
 * Writes a single scalar value for the given built-in type.
 * T-02-08 mitigation: unknown built-in type throws UADP_VARIANT_UNSUPPORTED_BUILTIN_TYPE (CWE-20).
 */
function _writeVariantScalar(stream, builtIn, value) {
  switch (builtIn) {
    case BUILTIN_TYPE.Boolean:
      stream.writeUInt8(value ? 1 : 0);
      break;
    case BUILTIN_TYPE.SByte:
      stream._ensureWrite(1); stream._buf.writeInt8(value, stream._cursor); stream._cursor += 1;
      break;
    case BUILTIN_TYPE.Byte:
      stream.writeUInt8(value);
      break;
    case BUILTIN_TYPE.Int16:
      stream._ensureWrite(2); stream._buf.writeInt16LE(value, stream._cursor); stream._cursor += 2;
      break;
    case BUILTIN_TYPE.UInt16:
      stream.writeUInt16LE(value);
      break;
    case BUILTIN_TYPE.Int32:
      stream._ensureWrite(4); stream._buf.writeInt32LE(value, stream._cursor); stream._cursor += 4;
      break;
    case BUILTIN_TYPE.UInt32:
      stream.writeUInt32LE(value);
      break;
    case BUILTIN_TYPE.Int64:
      stream.writeInt64LE(value);
      break;
    case BUILTIN_TYPE.UInt64:
      stream.writeUInt64LE(value);
      break;
    case BUILTIN_TYPE.Float:
      stream._ensureWrite(4); stream._buf.writeFloatLE(value, stream._cursor); stream._cursor += 4;
      break;
    case BUILTIN_TYPE.Double:
      stream._ensureWrite(8); stream._buf.writeDoubleLE(value, stream._cursor); stream._cursor += 8;
      break;
    case BUILTIN_TYPE.String:
      stream.writeString(value);
      break;
    case BUILTIN_TYPE.DateTime:
      stream.writeDateTime(value);
      break;
    case BUILTIN_TYPE.Guid:
      stream.writeGuid(value);
      break;
    case BUILTIN_TYPE.ByteString:
      if (value === null || value === undefined) { stream.writeUInt32LE(0xFFFFFFFF); break; }
      stream.writeUInt32LE(value.length); stream.writeBytes(value);
      break;
    case BUILTIN_TYPE.StatusCode:
      stream.writeUInt32LE(value >>> 0);
      break;
    default:
      throw createError(`UADP_VARIANT_UNSUPPORTED_BUILTIN_TYPE: ${builtIn}`);
  }
}

/**
 * Reads a single scalar value for the given built-in type.
 * T-02-08 mitigation: unknown built-in type throws UADP_VARIANT_UNSUPPORTED_BUILTIN_TYPE (CWE-20).
 */
function _readVariantScalar(stream, builtIn) {
  switch (builtIn) {
    case BUILTIN_TYPE.Boolean:
      return stream.readUInt8() !== 0;
    case BUILTIN_TYPE.SByte: {
      stream._ensureRead(1);
      const v = stream._buf.readInt8(stream._cursor);
      stream._cursor += 1;
      return v;
    }
    case BUILTIN_TYPE.Byte:
      return stream.readUInt8();
    case BUILTIN_TYPE.Int16: {
      stream._ensureRead(2);
      const v = stream._buf.readInt16LE(stream._cursor);
      stream._cursor += 2;
      return v;
    }
    case BUILTIN_TYPE.UInt16:
      return stream.readUInt16LE();
    case BUILTIN_TYPE.Int32: {
      stream._ensureRead(4);
      const v = stream._buf.readInt32LE(stream._cursor);
      stream._cursor += 4;
      return v;
    }
    case BUILTIN_TYPE.UInt32:
      return stream.readUInt32LE();
    case BUILTIN_TYPE.Int64: {
      stream._ensureRead(8);
      const v = stream._buf.readBigInt64LE(stream._cursor);
      stream._cursor += 8;
      return v;
    }
    case BUILTIN_TYPE.UInt64:
      return stream.readUInt64LE();
    case BUILTIN_TYPE.Float: {
      stream._ensureRead(4);
      const v = stream._buf.readFloatLE(stream._cursor);
      stream._cursor += 4;
      return v;
    }
    case BUILTIN_TYPE.Double: {
      stream._ensureRead(8);
      const v = stream._buf.readDoubleLE(stream._cursor);
      stream._cursor += 8;
      return v;
    }
    case BUILTIN_TYPE.String:
      return stream.readString();
    case BUILTIN_TYPE.DateTime:
      return stream.readDateTime();
    case BUILTIN_TYPE.Guid:
      return stream.readGuid();
    case BUILTIN_TYPE.ByteString: {
      const len = stream.readUInt32LE();
      if (len === 0xFFFFFFFF) return null;
      return Buffer.from(stream.readBytes(len)); // copy so caller owns it
    }
    case BUILTIN_TYPE.StatusCode:
      return stream.readUInt32LE();
    default:
      throw createError(`UADP_VARIANT_UNSUPPORTED_BUILTIN_TYPE: ${builtIn}`);
  }
}

/**
 * Encodes a Variant (Part 6 §5.2.2.16) onto stream.
 * EncodingByte: bits 0-5 = BuiltInType, bit 6 = IsArray, bit 7 = HasDimensions.
 * Supports scalar and 1D array variants. Null/undefined writes an empty Variant (0x00).
 */
function _writeVariant(stream, variant) {
  if (variant === null || variant === undefined) {
    stream.writeUInt8(0x00); // empty Variant
    return;
  }
  const { dataType, value } = variant;
  const builtIn = (typeof dataType === "number") ? dataType : BUILTIN_TYPE[dataType];
  if (!builtIn) throw createError(`UADP_VARIANT_UNKNOWN_TYPE: ${dataType}`);
  const isArray = Array.isArray(value);
  let encodingByte = builtIn & 0x3F;
  if (isArray) encodingByte |= 0x40;
  stream.writeUInt8(encodingByte);
  if (isArray) {
    // Int32 length prefix per Part 6 §5.2.2.16
    stream._ensureWrite(4); stream._buf.writeInt32LE(value.length, stream._cursor); stream._cursor += 4;
    for (const v of value) _writeVariantScalar(stream, builtIn, v);
  } else {
    _writeVariantScalar(stream, builtIn, value);
  }
}

/**
 * Decodes a Variant (Part 6 §5.2.2.16) from stream.
 * Returns null for empty Variant (EncodingByte = 0x00).
 * T-02-07 mitigation: array allocation bounded by actual buffer remaining bytes.
 */
function _readVariant(stream) {
  const encodingByte = stream.readUInt8();
  if (encodingByte === 0x00) return null; // empty Variant
  const builtIn = encodingByte & 0x3F;
  const isArray = (encodingByte & 0x40) !== 0;
  const hasDims = (encodingByte & 0x80) !== 0;
  let value;
  if (isArray) {
    stream._ensureRead(4);
    const len = stream._buf.readInt32LE(stream._cursor);
    stream._cursor += 4;
    value = [];
    for (let i = 0; i < len; i++) value.push(_readVariantScalar(stream, builtIn));
  } else {
    value = _readVariantScalar(stream, builtIn);
  }
  if (hasDims) {
    stream._ensureRead(4);
    const dimCount = stream._buf.readInt32LE(stream._cursor);
    stream._cursor += 4;
    const dims = [];
    for (let i = 0; i < dimCount; i++) {
      stream._ensureRead(4);
      dims.push(stream._buf.readInt32LE(stream._cursor));
      stream._cursor += 4;
    }
    return { dataType: builtIn, value, dimensions: dims };
  }
  return { dataType: builtIn, value };
}

// ─── DataValue Codec (Part 6 §5.2.2.17) ───

/**
 * Encodes a DataValue onto stream.
 *
 * EncodingMask:
 *   bit 0: Value (Variant) present
 *   bit 1: Status (UInt32) present
 *   bit 2: SourceTimestamp (DateTime) present
 *   bit 3: ServerTimestamp (DateTime) present
 *   bit 4: SourcePicoseconds (UInt16) present
 *   bit 5: ServerPicoseconds (UInt16) present
 */
function _writeDataValue(stream, dv) {
  if (dv === null || dv === undefined) {
    stream.writeUInt8(0x00);
    return;
  }
  let mask = 0x00;
  if (dv.value !== undefined && dv.value !== null) mask |= 0x01;
  if (dv.statusCode !== undefined)                 mask |= 0x02;
  if (dv.sourceTimestamp)                          mask |= 0x04;
  if (dv.serverTimestamp)                          mask |= 0x08;
  if (dv.sourcePicoseconds !== undefined)          mask |= 0x10;
  if (dv.serverPicoseconds !== undefined)          mask |= 0x20;
  stream.writeUInt8(mask);
  if (mask & 0x01) _writeVariant(stream, dv.value);
  if (mask & 0x02) stream.writeUInt32LE(dv.statusCode >>> 0);
  if (mask & 0x04) stream.writeDateTime(dv.sourceTimestamp);
  if (mask & 0x08) stream.writeDateTime(dv.serverTimestamp);
  if (mask & 0x10) stream.writeUInt16LE(dv.sourcePicoseconds);
  if (mask & 0x20) stream.writeUInt16LE(dv.serverPicoseconds);
}

/**
 * Decodes a DataValue from stream.
 * Inverse of _writeDataValue.
 */
function _readDataValue(stream) {
  const mask = stream.readUInt8();
  const dv = {};
  if (mask & 0x01) dv.value           = _readVariant(stream);
  if (mask & 0x02) dv.statusCode      = stream.readUInt32LE();
  if (mask & 0x04) dv.sourceTimestamp = stream.readDateTime();
  if (mask & 0x08) dv.serverTimestamp = stream.readDateTime();
  if (mask & 0x10) dv.sourcePicoseconds = stream.readUInt16LE();
  if (mask & 0x20) dv.serverPicoseconds = stream.readUInt16LE();
  return dv;
}

// ─── Flag Helpers (private) ─── (Part 14 §7.2.4 Table 75)

/**
 * Determines the ExtendedFlags1 bits 0-2 (PublisherId type) from the JS value type.
 * T-02-03 mitigation: strict typeof checks prevent Number/BigInt confusion (CWE-843).
 */
function _publisherIdTypeBits(value) {
  if (typeof value === "string")  return PUBLISHER_ID_TYPE.STRING;
  if (typeof value === "bigint")  return PUBLISHER_ID_TYPE.UINT64;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw createError(`UADP_ENCODE_INVALID_PUBLISHER_ID: must be non-negative integer, got ${value}`);
    }
    if (value <= 0xFF)         return PUBLISHER_ID_TYPE.BYTE;
    if (value <= 0xFFFF)       return PUBLISHER_ID_TYPE.UINT16;
    if (value <= 0xFFFFFFFF)   return PUBLISHER_ID_TYPE.UINT32;
    throw createError(`UADP_ENCODE_PUBLISHER_ID_TOO_LARGE: use BigInt for UInt64, got ${value}`);
  }
  throw createError(`UADP_ENCODE_PUBLISHER_ID_TYPE: unsupported type ${typeof value}`);
}

function _writePublisherId(stream, value, typeBits) {
  switch (typeBits) {
    case PUBLISHER_ID_TYPE.BYTE:   stream.writeUInt8(value);   break;
    case PUBLISHER_ID_TYPE.UINT16: stream.writeUInt16LE(value); break;
    case PUBLISHER_ID_TYPE.UINT32: stream.writeUInt32LE(value); break;
    case PUBLISHER_ID_TYPE.UINT64: stream.writeUInt64LE(value); break;
    case PUBLISHER_ID_TYPE.STRING: stream.writeString(value);   break;
  }
}

function _readPublisherId(stream, typeBits) {
  switch (typeBits) {
    case PUBLISHER_ID_TYPE.BYTE:   return stream.readUInt8();
    case PUBLISHER_ID_TYPE.UINT16: return stream.readUInt16LE();
    case PUBLISHER_ID_TYPE.UINT32: return stream.readUInt32LE();
    case PUBLISHER_ID_TYPE.UINT64: return stream.readUInt64LE(); // returns BigInt
    case PUBLISHER_ID_TYPE.STRING: return stream.readString();
    default: throw createError(`UADP_DECODE_INVALID_PUBLISHER_ID_TYPE: ${typeBits}`);
  }
}

/**
 * Builds ExtendedFlags2 byte from model field presence (Part 14 §7.2.4 Table 75 bits 0-7).
 * Cascade suppression order: build EF2 first, then EF1 checks EF2 != 0x00 for bit 7.
 */
function _buildExtendedFlags2(nm) {
  let f = 0x00;
  if (nm.chunk)           f |= 0x01; // bit 0: chunk message (Part 14 §7.2.4.4.4)
  if (nm.promotedFields)  f |= 0x02; // bit 1: PromotedFields enabled
  // bits 2-4 = 000 (DataSetMessage type). bit 5 ActionHeader = 0. bits 6-7 reserved.
  return f;
}

/**
 * Builds ExtendedFlags1 byte from model field presence (Part 14 §7.2.4 Table 75 bits 0-7).
 * bit 7 is set only when extFlags2 != 0x00 (cascade suppression).
 */
function _buildExtendedFlags1(nm, extFlags2) {
  let f = 0x00;
  if (nm.publisherId !== undefined) f |= (_publisherIdTypeBits(nm.publisherId) & 0x07); // bits 0-2
  if (nm.dataSetClassId)            f |= 0x08; // bit 3: DataSetClassId enabled
  // bit 4: SecurityHeader — Phase 2 always 0
  if (nm.timestamp)                 f |= 0x20; // bit 5: Timestamp enabled
  if (nm.picoseconds !== undefined && nm.timestamp) f |= 0x40; // bit 6: PicoSeconds (requires timestamp)
  if (extFlags2 !== 0x00)           f |= 0x80; // bit 7: ExtendedFlags2 enabled
  return f;
}

/**
 * Builds UADPFlags byte from model field presence (Part 14 §7.2.4 Table 75 bits 0-7).
 * bits 0-3 always = UADP_VERSION (0x01). bit 7 set only when extFlags1 != 0x00 (cascade).
 */
function _buildUADPFlags(nm, extFlags1) {
  let f = UADP_VERSION; // bits 0-3 = 0x01
  if (nm.publisherId !== undefined)  f |= 0x10; // bit 4: PublisherId enabled
  if (nm.groupHeader)                f |= 0x20; // bit 5: GroupHeader enabled
  if (nm.payloadHeader &&
      Array.isArray(nm.payloadHeader.dataSetWriterIds) &&
      nm.payloadHeader.dataSetWriterIds.length > 0) {
    f |= 0x40; // bit 6: PayloadHeader enabled
  }
  if (extFlags1 !== 0x00)            f |= 0x80; // bit 7: ExtendedFlags1 enabled
  return f;
}

// ─── NetworkMessage Header Writer (shared between normal and chunk encoders) ───

/**
 * Writes all NetworkMessage header fields (after the flag bytes) onto stream.
 * Used by both encodeNetworkMessage and _encodeChunkNetworkMessage so header
 * logic is not duplicated.
 *
 * @param {BinaryStream} stream
 * @param {object} nm - NetworkMessage domain model
 * @param {number} uadpFlags
 * @param {number} extFlags1
 * @param {number} extFlags2
 */
function _writeNetworkMessageHeaderFields(stream, nm, uadpFlags, extFlags1, extFlags2) {
  // PublisherId (Part 14 §7.2.4.3.1 — only if UADPFlags bit 4 = 1)
  if (uadpFlags & 0x10) {
    const typeBits = (uadpFlags & 0x80) ? (extFlags1 & 0x07) : 0;
    _writePublisherId(stream, nm.publisherId, typeBits);
  }

  // DataSetClassId GUID (Part 14 §7.2.4.3.2 — only if ExtFlags1 bit 3 = 1)
  if ((uadpFlags & 0x80) && (extFlags1 & 0x08)) {
    stream.writeGuid(nm.dataSetClassId);
  }

  // GroupHeader (Part 14 §7.2.4.3.3 — only if UADPFlags bit 5 = 1)
  // Fields in order: WriterGroupId UInt16, GroupVersion UInt32,
  //                  NetworkMessageNumber UInt16, SequenceNumber UInt16
  if (uadpFlags & 0x20) {
    const gh = nm.groupHeader;
    stream.writeUInt16LE(gh.writerGroupId);
    // ME-02: groupVersion and networkMessageNumber are optional on the inbound
    // groupHeader. The publisher currently omits them; default to 0 EXPLICITLY
    // here so the wire value is intentional rather than relying on
    // writeUInt32LE(undefined)/writeUInt16LE(undefined) coercing to 0.
    stream.writeUInt32LE(gh.groupVersion || 0);
    stream.writeUInt16LE(gh.networkMessageNumber || 0);
    stream.writeUInt16LE(gh.sequenceNumber);
  }

  // PayloadHeader (Part 14 §7.2.4.3.4 — only if UADPFlags bit 6 = 1)
  // Count UInt8, then Count × DataSetWriterId UInt16
  if (uadpFlags & 0x40) {
    const ids = nm.payloadHeader.dataSetWriterIds;
    stream.writeUInt8(ids.length);
    for (const id of ids) stream.writeUInt16LE(id);
  }

  // ExtendedNetworkMessageHeader fields (Part 14 §7.2.4.2.3):
  // Timestamp (ExtFlags1 bit 5), PicoSeconds (ExtFlags1 bit 6)
  if ((uadpFlags & 0x80) && (extFlags1 & 0x20)) {
    stream.writeDateTime(nm.timestamp);
  }
  if ((uadpFlags & 0x80) && (extFlags1 & 0x40)) {
    stream.writeUInt16LE(nm.picoseconds);
  }
}

// ─── Chunking (Part 14 §7.2.4.4.4) ───

/**
 * Splits a full payload buffer into chunk descriptors each carrying at most
 * (mtu - headerOverhead) bytes of data.
 *
 * @param {Buffer} fullPayload
 * @param {number} mtu
 * @param {number} headerOverhead - size in bytes of the chunk NetworkMessage header
 * @returns {Array<{chunkOffset: number, totalSize: number, chunkData: Buffer}>}
 */
function _splitIntoChunks(fullPayload, mtu, headerOverhead) {
  // Chunk payload overhead: UInt16 (seqNum) + UInt32 (offset) + UInt32 (totalSize) + UInt32 (data length prefix) = 12 bytes
  const CHUNK_PAYLOAD_OVERHEAD = 12;
  const maxChunkData = mtu - headerOverhead - CHUNK_PAYLOAD_OVERHEAD;
  if (maxChunkData <= 0) {
    throw createError(`UADP_CHUNK_MTU_TOO_SMALL: mtu ${mtu} is too small to fit chunk header overhead ${headerOverhead + CHUNK_PAYLOAD_OVERHEAD}`);
  }
  const chunks = [];
  let offset = 0;
  while (offset < fullPayload.length) {
    const size = Math.min(maxChunkData, fullPayload.length - offset);
    chunks.push({
      chunkOffset: offset,
      totalSize: fullPayload.length,
      chunkData: fullPayload.subarray(offset, offset + size),
    });
    offset += size;
  }
  return chunks;
}

/**
 * Encodes a single chunk NetworkMessage buffer.
 * Sets ExtendedFlags2 bit 0 (chunk marker) and writes the chunk-payload struct.
 *
 * @param {object} originalNm - the original NetworkMessage (for header fields)
 * @param {{chunkOffset: number, totalSize: number, chunkData: Buffer}} chunkInfo
 * @param {number} messageSequenceNumber - UInt16 sequence number of the reassembled payload
 * @param {number} dataSetWriterId - UInt16, from payloadHeader
 * @returns {Buffer}
 */
function _encodeChunkNetworkMessage(originalNm, chunkInfo, messageSequenceNumber, dataSetWriterId) {
  // Build a chunk-flagged NetworkMessage: same header as original, but with chunk marker
  // and payload replaced by the chunk-payload struct.
  const chunkNm = {
    publisherId: originalNm.publisherId,
    dataSetClassId: originalNm.dataSetClassId,
    groupHeader: originalNm.groupHeader,
    timestamp: originalNm.timestamp,
    picoseconds: originalNm.picoseconds,
    payloadHeader: { dataSetWriterIds: [dataSetWriterId] },
    chunk: chunkInfo, // triggers ExtendedFlags2 bit 0 in _buildExtendedFlags2
  };

  const extFlags2 = _buildExtendedFlags2(chunkNm);  // will be 0x01 (chunk bit)
  const extFlags1 = _buildExtendedFlags1(chunkNm, extFlags2);
  const uadpFlags = _buildUADPFlags(chunkNm, extFlags1);

  // Estimate: chunkData.length + 128 bytes slack for header fields
  const stream = new BinaryStream(chunkInfo.chunkData.length + 128);
  stream.writeUInt8(uadpFlags);
  if (uadpFlags & 0x80) stream.writeUInt8(extFlags1);
  if ((uadpFlags & 0x80) && (extFlags1 & 0x80)) stream.writeUInt8(extFlags2);

  _writeNetworkMessageHeaderFields(stream, chunkNm, uadpFlags, extFlags1, extFlags2);

  // Chunk payload (Part 14 §7.2.4.4.4):
  // MessageSequenceNumber UInt16, ChunkOffset UInt32, TotalSize UInt32, ChunkData ByteString
  stream.writeUInt16LE(messageSequenceNumber);
  stream.writeUInt32LE(chunkInfo.chunkOffset);
  stream.writeUInt32LE(chunkInfo.totalSize);
  stream.writeUInt32LE(chunkInfo.chunkData.length); // ByteString length prefix (UInt32)
  stream.writeBytes(chunkInfo.chunkData);

  return stream.toBuffer();
}

// ─── DataSetMessage Encode (Part 14 §7.2.4.5) ───

/**
 * Encodes a DataSetMessage to a binary Buffer.
 *
 * DataSetFlags1/2 are derived from model field presence at encode time — callers
 * must not set flag bytes directly (D-10 mitigation).
 *
 * DataSetFlags2 is suppressed when all its bits are zero (default KeyFrame, no
 * per-message timestamp) — DataSetFlags1 bit 7 is cleared in that case
 * (mirror of NetworkMessage cascade, Pitfall 2 mitigation).
 *
 * @param {object} dsm - DataSetMessage domain model (see D-10 in 02-CONTEXT.md)
 * @param {object} [opts] - Reserved for future extension (D-04).
 * @returns {Buffer} Wire-format DataSetMessage binary buffer
 */
function encodeDataSetMessage(dsm, _opts) {
  if (!dsm || typeof dsm !== "object") {
    throw createError("UADP_ENCODE_INVALID_INPUT: dataSetMessage must be an object");
  }
  const fieldEncoding = dsm.fieldEncoding || "variant";
  const messageType   = dsm.messageType   || "keyframe";
  const encodingBits  = FIELD_ENCODING_BITS[fieldEncoding];
  const messageBits   = MESSAGE_TYPE_BITS[messageType];
  if (encodingBits === undefined) throw createError(`UADP_ENCODE_INVALID_FIELD_ENCODING: ${fieldEncoding}`);
  if (messageBits === undefined)  throw createError(`UADP_ENCODE_INVALID_MESSAGE_TYPE: ${messageType}`);

  // Build DataSetFlags2 first (cascade: DS2 must be known before DS1 bit 7 can be set)
  let dsFlags2 = messageBits & 0x0F;                                        // bits 0-3: MessageType
  if (dsm.timestamp)                                     dsFlags2 |= 0x10;  // bit 4: Timestamp
  if (dsm.picoseconds !== undefined && dsm.timestamp)    dsFlags2 |= 0x20;  // bit 5: PicoSeconds

  // Build DataSetFlags1
  let dsFlags1 = (dsm.valid !== false) ? 0x01 : 0x00;                       // bit 0: Valid
  dsFlags1 |= (encodingBits & 0x03) << 1;                                   // bits 1-2: FieldEncoding
  if (dsm.sequenceNumber !== undefined)                  dsFlags1 |= 0x08;  // bit 3: SequenceNumber
  if (dsm.status !== undefined)                          dsFlags1 |= 0x10;  // bit 4: Status
  if (dsm.configurationVersion?.major !== undefined)     dsFlags1 |= 0x20;  // bit 5: ConfigVersionMajor
  if (dsm.configurationVersion?.minor !== undefined)     dsFlags1 |= 0x40;  // bit 6: ConfigVersionMinor
  if (dsFlags2 !== 0x00)                                 dsFlags1 |= 0x80;  // bit 7: DataSetFlags2 present

  const stream = new BinaryStream(256);
  stream.writeUInt8(dsFlags1);
  if (dsFlags1 & 0x80) stream.writeUInt8(dsFlags2);

  // Optional header fields (Part 14 §7.2.4.5.2)
  if (dsFlags1 & 0x08) stream.writeUInt16LE(dsm.sequenceNumber);
  // ME-03: DataSetMessage Status is a 16-bit Good/Bad/Uncertain SUMMARY
  // (Part 14 §7.2.4.5.2 DSM header Status), NOT a full 32-bit OPC UA
  // StatusCode. msg.statusCode surfaced from PubSub is this 16-bit summary.
  if (dsFlags1 & 0x10) stream.writeUInt16LE(dsm.status);
  if (dsFlags1 & 0x20) stream.writeUInt32LE(dsm.configurationVersion.major);
  if (dsFlags1 & 0x40) stream.writeUInt32LE(dsm.configurationVersion.minor);
  if (dsFlags2 & 0x10) stream.writeDateTime(dsm.timestamp);
  if (dsFlags2 & 0x20) stream.writeUInt16LE(dsm.picoseconds);

  // Field payload — KeepAlive has no body (Part 14 §7.2.4.5.3)
  if (messageType !== "keepalive") {
    const names = Object.keys(dsm.fields || {});
    stream.writeUInt16LE(names.length);
    for (const name of names) {
      const nameBytes = Buffer.from(name, "utf8");
      stream.writeUInt16LE(nameBytes.length);
      stream.writeBytes(nameBytes);
      const field = dsm.fields[name];
      if (fieldEncoding === "variant") {
        _writeVariant(stream, field);
      } else if (fieldEncoding === "datavalue") {
        _writeDataValue(stream, field);
      } else if (fieldEncoding === "rawdata") {
        // RawData: write raw scalar bytes using field's declared dataType
        // PITFALLS Pitfall 2: type info is still required at encode time
        const builtIn = (typeof field.dataType === "number") ? field.dataType : BUILTIN_TYPE[field.dataType];
        if (!builtIn) throw createError(`UADP_RAWDATA_UNKNOWN_TYPE on field "${name}": ${field.dataType}`);
        _writeVariantScalar(stream, builtIn, field.value);
      }
    }
  }

  return stream.toBuffer();
}

// ─── DataSetMessage Decode (Part 14 §7.2.4.5) ───

/**
 * Decodes a binary Buffer into a DataSetMessage domain model.
 *
 * Accepts either a Buffer (creates a BinaryStream internally) or a BinaryStream
 * directly (used by decodeNetworkMessage when reading from an existing stream).
 *
 * RawData decoding always throws UADP_RAWDATA_DECODE_REQUIRES_METADATA because
 * type metadata must come from an external DataSetMetaData message (Part 14 §7.2.4.5.3,
 * T-02-09 mitigation). Phase 4 will add a metadata-aware decode path.
 *
 * @param {Buffer|BinaryStream} buffer
 * @param {object} [opts] - Reserved for future extension (D-04).
 * @returns {object} Domain DataSetMessage model (see D-10 in 02-CONTEXT.md)
 */
function decodeDataSetMessage(buffer, _opts) {
  const stream = Buffer.isBuffer(buffer) ? new BinaryStream(buffer) : buffer;

  const dsFlags1 = stream.readUInt8();
  const dsFlags2 = (dsFlags1 & 0x80) ? stream.readUInt8() : 0x00;

  const dsm = {
    valid:         (dsFlags1 & 0x01) !== 0,
    fieldEncoding: FIELD_ENCODING_NAME[(dsFlags1 >> 1) & 0x03] || "variant",
    messageType:   MESSAGE_TYPE_NAME[dsFlags2 & 0x0F] || "keyframe",
  };

  if (dsFlags1 & 0x08) dsm.sequenceNumber = stream.readUInt16LE();
  // ME-03: 16-bit DSM Status SUMMARY (Good/Bad/Uncertain), not a 32-bit StatusCode.
  if (dsFlags1 & 0x10) dsm.status         = stream.readUInt16LE();
  if (dsFlags1 & 0x20 || dsFlags1 & 0x40) dsm.configurationVersion = {};
  if (dsFlags1 & 0x20) dsm.configurationVersion.major = stream.readUInt32LE();
  if (dsFlags1 & 0x40) dsm.configurationVersion.minor = stream.readUInt32LE();
  if (dsFlags2 & 0x10) dsm.timestamp   = stream.readDateTime();
  if (dsFlags2 & 0x20) dsm.picoseconds = stream.readUInt16LE();

  // T-02-09 mitigation: RawData decode requires external metadata (Phase 4).
  if (dsm.fieldEncoding === "rawdata") {
    throw createError("UADP_RAWDATA_DECODE_REQUIRES_METADATA: external dataType info needed");
  }

  // Field payload — KeepAlive has no body
  if (dsm.messageType !== "keepalive") {
    const count = stream.readUInt16LE();
    dsm.fields = {};
    for (let i = 0; i < count; i++) {
      // T-02-06 mitigation: _ensureRead inside readUInt16LE / readBytes guards truncation (CWE-125)
      const nameLen = stream.readUInt16LE();
      const name = Buffer.from(stream.readBytes(nameLen)).toString("utf8");
      if (dsm.fieldEncoding === "variant") {
        dsm.fields[name] = _readVariant(stream);
      } else if (dsm.fieldEncoding === "datavalue") {
        dsm.fields[name] = _readDataValue(stream);
      }
    }
  }

  return dsm;
}

// ─── NetworkMessage Encode (Part 14 §7.2.4.2) ───

/**
 * Encodes an OPC UA PubSub NetworkMessage to a binary Buffer (or Array<Buffer> when chunked).
 *
 * The three-level flag cascade (UADPFlags → ExtendedFlags1 → ExtendedFlags2) is
 * computed from model field presence — callers MUST NOT set flag bytes directly.
 *
 * DataSetMessages in `payload` are serialized after the header per Part 14 §7.2.4.3.
 * When PayloadHeader is present and count > 1, a UInt16 size array is written
 * before the DataSetMessage bodies (Part 14 §7.2.4.3 size array protocol).
 *
 * Chunking (Part 14 §7.2.4.4.4): when the encoded output exceeds `opts.mtu`
 * (default 1400 per D-15, PITFALLS Pitfall 6) AND the payload is non-empty,
 * returns an Array<Buffer> of chunk NetworkMessages. Each chunk has ExtendedFlags2
 * bit 0 set and carries a MessageSequenceNumber/ChunkOffset/TotalSize/ChunkData
 * struct in place of the normal DataSetMessage body.
 *
 * @param {object} networkMessage - Domain NetworkMessage model (see D-09 in 02-CONTEXT.md)
 * @param {object} [opts] - Options: { mtu?: number }
 * @returns {Buffer | Buffer[]} Wire-format UADP buffer, or Array<Buffer> of chunk messages
 */
function encodeNetworkMessage(networkMessage, opts) {
  if (!networkMessage || typeof networkMessage !== "object") {
    throw createError("UADP_ENCODE_INVALID_INPUT: networkMessage must be an object");
  }

  const mtu = (opts && typeof opts.mtu === "number") ? opts.mtu : DEFAULT_MTU;

  // Cascade suppression order: build extFlags2 first, then extFlags1 (checks extFlags2),
  // then uadpFlags (checks extFlags1). Each gate bit is set IFF the child byte is non-zero.
  const extFlags2 = _buildExtendedFlags2(networkMessage);
  const extFlags1 = _buildExtendedFlags1(networkMessage, extFlags2);
  const uadpFlags = _buildUADPFlags(networkMessage, extFlags1);

  const stream = new BinaryStream(1500); // estimated size; grows on overflow (D-03)

  // Byte 0: UADPFlags (always present)
  stream.writeUInt8(uadpFlags);

  // Byte 1: ExtendedFlags1 (only if UADPFlags bit 7 = 1)
  if (uadpFlags & 0x80) stream.writeUInt8(extFlags1);

  // Byte 2: ExtendedFlags2 (only if ExtendedFlags1 bit 7 = 1)
  if ((uadpFlags & 0x80) && (extFlags1 & 0x80)) stream.writeUInt8(extFlags2);

  _writeNetworkMessageHeaderFields(stream, networkMessage, uadpFlags, extFlags1, extFlags2);

  // PromotedFields (ExtFlags2 bit 1): deferred (requires Variant encoder — now available,
  // but PromotedFields is not part of this plan's scope). Throw if present.
  if ((uadpFlags & 0x80) && (extFlags1 & 0x80) && (extFlags2 & 0x02)) {
    throw createError("UADP_ENCODE_NOT_YET_IMPLEMENTED: promotedFields (Phase 3 concern)");
  }

  // SecurityHeader: Phase 2 always omitted (ExtFlags1 bit 4 always 0).

  // Payload: encode DataSetMessages
  const dsms = Array.isArray(networkMessage.payload) ? networkMessage.payload : [];

  // Encode each DataSetMessage to its own Buffer first (needed for size-array and chunk detection)
  const dsmBuffers = dsms.map((dsm) => encodeDataSetMessage(dsm));

  // Size array (Part 14 §7.2.4.3): emit one UInt16 size per DataSetMessage iff
  // PayloadHeader is present AND count > 1.
  if ((uadpFlags & 0x40) && dsmBuffers.length > 1) {
    for (const b of dsmBuffers) stream.writeUInt16LE(b.length);
  }

  // DataSetMessage bodies
  for (const b of dsmBuffers) stream.writeBytes(b);

  const encoded = stream.toBuffer();

  // Chunking: if encoded size exceeds MTU and there is a non-empty payload,
  // re-encode as chunk NetworkMessages (Part 14 §7.2.4.4.4).
  if (encoded.length > mtu && dsms.length > 0) {
    // CR-01: chunk the FULL ENCODED NetworkMessage (header + body), not the bare
    // concatenated DataSetMessage bodies. Reassembly on the receive side then yields
    // a complete NetworkMessage buffer that decodeNetworkMessage can decode directly
    // (reconstructing `encoded` byte-for-byte). Chunking the DSM bodies alone produced
    // a buffer starting with a DataSetFlags1 byte instead of UADPFlags, which the
    // subscriber could never decode (UADP_DECODE_UNSUPPORTED_VERSION).
    const fullPayload = encoded;

    // messageSequenceNumber from groupHeader (or 0 if absent)
    const messageSequenceNumber =
      (networkMessage.groupHeader && networkMessage.groupHeader.sequenceNumber != null)
        ? (networkMessage.groupHeader.sequenceNumber & 0xFFFF)
        : 0;

    // dataSetWriterId from payloadHeader (spec §7.2.4.4.4 requires single-DSW for chunks)
    const dataSetWriterId =
      networkMessage.payloadHeader &&
      Array.isArray(networkMessage.payloadHeader.dataSetWriterIds) &&
      networkMessage.payloadHeader.dataSetWriterIds.length > 0
        ? networkMessage.payloadHeader.dataSetWriterIds[0]
        : 0;

    // Compute header overhead by encoding a zero-length chunk and measuring
    const probeChunk = _encodeChunkNetworkMessage(
      networkMessage,
      { chunkOffset: 0, totalSize: fullPayload.length, chunkData: Buffer.alloc(0) },
      messageSequenceNumber,
      dataSetWriterId
    );
    const headerOverhead = probeChunk.length; // includes the 12-byte chunk-payload struct header

    const chunkInfos = _splitIntoChunks(fullPayload, mtu, headerOverhead);
    return chunkInfos.map((ci) =>
      _encodeChunkNetworkMessage(networkMessage, ci, messageSequenceNumber, dataSetWriterId)
    );
  }

  // Return only the written portion (T-02-02 mitigation — never expose full pre-allocated slab)
  return encoded;
}

// ─── NetworkMessage Decode (Part 14 §7.2.4.2) ───

/**
 * Decodes a UADP binary buffer into a domain NetworkMessage model.
 *
 * Reads gate bits before consuming each optional field. Throws a structured
 * createError on truncated or malformed input (T-02-01 mitigation, CWE-125).
 * The returned model never contains flag-byte fields — re-derived on next encode.
 *
 * Chunk messages (ExtendedFlags2 bit 0 = 1) are decoded with `nm.chunk` populated
 * and `nm.payload = []`. Reassembly is Phase 3 UDP transport responsibility
 * (T-02-10 accept disposition — sender-side only in Phase 2).
 *
 * @param {Buffer} buffer - Wire-format UADP binary buffer
 * @param {object} [opts] - Reserved for future extension. Unused in Phase 2 (D-04).
 * @returns {object} Domain NetworkMessage model (see D-09 in 02-CONTEXT.md)
 */
function decodeNetworkMessage(buffer, _opts) {
  if (!Buffer.isBuffer(buffer)) {
    throw createError("UADP_DECODE_INVALID_INPUT: expected Buffer");
  }

  const stream = new BinaryStream(buffer);

  // Byte 0: UADPFlags (always present)
  const uadpFlags = stream.readUInt8();

  // Version check: bits 0-3 must equal UADP_VERSION (T-02-05 mitigation)
  if ((uadpFlags & 0x0F) !== UADP_VERSION) {
    throw createError(`UADP_DECODE_UNSUPPORTED_VERSION: expected ${UADP_VERSION}, got ${uadpFlags & 0x0F}`);
  }

  // Byte 1: ExtendedFlags1 (only if UADPFlags bit 7 = 1; else default 0x00 = no extended features)
  const extFlags1 = (uadpFlags & 0x80) ? stream.readUInt8() : 0x00;

  // Byte 2: ExtendedFlags2 (only if ExtendedFlags1 bit 7 = 1)
  const extFlags2 = (extFlags1 & 0x80) ? stream.readUInt8() : 0x00;

  const nm = {};

  // PublisherId (only if UADPFlags bit 4 = 1)
  if (uadpFlags & 0x10) {
    const typeBits = extFlags1 & 0x07;
    nm.publisherId = _readPublisherId(stream, typeBits);
  }

  // DataSetClassId GUID (only if ExtFlags1 bit 3 = 1)
  if (extFlags1 & 0x08) {
    nm.dataSetClassId = stream.readGuid();
  }

  // GroupHeader (only if UADPFlags bit 5 = 1)
  if (uadpFlags & 0x20) {
    nm.groupHeader = {
      writerGroupId:        stream.readUInt16LE(),
      groupVersion:         stream.readUInt32LE(),
      networkMessageNumber: stream.readUInt16LE(),
      sequenceNumber:       stream.readUInt16LE(),
    };
  }

  // PayloadHeader (only if UADPFlags bit 6 = 1)
  if (uadpFlags & 0x40) {
    const count = stream.readUInt8();
    const ids = [];
    for (let i = 0; i < count; i++) ids.push(stream.readUInt16LE());
    nm.payloadHeader = { dataSetWriterIds: ids };
  }

  // Timestamp (ExtFlags1 bit 5) and PicoSeconds (ExtFlags1 bit 6)
  if (extFlags1 & 0x20) nm.timestamp   = stream.readDateTime();
  if (extFlags1 & 0x40) nm.picoseconds = stream.readUInt16LE();

  // PromotedFields (ExtFlags2 bit 1): deferred
  if (extFlags2 & 0x02) {
    throw createError("UADP_DECODE_NOT_YET_IMPLEMENTED: promotedFields decoding (Phase 3 concern)");
  }

  // Chunk (ExtFlags2 bit 0): decode chunk payload struct (Part 14 §7.2.4.4.4)
  if (extFlags2 & 0x01) {
    const messageSequenceNumber = stream.readUInt16LE();
    const chunkOffset           = stream.readUInt32LE();
    const totalSize             = stream.readUInt32LE();
    const chunkDataLen          = stream.readUInt32LE();
    const chunkData             = Buffer.from(stream.readBytes(chunkDataLen));
    nm.chunk = { messageSequenceNumber, chunkOffset, totalSize, chunkData };
    nm.payload = []; // chunk has no DataSetMessages — body is the chunk struct
    return nm;
  }

  // Payload: read DataSetMessages
  nm.payload = [];
  const ids = nm.payloadHeader ? nm.payloadHeader.dataSetWriterIds : [];
  const count = ids.length;

  if (count > 1) {
    // Size array present (Part 14 §7.2.4.3): read count UInt16 sizes, then decode each DSM
    const sizes = [];
    for (let i = 0; i < count; i++) sizes.push(stream.readUInt16LE());
    for (let i = 0; i < count; i++) {
      const dsmBytes = Buffer.from(stream.readBytes(sizes[i]));
      nm.payload.push(decodeDataSetMessage(new BinaryStream(dsmBytes)));
    }
  } else if (count === 1) {
    // Single DataSetMessage — consumes stream to end
    if (stream.remaining > 0) {
      nm.payload.push(decodeDataSetMessage(stream));
    }
  } else {
    // No payloadHeader: attempt one DSM if bytes remain
    if (stream.remaining > 0) {
      nm.payload.push(decodeDataSetMessage(stream));
    }
  }

  return nm;
}

module.exports = {
  encodeNetworkMessage,
  decodeNetworkMessage,
  encodeDataSetMessage,
  decodeDataSetMessage,
};
