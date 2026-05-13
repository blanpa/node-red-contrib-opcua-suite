/**
 * UADP Reference Vector Capture Script
 *
 * Captures UADP binary packets from a running open62541 publisher and dumps
 * hex to stdout for pasting into test/fixtures/uadp-vectors.js.
 *
 * NOT picked up by `npm test` (does not end in .test.js — decision D-18).
 *
 * Setup:
 *   1. Pull the open62541 reference container (e.g., via Docker):
 *        docker pull open62541/open62541
 *   2. Start an open62541 publisher with UADP publishing enabled:
 *        docker run --rm --network=host open62541/open62541 \
 *          --pubsub-uadp --port=4840
 *   3. Run this script in a separate terminal:
 *        node test-server/capture-open62541-vectors.js
 *   4. Each captured packet prints as:
 *        // From <ip>:<port>  (<N> bytes)
 *        <space-separated hex bytes>
 *
 *        (blank line between packets)
 *   5. Copy the hex strings into test/fixtures/uadp-vectors.js, replacing the
 *      `hex: "..."` (encoder-self-output) entries and updating provenance to
 *      "open62541 v<version> captured <date>".
 *   6. Stop the script with Ctrl-C; the socket closes cleanly.
 *
 * Override the default port with the environment variable UADP_CAPTURE_PORT:
 *   UADP_CAPTURE_PORT=4841 node test-server/capture-open62541-vectors.js
 *
 * Phase 4 will use this script to upgrade fixture provenance from
 * "encoder self-output" to verified open62541 reference output.
 *
 * Security note (T-02-23): This script is a manual-run developer tool.
 * Only run it in test environments; never against a live PubSub network
 * containing sensitive data. Captured hex is written to stdout only.
 *
 * @see Part 14 §7.2.4 (UADP NetworkMessage encoding)
 * @see test/fixtures/uadp-vectors.js (fixture file to update with captured vectors)
 * @see RESEARCH.md §"open62541 Capture Script Pattern (D-18)"
 */

const dgram = require("dgram");

const DEFAULT_PORT = 4840;

/**
 * Formats a Buffer as a space-separated hex string (two hex chars per byte).
 * Output is suitable for pasting directly into test/fixtures/uadp-vectors.js.
 *
 * @param {Buffer} buf
 * @returns {string} e.g. "91 03 EF CD AB 90 78 56 34 12"
 */
function formatHex(buf) {
  return buf.toString("hex").toUpperCase().match(/.{2}/g).join(" ");
}

/**
 * Main capture loop: bind a UDP socket on the configured port and print
 * each received packet as a hex-annotated comment block.
 *
 * Exit via Ctrl-C (SIGINT); the socket is closed cleanly before exit.
 */
function main() {
  const port = Number(process.env.UADP_CAPTURE_PORT) || DEFAULT_PORT;

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

  sock.on("message", (msg, rinfo) => {
    console.log(`// From ${rinfo.address}:${rinfo.port}  (${msg.length} bytes)`);
    console.log(formatHex(msg));
    console.log(""); // blank line between packets for readability
  });

  sock.on("error", (err) => {
    // T-02-21 mitigation: log error and exit with code 1 so the developer sees it
    console.error(`Capture socket error: ${err.message}`);
    sock.close(() => process.exit(1));
  });

  sock.on("listening", () => {
    const addr = sock.address();
    console.error(`Listening on UDP ${addr.address}:${addr.port} ...`);
    console.error("Press Ctrl-C to stop capture.");
    console.error("Capturing UADP packets — paste output into test/fixtures/uadp-vectors.js");
    console.error("");
  });

  process.on("SIGINT", () => {
    console.error("\nStopping capture; closing socket.");
    sock.close(() => process.exit(0));
  });

  sock.bind(port);
}

// Entry-point guard per D-18: main() is only invoked when run directly,
// NOT when require()'d by test files or other scripts.
if (require.main === module) main();

module.exports = { main, formatHex };
