/**
 * UADP Binary Encoder / Decoder
 *
 * Stateless pure functions for encoding and decoding OPC UA PubSub
 * NetworkMessages and DataSetMessages in UADP binary format per
 * OPC UA Part 14 v1.05 §7.2.4.
 *
 * All optional header fields (UADPFlags, ExtendedFlags1, ExtendedFlags2)
 * are derived from model field presence at encode time. Callers must NEVER
 * set flag bytes directly (Pitfall 1 mitigation, per D-09).
 *
 * Exports:
 *   encodeNetworkMessage(networkMessage, opts?)  -> Buffer
 *   decodeNetworkMessage(buffer, opts?)          -> NetworkMessage
 *   encodeDataSetMessage(dataSetMessage, opts?)  -> Buffer
 *   decodeDataSetMessage(buffer, opts?)          -> DataSetMessage
 *
 * `opts` is reserved for future extension (security, MTU). Unused in Phase 2 (D-04).
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

// ─── NetworkMessage Encode (Part 14 §7.2.4.2) ───

/**
 * Encodes an OPC UA PubSub NetworkMessage header to a binary Buffer.
 *
 * The three-level flag cascade (UADPFlags → ExtendedFlags1 → ExtendedFlags2) is
 * computed from model field presence — callers MUST NOT set flag bytes directly.
 * DataSetMessage payload encoding lands in plan 02.
 *
 * @param {object} networkMessage - Domain NetworkMessage model (see D-09 in 02-CONTEXT.md)
 * @param {object} [opts] - Reserved for future extension (security, MTU). Unused in Phase 2 (D-04).
 * @returns {Buffer} Wire-format UADP binary buffer
 */
function encodeNetworkMessage(networkMessage, _opts) {
  if (!networkMessage || typeof networkMessage !== "object") {
    throw createError("UADP_ENCODE_INVALID_INPUT: networkMessage must be an object");
  }

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

  // PublisherId (Part 14 §7.2.4.3.1 — only if UADPFlags bit 4 = 1)
  if (uadpFlags & 0x10) {
    // ExtFlags1 bits 0-2 carry the type; when ExtFlags1 is suppressed, type defaults to 000 (BYTE).
    const typeBits = (uadpFlags & 0x80) ? (extFlags1 & 0x07) : 0;
    _writePublisherId(stream, networkMessage.publisherId, typeBits);
  }

  // DataSetClassId GUID (Part 14 §7.2.4.3.2 — only if ExtFlags1 bit 3 = 1)
  if ((uadpFlags & 0x80) && (extFlags1 & 0x08)) {
    stream.writeGuid(networkMessage.dataSetClassId);
  }

  // GroupHeader (Part 14 §7.2.4.3.3 — only if UADPFlags bit 5 = 1)
  // Fields in order: WriterGroupId UInt16, GroupVersion UInt32,
  //                  NetworkMessageNumber UInt16, SequenceNumber UInt16
  if (uadpFlags & 0x20) {
    const gh = networkMessage.groupHeader;
    stream.writeUInt16LE(gh.writerGroupId);
    stream.writeUInt32LE(gh.groupVersion);
    stream.writeUInt16LE(gh.networkMessageNumber);
    stream.writeUInt16LE(gh.sequenceNumber);
  }

  // PayloadHeader (Part 14 §7.2.4.3.4 — only if UADPFlags bit 6 = 1)
  // Count UInt8, then Count × DataSetWriterId UInt16
  if (uadpFlags & 0x40) {
    const ids = networkMessage.payloadHeader.dataSetWriterIds;
    stream.writeUInt8(ids.length);
    for (const id of ids) stream.writeUInt16LE(id);
  }

  // ExtendedNetworkMessageHeader fields (Part 14 §7.2.4.2.3):
  // Timestamp (ExtFlags1 bit 5), PicoSeconds (ExtFlags1 bit 6),
  // PromotedFields (ExtFlags2 bit 1) — order per spec §7.2.4.2.3
  if ((uadpFlags & 0x80) && (extFlags1 & 0x20)) {
    stream.writeDateTime(networkMessage.timestamp);
  }
  if ((uadpFlags & 0x80) && (extFlags1 & 0x40)) {
    stream.writeUInt16LE(networkMessage.picoseconds);
  }

  // PromotedFields: deferred to plan 02 (requires Variant encoding). Throw if present.
  if ((uadpFlags & 0x80) && (extFlags1 & 0x80) && (extFlags2 & 0x02)) {
    throw createError("UADP_ENCODE_NOT_YET_IMPLEMENTED: promotedFields lands in plan 02 (requires Variant encoder)");
  }

  // SecurityHeader: Phase 2 always omitted (ExtFlags1 bit 4 always 0).

  // Payload (DataSetMessages): deferred to plan 02. Throw if non-empty.
  if (Array.isArray(networkMessage.payload) && networkMessage.payload.length > 0) {
    throw createError("UADP_ENCODE_NOT_YET_IMPLEMENTED: DataSetMessage payload encoding lands in plan 02");
  }

  // Return only the written portion (T-02-02 mitigation — never expose full pre-allocated slab)
  return stream.toBuffer();
}

// ─── NetworkMessage Decode (Part 14 §7.2.4.2) ───

/**
 * Decodes a UADP binary buffer into a domain NetworkMessage model.
 *
 * Reads gate bits before consuming each optional field. Throws a structured
 * createError on truncated or malformed input (T-02-01 mitigation, CWE-125).
 * The returned model never contains flag-byte fields — re-derived on next encode.
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
  if (extFlags1 & 0x20) nm.timestamp  = stream.readDateTime();
  if (extFlags1 & 0x40) nm.picoseconds = stream.readUInt16LE();

  // PromotedFields (ExtFlags2 bit 1): deferred to plan 02
  if (extFlags2 & 0x02) {
    throw createError("UADP_DECODE_NOT_YET_IMPLEMENTED: promotedFields decoding lands in plan 02");
  }

  // Chunk (ExtFlags2 bit 0): deferred to plan 02
  if (extFlags2 & 0x01) {
    throw createError("UADP_DECODE_NOT_YET_IMPLEMENTED: chunk decoding lands in plan 02");
  }

  // Payload: DataSetMessage encoding deferred to plan 02. For plan 01, always empty array.
  nm.payload = [];

  return nm;
}

// ─── DataSetMessage (stubs for plan 02) ─── (Part 14 §7.2.4.5)

/**
 * Encodes a DataSetMessage to a binary Buffer.
 * DataSetMessage encoding is deferred to plan 02.
 *
 * @param {object} _dsm - DataSetMessage domain model (see D-10 in 02-CONTEXT.md)
 * @param {object} [_opts] - Reserved for future extension. Unused in Phase 2 (D-04).
 * @returns {Buffer}
 */
function encodeDataSetMessage(_dsm, _opts) {
  throw createError("UADP_ENCODE_NOT_YET_IMPLEMENTED: encodeDataSetMessage lands in plan 02");
}

/**
 * Decodes a binary Buffer into a DataSetMessage domain model.
 * DataSetMessage decoding is deferred to plan 02.
 *
 * @param {Buffer} _buf - Wire-format binary buffer
 * @param {object} [_opts] - Reserved for future extension. Unused in Phase 2 (D-04).
 * @returns {object}
 */
function decodeDataSetMessage(_buf, _opts) {
  throw createError("UADP_DECODE_NOT_YET_IMPLEMENTED: decodeDataSetMessage lands in plan 02");
}

module.exports = {
  encodeNetworkMessage,
  decodeNetworkMessage,
  encodeDataSetMessage,
  decodeDataSetMessage,
};
