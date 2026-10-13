/**
 * UadpReassembler — reassembles UADP chunk NetworkMessages (Part 14 §7.2.4.4.4)
 *
 * Shared by the UDP transport (which reassembles before emitting 'message') and
 * the subscriber for UADP over MQTT. The MQTT transport also carries JSON and
 * cannot tell the encodings apart, so its UADP chunks are reassembled at the
 * subscriber that knows it decodes UADP.
 *
 * Chunks are keyed by publisherId|writerGroupId|messageSequenceNumber. The
 * encoder chunks the FULL encoded NetworkMessage (CR-01), so a completed
 * reassembly is a buffer that decodeNetworkMessage decodes directly.
 *
 * Security posture (attacker-controlled input):
 *   - T-03-05: in-flight reassemblies are bounded to MAX_INFLIGHT_REASSEMBLIES
 *     (drop-oldest + warning), and entries older than REASSEMBLY_EXPIRY_MS are
 *     swept on every push.
 *   - ME-04: a declared totalSize above `maxTotalSize` is rejected, and the
 *     chunks must tile [0, totalSize) exactly before they are concatenated.
 *
 * Node-RED-free: warnings go to the `onWarn` callback as createError objects.
 */

"use strict";

const { createError } = require("./opcua-utils");

// Maximum number of in-flight chunk reassemblies (T-03-05 DoS guard).
const MAX_INFLIGHT_REASSEMBLIES = 1000;

// How long an incomplete reassembly may live before it is swept (ms).
const REASSEMBLY_EXPIRY_MS = 30000;

class UadpReassembler {
  /**
   * @param {object} opts
   * @param {number} opts.maxTotalSize - Largest totalSize a chunk may declare.
   * @param {string} [opts.prefix] - Error-code prefix, e.g. "UDP" → UDP_REASSEMBLY_*.
   * @param {function(Error)} [opts.onWarn] - Receives dropped-chunk warnings.
   */
  constructor(opts) {
    this.maxTotalSize = opts.maxTotalSize;
    this.prefix = opts.prefix || "UADP";
    this.onWarn = opts.onWarn || function () {};
    this.entries = new Map(); // key -> { totalSize, parts: Map<offset, Buffer>, expiresAt }
  }

  _warn(code, text) {
    this.onWarn(createError(`${this.prefix}_${code}: ${text}`));
  }

  /**
   * Records one decoded chunk NetworkMessage.
   * @param {object} partial - decodeNetworkMessage() result with `partial.chunk`.
   * @returns {Buffer|null} The complete NetworkMessage buffer once every chunk
   *   has arrived, otherwise null (also when the chunk was rejected).
   */
  push(partial) {
    const writerGroupId = partial.groupHeader
      ? partial.groupHeader.writerGroupId
      : undefined;
    const key = `${partial.publisherId}|${writerGroupId}|${partial.chunk.messageSequenceNumber}`;

    // ME-04: reject an attacker-declared totalSize beyond a sane cap before it
    // can steer reassembly.
    const totalSize = partial.chunk.totalSize;
    if (
      !Number.isInteger(totalSize) ||
      totalSize < 0 ||
      totalSize > this.maxTotalSize
    ) {
      this._warn(
        "REASSEMBLY_TOTALSIZE",
        `rejected totalSize ${totalSize} (cap ${this.maxTotalSize}) for key ${key}`,
      );
      return null;
    }

    // Sweep expired (REASSEMBLY_EXPIRY_MS) on every push (T-03-05).
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) this.entries.delete(k);
    }

    // Overflow guard (T-03-05): bound in-flight reassemblies, drop oldest first.
    if (
      !this.entries.has(key) &&
      this.entries.size >= MAX_INFLIGHT_REASSEMBLIES
    ) {
      const oldestKey = this.entries.keys().next().value; // Map insertion order
      this.entries.delete(oldestKey);
      this._warn("REASSEMBLY_OVERFLOW", `dropped oldest key ${oldestKey}`);
    }

    // ME-04: reject a chunk whose offset/length is non-integral or whose end
    // exceeds the declared totalSize — it can never be part of a valid tiling.
    const chunkOffset = partial.chunk.chunkOffset;
    const chunkData = partial.chunk.chunkData;
    if (
      !Number.isInteger(chunkOffset) ||
      chunkOffset < 0 ||
      !Buffer.isBuffer(chunkData) ||
      chunkOffset + chunkData.length > totalSize
    ) {
      this._warn(
        "REASSEMBLY_BAD_TILING",
        `chunk offset ${chunkOffset}/len ${chunkData && chunkData.length} exceeds totalSize ${totalSize} for key ${key}`,
      );
      return null;
    }

    // Record this chunk (parts keyed by offset so duplicates overwrite, not
    // double-count).
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        totalSize: totalSize,
        parts: new Map(),
        expiresAt: now + REASSEMBLY_EXPIRY_MS,
      };
      this.entries.set(key, entry);
    }
    entry.parts.set(chunkOffset, chunkData);

    // Completeness: sum of distinct-offset chunk lengths reaching totalSize.
    let assembled = 0;
    for (const data of entry.parts.values()) assembled += data.length;
    if (assembled < entry.totalSize) return null; // wait for more chunks

    // ME-04: a sum-of-lengths threshold can be met by overlapping or gapped
    // chunks. Before concatenating, verify the chunks tile [0, totalSize)
    // EXACTLY — sorted by offset, each chunk must start where the previous
    // ended, with the last chunk ending precisely at totalSize.
    const sorted = [...entry.parts.entries()].sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    let tilingOk = true;
    for (const [offset, data] of sorted) {
      if (offset !== cursor) {
        tilingOk = false;
        break;
      } // gap or overlap
      cursor += data.length;
    }
    this.entries.delete(key);
    if (!tilingOk || cursor !== entry.totalSize) {
      this._warn(
        "REASSEMBLY_BAD_TILING",
        `chunks for key ${key} do not tile [0, ${entry.totalSize}) exactly`,
      );
      return null;
    }

    // Complete — concatenate parts in ascending chunkOffset order.
    return Buffer.concat(sorted.map(([, d]) => d));
  }

  clear() {
    this.entries.clear();
  }
}

module.exports = {
  UadpReassembler,
  MAX_INFLIGHT_REASSEMBLIES,
  REASSEMBLY_EXPIRY_MS,
};
