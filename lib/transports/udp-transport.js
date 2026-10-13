/**
 * UdpTransport — UDP-UADP Multicast Transport Adapter
 *
 * Concrete BaseTransport subclass (Plan 03-02, TRP-01) that carries OPC UA
 * PubSub NetworkMessages over UDP multicast in UADP binary format.
 *
 * Lifecycle (PITFALLS.md §4, §5, §10 + 03-RESEARCH.md Pattern 2):
 *   - connect(): creates a `udp4` dgram socket with `reuseAddr: true`, binds to
 *     `0.0.0.0:${port}` (NEVER to a NIC IP nor the multicast group), then calls
 *     `addMembership` INSIDE the bind callback (membership before bind throws on
 *     some platforms). Emits 'connected' and resolves once bind completes.
 *   - close(): nulls `_socket` first (idempotent guard) then `socket.close(done)`
 *     — the one-arg callback form so the returned Promise resolves only after the
 *     OS has torn the socket down. Emits 'disconnected'. This is what lets the
 *     20-cycle rapid bind/close acceptance test pass with zero EADDRINUSE.
 *   - send(payload): Buffer | Buffer[] dispatched via Array.isArray (D-02); one
 *     dgram packet per buffer. dgram send errors are emitted as 'error', never thrown.
 *
 * Receive path (Task 2): `_onDatagram` decodes each datagram, passes single-buffer
 * NetworkMessages straight through as 'message', and reassembles chunked messages
 * keyed by publisherId|writerGroupId|messageSequenceNumber with a 30s expiry sweep
 * and a 1000-entry drop-oldest overflow guard (T-03-05). Decode errors are caught
 * and emitted as 'error' so a malformed datagram cannot crash the listener (T-03-01).
 *
 * Config (shape consumed by the Connection-Node in Plan 03-04):
 *   { port: Number, multicastGroup: String, multicastInterface?: String, mtu?: Number }
 *
 * Node-RED-free (D-07): depends only on `dgram`, BaseTransport, opcua-utils, and
 * the UADP encoder. No `RED` references — fully testable with dgram + sinon.
 *
 * Exports:
 *   UdpTransport   -> class extends BaseTransport (named export)
 */

"use strict";

const dgram = require("dgram");
const { BaseTransport } = require("./base-transport");
const { createError } = require("../opcua-utils");
// Referenced via the module object (not destructured) so tests can stub
// `uadp.decodeNetworkMessage` and the running code observes the stub.
const uadp = require("../uadp-encoder");
const { UadpReassembler } = require("../uadp-reassembler");

// Maximum number of chunks a single reassembled NetworkMessage may span (ME-04).
// Caps the attacker-declared totalSize at MAX_CHUNKS * mtu so a single datagram
// cannot reserve an arbitrarily large buffer / completeness target.
const MAX_CHUNKS = 256;

class UdpTransport extends BaseTransport {
  /**
   * @param {object} config
   * @param {number} config.port - UDP port to bind/send on.
   * @param {string} config.multicastGroup - Multicast group address (e.g. "239.0.0.1").
   * @param {string} [config.multicastInterface] - NIC IP to join on / send from; default "0.0.0.0".
   * @param {number} [config.mtu] - Informational; chunking happens in the encoder (Phase 2).
   */
  constructor(config) {
    super(config);
    this._socket = null;
    // mtu is informational for sending; here it bounds reassembly (ME-04).
    const mtu =
      this.config && typeof this.config.mtu === "number"
        ? this.config.mtu
        : 1400;
    this._reassembler = new UadpReassembler({
      maxTotalSize: mtu * MAX_CHUNKS,
      prefix: "UDP",
      onWarn: (e) => this.emit("warn", e),
    });
    this._chunks = this._reassembler.entries; // key -> { totalSize, parts, expiresAt }
  }

  /**
   * Binds the dgram socket and joins the multicast group.
   * @returns {Promise<void>} Resolves once 'connected' has been emitted.
   */
  async connect() {
    if (this._socket) return; // idempotent guard
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this._socket = socket;

      socket.on("error", (err) => {
        this.emit("error", createError(`UDP_SOCKET_ERROR: ${err.message}`));
      });
      socket.on("message", (buf, rinfo) => this._onDatagram(buf, rinfo));

      // Bind to 0.0.0.0 — NEVER to a NIC IP nor the multicast group (PITFALLS.md §4).
      socket.bind({ port: this.config.port, address: "0.0.0.0" }, () => {
        try {
          // addMembership MUST run inside the bind callback (PITFALLS.md §4, Pitfall 2).
          socket.addMembership(
            this.config.multicastGroup,
            this.config.multicastInterface || "0.0.0.0",
          );
          // LO-04: loopback is enabled INTENTIONALLY so a publisher and a
          // subscriber co-located on the SAME connection/host still receive each
          // other's multicast frames (required by the loopback example).
          socket.setMulticastLoopback(true);
          socket.setMulticastTTL(128);
          // setMulticastInterface governs the OUTGOING NIC for send(); only pin it
          // when an explicit interface IP was supplied (let the OS pick otherwise).
          if (
            this.config.multicastInterface &&
            this.config.multicastInterface !== "0.0.0.0"
          ) {
            socket.setMulticastInterface(this.config.multicastInterface);
          }
          this.emit("connected");
          resolve();
        } catch (err) {
          reject(createError(`UDP_BIND_FAILED: ${err.message}`));
        }
      });
    });
  }

  /**
   * Closes the socket. Idempotent — a second call resolves immediately.
   * @returns {Promise<void>} Resolves after the OS close callback fires.
   */
  async close() {
    return new Promise((resolve) => {
      if (!this._socket) return resolve();
      const sock = this._socket;
      this._socket = null; // null first so a concurrent close() is a no-op
      sock.close(() => {
        this.emit("disconnected");
        resolve();
      });
    });
  }

  /**
   * Sends one or more UADP buffers via multicast. Never throws — dgram send
   * failures are surfaced as 'error' events (D-02 + BaseTransport contract).
   * @param {Buffer|Buffer[]} payload - Single buffer or array of chunk buffers.
   * @param {object} [opts] - Reserved (ignored by UDP).
   * @returns {void}
   */
  send(payload, _opts) {
    if (!this._socket) {
      this.emit("error", createError("UDP_SEND_NOT_CONNECTED: socket is null"));
      return;
    }
    const chunks = Array.isArray(payload) ? payload : [payload];
    for (const chunk of chunks) {
      this._socket.send(
        chunk,
        this.config.port,
        this.config.multicastGroup,
        (err) => {
          if (err)
            this.emit("error", createError(`UDP_SEND_ERROR: ${err.message}`));
        },
      );
    }
  }

  /**
   * Inbound datagram handler. Decodes each datagram; single-buffer messages are
   * passed straight through, chunked messages are accumulated and reassembled.
   *
   * Security posture:
   *   - T-03-01: `decodeNetworkMessage` is wrapped in try/catch — a malformed
   *     datagram emits 'error' (UDP_DECODE_ERROR) and returns, never tearing down
   *     the dgram listener.
   *   - T-03-05: in-flight reassemblies are bounded to MAX_INFLIGHT_REASSEMBLIES
   *     (drop-oldest + 'warn' event), and stale entries past REASSEMBLY_EXPIRY_MS
   *     are swept on every receive — both defend against attacker-controlled
   *     unbounded memory growth.
   *
   * @param {Buffer} buf - Raw datagram bytes.
   * @param {object} rinfo - dgram remote-address info.
   */
  _onDatagram(buf, rinfo) {
    let partial;
    try {
      partial = uadp.decodeNetworkMessage(buf);
    } catch (err) {
      // T-03-01: malformed datagram — surface and keep the listener alive.
      this.emit("error", createError(`UDP_DECODE_ERROR: ${err.message}`));
      return;
    }

    // Single-buffer NetworkMessage (no chunk struct) — pass through directly.
    if (!partial || !partial.chunk) {
      this.emit("message", buf, { rinfo });
      return;
    }

    // Chunked message — reassemble (bounds and tiling checks live in
    // lib/uadp-reassembler.js).
    const complete = this._reassembler.push(partial);
    if (!complete) return;
    this.emit("message", complete, { rinfo });
  }
}

module.exports = { UdpTransport };
