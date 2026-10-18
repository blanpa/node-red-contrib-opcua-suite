#!/usr/bin/env node
"use strict";

/**
 * Runs the function test suite (examples/15 - Function Test Suite.json)
 * against a Node-RED instance and exits non-zero if any test fails.
 *
 *   1. waits until Node-RED answers on its admin API
 *   2. deploys the suite (full deploy, credentials included)
 *   3. waits for the run the deploy starts and polls
 *      GET /opcua-functest/results until it has finished
 *   4. prints one line per test and a summary
 *
 * Environment:
 *   NODE_RED_URL   default http://localhost:1880
 *   FLOW_FILE      default examples/15 - Function Test Suite.json
 *   NO_DEPLOY=1    use the deployed flow and only start a new run
 *   RUN_TIMEOUT_S  default 900
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const NODE_RED_URL = process.env.NODE_RED_URL || "http://localhost:1880";
const FLOW_FILE =
  process.env.FLOW_FILE ||
  path.join(__dirname, "..", "..", "examples", "15 - Function Test Suite.json");
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_S || 900) * 1000;

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, NODE_RED_URL);
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: Object.assign(
          { "Content-Type": "application/json" },
          data ? { "Content-Length": Buffer.byteLength(data) } : {},
          headers,
        ),
        timeout: 10000,
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (e) {
            json = null;
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForNodeRed() {
  const deadline = Date.now() + 120000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await request("GET", "/settings");
      if (res.status === 200) return res.json;
      last = "HTTP " + res.status;
    } catch (e) {
      last = e.message;
    }
    await sleep(1000);
  }
  throw new Error(`Node-RED not reachable at ${NODE_RED_URL} (${last})`);
}

async function results() {
  const res = await request("GET", "/opcua-functest/results");
  if (res.status !== 200 || !res.json) return null;
  return res.json;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  console.log(`Node-RED: ${NODE_RED_URL}`);
  const settings = await waitForNodeRed();
  console.log(`Node-RED ${settings && settings.version} is up`);

  const before = await results().catch(() => null);
  const previousRun = before && before.state ? before.state.runId : null;

  if (process.env.NO_DEPLOY === "1") {
    const res = await request("POST", "/inject/ft-start");
    if (res.status !== 200) throw new Error(`start failed: HTTP ${res.status}`);
    console.log("Started a new run of the deployed suite");
  } else {
    const flow = JSON.parse(fs.readFileSync(FLOW_FILE, "utf8"));
    const res = await request("POST", "/flows", flow, {
      "Node-RED-Deployment-Type": "full",
    });
    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`deploy failed: HTTP ${res.status} ${res.text}`);
    }
    console.log(`Deployed ${path.basename(FLOW_FILE)} (${flow.length} nodes)`);
  }

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let lastReported = 0;
  let data = null;
  for (;;) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the run");
    await sleep(1000);
    data = await results().catch(() => null);
    const st = data && data.state;
    if (!st || st.runId === previousRun) continue;
    const list = data.results || [];
    for (; lastReported < list.length; lastReported++) {
      const r = list[lastReported];
      const line = `${r.ok ? "PASS" : "FAIL"}  ${pad(r.id, 6)} ${pad(r.name, 62)} ${pad(r.durationMs + " ms", 9)}`;
      console.log(r.ok ? line : `${line}\n      ${r.detail}`);
    }
    if (!st.running && st.finishedAt) break;
  }

  const st = data.state;
  const failed = data.results.filter((r) => !r.ok);
  console.log("");
  console.log(`${st.passed} passed, ${st.failed} failed, ${st.total} total`);
  if (failed.length) {
    console.log("Failed tests:");
    for (const r of failed) console.log(`  ${r.id} ${r.name}: ${r.detail}`);
  }
  process.exit(failed.length || st.passed !== st.total ? 1 : 0);
}

main().catch((e) => {
  console.error("ERROR: " + e.message);
  process.exit(2);
});
