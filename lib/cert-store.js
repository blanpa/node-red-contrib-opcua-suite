/**
 * Certificate Store
 *
 * Pure-function helpers and an Express-route factory for OPC UA certificate
 * management. Designed for reuse: no dependency on any other lib/ module so it
 * can be required by any Node-RED config node (today: opcua-endpoint, tomorrow:
 * opcua-pubsub-connection) under any URL prefix.
 *
 * Exports:
 *   sanitiseFilename(name)                 -> string   (path-traversal safe)
 *   getCertsDir(RED)                       -> string   (idempotent mkdir)
 *   listCerts(certsDir)                    -> Promise<string[]>
 *   uploadCert(certsDir, filename, base64) -> Promise<{path, bytes}>
 *   deleteCert(certsDir, filename)         -> Promise<void>
 *   registerCertRoutes(RED, prefix, dir)   -> void
 *
 * Error shape (registerCertRoutes responses): { error: <string> }
 *   400  missing fields, invalid filename
 *   404  file not found (delete only)
 *   500  filesystem error
 */

"use strict";

const fs = require("fs");
const path = require("path");

const FILENAME_REGEX = /[^a-zA-Z0-9._-]/g;
const ALLOWED_EXT_REGEX = /\.(pem|der|crt|key|pfx|p12)$/i;

/**
 * Replaces every character outside [a-zA-Z0-9._-] with an underscore.
 * Mirrors the existing inline regex in nodes/opcua-endpoint.js so behaviour
 * is bit-for-bit identical post-refactor.
 */
function sanitiseFilename(name) {
  const safe = String(name || "cert.pem").replace(FILENAME_REGEX, "_");
  // "/" and "\\" are already replaced above, so this cannot escape the certs
  // directory — but a bare ".." or "." still resolves to a DIRECTORY inside
  // path.join(). Normalise those away so callers always get a real file name.
  if (safe === "." || safe === ".." || safe === "") return "cert.pem";
  return safe;
}

/**
 * Returns the canonical certs directory under RED.settings.userDir
 * (or '/data' as fallback). Creates the directory if it does not exist;
 * mkdir errors are swallowed so callers in test environments without a
 * writable userDir still get a usable path string.
 */
function getCertsDir(RED) {
  const userDir = (RED && RED.settings && RED.settings.userDir) || "/data";
  const dir = path.join(userDir, "opcua-certs");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      /* ignore — read-only test environments, etc. */
    }
  }
  return dir;
}

/**
 * Lists certificate files in `certsDir` whose extension is in the whitelist
 * (.pem, .der, .crt, .key, .pfx, .p12). Returns [] when the directory does
 * not exist or cannot be read.
 */
async function listCerts(certsDir) {
  try {
    const entries = fs.readdirSync(certsDir);
    return entries.filter(function (f) {
      return ALLOWED_EXT_REGEX.test(f);
    });
  } catch (e) {
    return [];
  }
}

/**
 * Decodes base64 content and writes it to `<certsDir>/<sanitised filename>`.
 * Throws { status: 400, message } when base64Content is falsy.
 * Throws { status: 500, message } on filesystem errors.
 */
async function uploadCert(certsDir, filename, base64Content) {
  if (!base64Content) {
    const err = new Error("Missing content");
    err.status = 400;
    throw err;
  }
  const safeName = sanitiseFilename(filename);
  // listCerts() only ever shows whitelisted extensions, so anything else was
  // written but invisible. Reject it up front instead.
  if (!ALLOWED_EXT_REGEX.test(safeName)) {
    const err = new Error(
      "Unsupported certificate file type (allowed: .pem, .der, .crt, .key, .pfx, .p12)",
    );
    err.status = 400;
    throw err;
  }
  const destPath = path.join(certsDir, safeName);
  const buf = Buffer.from(base64Content, "base64");
  try {
    fs.writeFileSync(destPath, buf);
  } catch (e) {
    const err = new Error(e.message);
    err.status = 500;
    throw err;
  }
  return { path: destPath, bytes: buf.length };
}

/**
 * Deletes `<certsDir>/<sanitised filename>`.
 * Throws { status: 404 } when the file does not exist.
 * Throws { status: 500 } on filesystem errors.
 */
async function deleteCert(certsDir, filename) {
  const safeName = sanitiseFilename(filename);
  const filePath = path.join(certsDir, safeName);
  if (!fs.existsSync(filePath)) {
    const err = new Error("File not found");
    err.status = 404;
    throw err;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    const err = new Error(e.message);
    err.status = 500;
    throw err;
  }
}

/**
 * Returns an Express middleware enforcing the given Node-RED admin permission,
 * or a pass-through when RED.auth is unavailable (test harnesses, very old
 * Node-RED). Without this every route below was reachable unauthenticated even
 * with `adminAuth` configured — these routes write, list and delete files under
 * the user directory and open OPC UA connections, so they must sit behind the
 * same permission as editing the flows that use them.
 */
function permission(RED, scope) {
  if (RED && RED.auth && typeof RED.auth.needsPermission === "function") {
    return RED.auth.needsPermission(scope);
  }
  return function (req, res, next) {
    next();
  };
}

/**
 * Registers POST/GET/DELETE certificate routes against RED.httpAdmin under
 * the supplied prefix. Returns immediately (no-op) when RED or RED.httpAdmin
 * is missing — matches the existing test-environment guard pattern.
 *
 * All routes require the "flows.write" admin permission.
 *
 * Routes:
 *   POST   <prefix>/upload-cert            body: { filename, content (base64) }
 *   GET    <prefix>/certs                  -> [{ name, path }]
 *   DELETE <prefix>/upload-cert/:filename
 */
function registerCertRoutes(RED, prefix, certsDir) {
  if (!RED || !RED.httpAdmin) {
    return;
  }

  const needsWrite = permission(RED, "flows.write");
  const needsRead = permission(RED, "flows.read");

  RED.httpAdmin.post(
    prefix + "/upload-cert",
    needsWrite,
    async function (req, res) {
      try {
        const data = req.body || {};
        const result = await uploadCert(certsDir, data.filename, data.content);
        res.json({
          success: true,
          path: result.path,
          filename: path.basename(result.path),
          size: result.bytes,
        });
      } catch (e) {
        const status = e.status || 400;
        res.status(status).json({ success: false, error: e.message });
      }
    },
  );

  RED.httpAdmin.get(prefix + "/certs", needsRead, async function (req, res) {
    try {
      const files = await listCerts(certsDir);
      res.json(
        files.map(function (f) {
          return { name: f, path: path.join(certsDir, f) };
        }),
      );
    } catch (e) {
      res.json([]);
    }
  });

  RED.httpAdmin.delete(
    prefix + "/upload-cert/:filename",
    needsWrite,
    async function (req, res) {
      try {
        await deleteCert(certsDir, req.params && req.params.filename);
        res.json({ success: true });
      } catch (e) {
        const status = e.status || 500;
        res.status(status).json({ success: false, error: e.message });
      }
    },
  );
}

module.exports = {
  sanitiseFilename,
  getCertsDir,
  listCerts,
  uploadCert,
  deleteCert,
  registerCertRoutes,
};
