#!/usr/bin/env node
"use strict";

/**
 * Runs test/ui/editor-ui-suite.js in headless Chrome against a Node-RED
 * editor and exits non-zero if a test fails.
 *
 * The editor needs the function test flow (examples/15) deployed, because
 * several tests browse its endpoints. If it is missing, this script deploys
 * it first. The suite itself never deploys.
 *
 * Environment:
 *   NODE_RED_URL  default http://localhost:1882 (docker-compose.test.yml)
 *   CHROME_BIN    default: google-chrome, chromium, chromium-browser
 *   UI_FILTER     run only tests whose name contains this text
 *   UI_HEADFUL=1  show the browser window
 */

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const NODE_RED_URL = process.env.NODE_RED_URL || "http://localhost:1882";
const SUITE = path.join(__dirname, "editor-ui-suite.js");
const FLOW = path.join(
  __dirname,
  "..",
  "..",
  "examples",
  "15 - Function Test Suite.json",
);
const PORT = 9300 + Math.floor(Math.random() * 500);

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const bin of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    try {
      execFileSync("which", [bin], { stdio: "ignore" });
      return bin;
    } catch (e) {
      /* try the next one */
    }
  }
  throw new Error("No Chrome found; set CHROME_BIN");
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: Object.assign(
          { "Content-Type": "application/json" },
          data
            ? {
                "Content-Length": Buffer.byteLength(data),
                "Node-RED-Deployment-Type": "full",
              }
            : {},
        ),
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureFlowDeployed() {
  let res = null;
  for (let i = 0; i < 90; i++) {
    try {
      res = await request("GET", NODE_RED_URL + "/flows");
      if (res.status === 200) break;
    } catch (e) {
      /* Node-RED still starting */
    }
    await sleep(1000);
  }
  if (!res || res.status !== 200)
    throw new Error(`Node-RED not reachable at ${NODE_RED_URL}`);
  if (res.text.includes('"ft-ep"')) return;
  const flow = JSON.parse(fs.readFileSync(FLOW, "utf8"));
  const dep = await request("POST", NODE_RED_URL + "/flows", flow);
  if (dep.status !== 200 && dep.status !== 204)
    throw new Error("deploy failed: HTTP " + dep.status);
  console.log("Deployed the function test flow");
  await sleep(4000);
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
  }
  async evaluate(expression, timeoutMs) {
    const result = await Promise.race([
      this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      sleep(timeoutMs || 30000).then(() => {
        throw new Error("evaluate timed out");
      }),
    ]);
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return result.result.value;
  }
}

async function main() {
  await ensureFlowDeployed();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opcua-ui-"));
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1400,900",
    NODE_RED_URL + "/",
  ];
  if (process.env.UI_HEADFUL !== "1") args.unshift("--headless=new");
  const chrome = spawn(findChrome(), args, { stdio: "ignore" });

  let exitCode = 1;
  try {
    let pageWs;
    for (let i = 0; i < 100 && !pageWs; i++) {
      await sleep(200);
      try {
        const list = JSON.parse(
          (await request("GET", `http://127.0.0.1:${PORT}/json/list`)).text,
        );
        const page = list.find(
          (t) => t.type === "page" && t.url.startsWith(NODE_RED_URL),
        );
        if (page) pageWs = page.webSocketDebuggerUrl;
      } catch (e) {
        /* Chrome still starting */
      }
    }
    if (!pageWs) throw new Error("Chrome did not open the editor");

    const cdp = new Cdp(pageWs);
    await cdp.ready();

    // The page may still be loading or redirecting; retry until the editor
    // has loaded the package and the deployed flow.
    let loaded = false;
    for (let i = 0; i < 60 && !loaded; i++) {
      try {
        loaded = await cdp.evaluate(
          `document.readyState === "complete" && !!(window.RED && RED.nodes && RED.nodes.getType && RED.nodes.getType("opcua-client") && RED.nodes.node("ft-ep"))`,
          5000,
        );
      } catch (e) {
        /* execution context replaced by a navigation */
      }
      if (!loaded) await sleep(500);
    }
    if (!loaded) throw new Error("the editor did not load the flow");

    // Dismiss the first-run tour and notifications.
    await cdp.evaluate(
      `(async () => {
        for (let i = 0; i < 300; i++) {
          if (window.RED && RED.nodes && RED.nodes.getType && RED.nodes.getType("opcua-client") && RED.nodes.node("ft-ep")) break;
          await new Promise(r => setTimeout(r, 100));
        }
        await new Promise(r => setTimeout(r, 1500));
        try { RED.tourGuide && RED.tourGuide.close && RED.tourGuide.close(); } catch (e) {}
        $(".red-ui-notification button").filter((i, b) => /No,|Nein|do not/i.test(b.textContent)).click();
        $(".red-ui-tourGuide-popover .red-ui-tourGuide-popover-close, .red-ui-tourGuide-shade").click();
        return !!(window.RED && RED.nodes.node("ft-ep"));
      })()`,
      60000,
    );

    await cdp.evaluate(fs.readFileSync(SUITE, "utf8") + "\ntrue");
    const filter = JSON.stringify(process.env.UI_FILTER || "");
    const count = await cdp.evaluate(`OpcUaUiSuite.count()`);
    console.log(`Running ${count} UI tests against ${NODE_RED_URL}\n`);
    const results = await cdp.evaluate(
      `OpcUaUiSuite.run(${filter})`,
      15 * 60 * 1000,
    );

    for (const r of results) {
      console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.ms} ms)`);
      if (!r.ok) console.log(`      ${r.error}`);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`,
    );
    exitCode = failed.length ? 1 : 0;
    cdp.ws.close();
  } finally {
    chrome.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("ERROR: " + e.message);
  process.exit(2);
});
