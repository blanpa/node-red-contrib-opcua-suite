"use strict";

/**
 * Minimal Node-RED runtime for integration tests that run the real node
 * implementations (endpoint, client, …) against a real in-process OPC UA
 * server. Each node records its sends and its latest status.
 */

const path = require("path");

function createRED() {
  const types = {};
  const nodes = {};
  return {
    nodes: {
      createNode(node, config) {
        Object.assign(node, config);
        node._events = {};
        node.on = (event, cb) =>
          (node._events[event] = node._events[event] || []).push(cb);
        node.status = (s) => {
          node._status = s;
        };
        node.log = () => {};
        node.warn = () => {};
        node.error = () => {};
        node.sent = [];
        node.send = (msg) => node.sent.push(msg);
      },
      registerType(name, ctor) {
        types[name] = ctor;
      },
      getNode: (id) => nodes[id],
    },
    _types: types,
    _nodes: nodes,
  };
}

function loadNode(RED, file) {
  const p = path.resolve(__dirname, "..", "..", "nodes", file);
  delete require.cache[require.resolve(p)];
  require(p)(RED);
}

/** Instantiates a registered node type and makes it findable by id. */
function makeNode(RED, type, config, credentials) {
  const node = {};
  if (credentials) node.credentials = credentials;
  RED._types[type].call(node, config);
  if (!node.credentials) node.credentials = {};
  RED._nodes[config.id] = node;
  return node;
}

/** Runs a node's close handlers the way Node-RED does on redeploy. */
async function closeNode(node) {
  for (const cb of node._events.close || []) {
    await new Promise((resolve) => {
      if (cb.length >= 2) cb.call(node, false, resolve);
      else if (cb.length === 1) cb.call(node, resolve);
      else Promise.resolve(cb.call(node)).then(resolve, resolve);
    });
  }
}

/** Delivers a message to a node's input handler; resolves on done(). */
function input(node, msg) {
  return new Promise((resolve) =>
    node._events.input[0](
      msg,
      (m) => node.sent.push(m),
      () => resolve(),
    ),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

module.exports = {
  createRED,
  loadNode,
  makeNode,
  closeNode,
  input,
  sleep,
  waitFor,
};
