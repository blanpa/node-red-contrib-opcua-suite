"use strict";

/**
 * Child process for test/pki-lock.test.js. Starts two opcua-server nodes at
 * the same moment. The caller points XDG_CONFIG_HOME at an empty directory,
 * so node-opcua has to create its default certificate during this run.
 * Prints one JSON line: { started: [bool, bool], errors: [string] }.
 */

const path = require("path");

const ports = process.argv.slice(2).map(Number);
const errors = [];

function createRED() {
  const types = {};
  return {
    nodes: {
      createNode(node, config) {
        Object.assign(node, config);
        node._events = {};
        node.on = (event, cb) =>
          (node._events[event] = node._events[event] || []).push(cb);
        node.status = () => {};
        node.log = () => {};
        node.warn = () => {};
        node.error = (msg) => errors.push(String(msg));
      },
      registerType(name, ctor) {
        types[name] = ctor;
      },
      getNode: () => null,
    },
    _types: types,
  };
}

async function main() {
  const RED = createRED();
  require(path.resolve(__dirname, "..", "..", "nodes", "opcua-server.js"))(RED);
  const nodes = ports.map((port, i) => {
    const node = {};
    RED._types["opcua-server"].call(node, { port, serverName: `PKI${i}` });
    return node;
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (nodes.every((n) => n.server) || errors.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // Give a failing sibling time to report.
  await new Promise((r) => setTimeout(r, 500));

  const started = nodes.map((n) => !!n.server);
  for (const n of nodes) {
    for (const cb of n._events.close || []) {
      await new Promise((resolve) => cb(false, resolve));
    }
  }
  process.stdout.write(JSON.stringify({ started, errors }) + "\n");
  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(
    JSON.stringify({ started: [], errors: [String(e && e.stack)] }) + "\n",
  );
  process.exit(0);
});
