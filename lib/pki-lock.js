"use strict";

/**
 * Serialises node-opcua certificate initialisation within the process.
 *
 * Every OPCUAServer and OPCUAClient without its own certificate uses
 * node-opcua's default PKI folder. The certificate manager's initialize()
 * returns immediately while another caller is still creating the key pair,
 * so a second server or client starting in that window reads a private key
 * that is not on disk yet and fails with "Cannot find private key". On a
 * fresh Node-RED user directory this hit any flow with two opcua-server
 * nodes, or a server and a connecting client, on its very first deploy.
 *
 * Running these steps one after another closes the window. Once the files
 * exist each step takes a few milliseconds, so the queue costs nothing
 * noticeable afterwards.
 */

let tail = Promise.resolve();

/**
 * Runs `task` after every task queued before it has settled.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withPkiLock(task) {
  const run = tail.then(() => task());
  tail = run.catch(() => {});
  return run;
}

/**
 * Prepares a node-opcua client's certificate under the lock, so that its
 * connect() finds the key pair in place. Clients without initializeCM()
 * (other node-opcua versions, test doubles) are left alone.
 * @param {object} client
 */
function prepareClientCertificate(client) {
  if (!client || typeof client.initializeCM !== "function") {
    return Promise.resolve();
  }
  return withPkiLock(() => client.initializeCM());
}

module.exports = { withPkiLock, prepareClientCertificate };
