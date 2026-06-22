#!/usr/bin/env node
/**
 * OPC UA Suite — Benchmark & Stress Test
 * =======================================
 * Drives the real OpcUaClientManager (the engine behind the opcua-client
 * node) against the bundled test server and reports throughput, latency
 * percentiles, and error counts for read / readMultiple / write / subscribe.
 *
 * Usage:
 *   node test-server/benchmark.js               # full suite, default load
 *   node test-server/benchmark.js --quick       # short run (CI-friendly)
 *   node test-server/benchmark.js --endpoint opc.tcp://host:4840/UA/TestServer
 *
 * Env knobs (all optional):
 *   BENCH_DURATION_MS   sustained-load window per phase   (default 5000)
 *   BENCH_CONCURRENCY   parallel in-flight ops            (default 50)
 *   BENCH_SUB_ITEMS     monitored items in subscribe test (default 200)
 *
 * The harness spawns the test server itself unless --no-spawn is given
 * (use --no-spawn to point at an already-running server via --endpoint).
 */

"use strict";

const path = require("path");
const { spawn } = require("child_process");
const { ClientMonitoredItem, AttributeIds } = require("node-opcua");
const OpcUaClientManager = require("../lib/opcua-client-manager");
const PooledClientManager = require("../lib/opcua-pool");

// ─── CLI / config ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const NO_SPAWN = args.includes("--no-spawn");
const epIdx = args.indexOf("--endpoint");
const ENDPOINT =
  epIdx !== -1 ? args[epIdx + 1] : "opc.tcp://localhost:4840/UA/TestServer";

const DURATION_MS = Number(process.env.BENCH_DURATION_MS) || (QUICK ? 1500 : 5000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY) || (QUICK ? 20 : 50);
const SUB_ITEMS = Number(process.env.BENCH_SUB_ITEMS) || (QUICK ? 50 : 200);
const POOL_SIZE = Number(process.env.BENCH_POOL_SIZE) || 1;

// Read targets — dynamic vars change every second, scalars are static.
const READ_NODES = [
  "ns=1;s=Dynamic.Sinus",
  "ns=1;s=Dynamic.Random",
  "ns=1;s=Dynamic.Ramp",
  "ns=1;s=Scalar.Double",
  "ns=1;s=Scalar.Int32",
  "ns=1;s=Scalar.Boolean",
  "ns=1;s=Scalar.String",
];
const WRITE_NODE = "ns=1;s=Writable.Temperature";

// ─── Tiny stats helpers ──────────────────────────────────────────────────
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.floor((p / 100) * sortedAsc.length),
  );
  return sortedAsc[idx];
}

function summarize(latencies, durationMs, errors) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    ops: n,
    errors,
    throughput: durationMs > 0 ? (n / durationMs) * 1000 : 0,
    mean: n ? sum / n : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: n ? sorted[n - 1] : 0,
  };
}

function fmt(n, d = 2) {
  return Number(n).toFixed(d);
}

function printRow(label, s) {
  const pass = s.errors === 0 ? "✓" : "✗";
  console.log(
    `  ${pass} ${label.padEnd(26)} ` +
      `${String(s.ops).padStart(7)} ops  ` +
      `${fmt(s.throughput, 0).padStart(7)} ops/s  ` +
      `p50=${fmt(s.p50).padStart(7)}ms  ` +
      `p95=${fmt(s.p95).padStart(7)}ms  ` +
      `p99=${fmt(s.p99).padStart(7)}ms  ` +
      `max=${fmt(s.max).padStart(7)}ms  ` +
      `err=${s.errors}`,
  );
}

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, float

// ─── Server lifecycle ────────────────────────────────────────────────────
function startTestServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, "server.js");
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const onData = (buf) => {
      const text = buf.toString();
      if (!settled && /gestartet|Total endpoints|Endpoint:/i.test(text)) {
        settled = true;
        // Give the listener a beat to fully bind.
        setTimeout(() => resolve(child), 500);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (b) => {
      if (/Fehler beim Starten|EADDRINUSE/.test(b.toString())) {
        if (!settled) {
          settled = true;
          reject(new Error("Server failed to start: " + b.toString()));
        }
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error("Server exited early, code " + code));
      }
    });
    // Safety timeout — server should be up well within 15s.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(child); // assume up; connect() will fail loudly otherwise
      }
    }, 15000);
  });
}

// ─── Load drivers ────────────────────────────────────────────────────────

/**
 * Run `op` (async fn returning a value) with fixed concurrency for
 * durationMs, recording per-call latency and error count.
 */
async function runLoad(op, durationMs, concurrency) {
  const latencies = [];
  let errors = 0;
  const deadline = now() + durationMs;
  let i = 0;

  async function worker() {
    while (now() < deadline) {
      const t0 = now();
      try {
        await op(i++);
        latencies.push(now() - t0);
      } catch (e) {
        errors++;
      }
    }
  }

  const t0 = now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = now() - t0;
  return summarize(latencies, elapsed, errors);
}

/**
 * read() wrapped with the same BOUNDED connection-lost retry the opcua-client
 * node uses (initial attempt + maxRetries reconnect+retry cycles with
 * exponential backoff). Mirrors nodes/opcua-client.js so the reconnect phase
 * measures real end-to-end recoverability of the suite.
 */
const OP_MAX_RETRIES = 3;
const OP_BACKOFF_MS = 100;
async function readWithRetry(mgr, nodeId) {
  let attempt = 0;
  for (;;) {
    try {
      return await mgr.read(nodeId);
    } catch (err) {
      if (!mgr._isConnectionLostError(err) || attempt >= OP_MAX_RETRIES) {
        throw err;
      }
      attempt++;
      try {
        await mgr.reconnect({ reason: "bench-session-lost", maxAttempts: 3 });
      } catch (_) {
        if (attempt >= OP_MAX_RETRIES) throw err;
      }
      const backoff = Math.min(OP_BACKOFF_MS * 2 ** (attempt - 1), 2000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

// ─── Connect / disconnect churn ────────────────────────────────────────────
/**
 * Full channel+session lifecycle stress: connect -> 1 read -> disconnect,
 * repeated `cycles` times. Surfaces socket/handle leaks and slow teardown.
 */
async function connectChurn(makeMgr, cycles) {
  const latencies = [];
  let errors = 0;
  for (let i = 0; i < cycles; i++) {
    const mgr = makeMgr();
    const t0 = now();
    try {
      await mgr.connect();
      await mgr.read(READ_NODES[i % READ_NODES.length]);
      await mgr.disconnect();
      latencies.push(now() - t0);
    } catch (e) {
      errors++;
      try {
        await mgr.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    cycles,
    errors,
    mean: sorted.length ? sum / sorted.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

// ─── Reconnect under load ──────────────────────────────────────────────────
/**
 * Run a read-load (with node-style retry) while forcing session loss every
 * `intervalMs` by closing the live session out from under the operations.
 * Verifies reads recover cleanly mid-stream.
 */
async function reconnectUnderLoad(mgr, durationMs, concurrency, intervalMs) {
  let forcedDrops = 0;
  const deadline = now() + durationMs;

  // Pool members each own a session; a plain manager owns one directly.
  const targets = mgr.members || [mgr];
  const chaos = setInterval(async () => {
    if (now() >= deadline) return;
    forcedDrops++;
    // Close the session(s) underneath in-flight ops -> next read throws a
    // connection-lost error, which readWithRetry must recover from.
    for (const t of targets) {
      try {
        if (t.session) {
          await t.session.close();
          t.isConnected = false;
        }
      } catch (_) {
        /* ignore */
      }
    }
  }, intervalMs);

  const stats = await runLoad(
    (i) => readWithRetry(mgr, READ_NODES[i % READ_NODES.length]),
    durationMs,
    concurrency,
  );
  clearInterval(chaos);

  // Ensure we end connected for any later phases / clean shutdown.
  if (!mgr.isConnected) {
    try {
      await mgr.reconnect({ reason: "bench-final", maxAttempts: 3 });
    } catch (_) {
      /* ignore */
    }
  }
  const attempted = stats.ops + stats.errors;
  const recoveryRate = attempted ? (stats.ops / attempted) * 100 : 100;
  return {
    ...stats,
    forcedDrops,
    recoveryRate,
    endedConnected: mgr.isConnected,
  };
}

// ─── Subscribe stress ─────────────────────────────────────────────────────
/**
 * Create one subscription with `count` monitored items on the fastest
 * dynamic node, run for durationMs, and count delivered notifications +
 * any errors. Verifies "clean subscribe" under load.
 */
async function subscribeStress(mgr, count, durationMs) {
  const subscription = await mgr.createSubscription({
    interval: 100,
    maxNotificationsPerPublish: 1000,
  });

  let notifications = 0;
  let itemErrors = 0;
  const items = [];

  for (let k = 0; k < count; k++) {
    const nodeIdStr = READ_NODES[k % READ_NODES.length];
    const opcuaNodeId = mgr._toOpcUaNodeId(nodeIdStr);
    const item = ClientMonitoredItem.create(
      subscription,
      { nodeId: opcuaNodeId, attributeId: AttributeIds.Value },
      { samplingInterval: 100, discardOldest: true, queueSize: 10 },
    );
    item.on("changed", () => {
      notifications++;
    });
    item.on("err", () => {
      itemErrors++;
    });
    items.push(item);
  }

  const t0 = now();
  await new Promise((r) => setTimeout(r, durationMs));
  const elapsed = now() - t0;

  // Clean teardown — part of the "sauber" requirement.
  let teardownErrors = 0;
  for (const item of items) {
    try {
      await item.terminate();
    } catch (e) {
      teardownErrors++;
    }
  }
  try {
    await subscription.terminate();
  } catch (e) {
    teardownErrors++;
  }

  return {
    items: count,
    notifications,
    notifRate: (notifications / elapsed) * 1000,
    itemErrors,
    teardownErrors,
    elapsed,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         OPC UA Suite — Benchmark & Stress Test           ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Endpoint     : ${ENDPOINT}`);
  console.log(`  Mode         : ${QUICK ? "quick" : "full"}`);
  console.log(`  Duration/ph. : ${DURATION_MS} ms`);
  console.log(`  Concurrency  : ${CONCURRENCY}`);
  console.log(`  Sub. items   : ${SUB_ITEMS}`);
  console.log(`  Pool size    : ${POOL_SIZE}${POOL_SIZE > 1 ? "" : " (single shared session)"}`);
  console.log(`  Node / cores : ${process.version} / ${require("os").cpus().length}`);
  console.log("");

  let server = null;
  if (!NO_SPAWN) {
    process.stdout.write("  Starting test server... ");
    server = await startTestServer();
    console.log("up.");
  }

  const mgrConfig = {
    endpointUrl: ENDPOINT,
    securityMode: "None",
    securityPolicy: "None",
    applicationName: "OPCUA-Suite-Benchmark",
    operationTimeout: 15000,
    maxReconnectAttempts: 3,
  };
  const makeMgr = () =>
    POOL_SIZE > 1
      ? new PooledClientManager(mgrConfig, POOL_SIZE)
      : new OpcUaClientManager(mgrConfig);
  const mgr = makeMgr();

  let exitCode = 0;
  try {
    process.stdout.write("  Connecting... ");
    const tc = now();
    await mgr.connect();
    console.log(`connected in ${fmt(now() - tc)}ms.\n`);

    // Warm-up so JIT / channel setup doesn't skew the first phase.
    for (let i = 0; i < 20; i++) await mgr.read(READ_NODES[i % READ_NODES.length]);

    console.log("─ Throughput / latency (sustained load) ───────────────────");

    // 1) Single sequential read (concurrency 1) — baseline round-trip.
    const seq = await runLoad(
      (i) => mgr.read(READ_NODES[i % READ_NODES.length]),
      DURATION_MS,
      1,
    );
    printRow("read (sequential)", seq);

    // 2) Concurrent single reads.
    const readC = await runLoad(
      (i) => mgr.read(READ_NODES[i % READ_NODES.length]),
      DURATION_MS,
      CONCURRENCY,
    );
    printRow(`read (x${CONCURRENCY} concurrent)`, readC);

    // 3) readMultiple — 7 nodes per call (batch efficiency).
    const readM = await runLoad(
      () => mgr.readMultiple(READ_NODES),
      DURATION_MS,
      CONCURRENCY,
    );
    printRow(`readMultiple (${READ_NODES.length}/call)`, readM);

    // 4) Concurrent writes.
    const writeC = await runLoad(
      (i) => mgr.write(WRITE_NODE, 20 + (i % 50), "Double"),
      DURATION_MS,
      CONCURRENCY,
    );
    printRow(`write (x${CONCURRENCY} concurrent)`, writeC);

    console.log("");
    console.log("─ Resilience ──────────────────────────────────────────────");

    // 5) Connect/disconnect churn — fresh manager per cycle.
    const churnCycles = QUICK ? 15 : 50;
    const churn = await connectChurn(makeMgr, churnCycles);
    const churnPass = churn.errors === 0 ? "✓" : "✗";
    console.log(
      `  ${churnPass} connect/disconnect churn   ` +
        `${String(churn.cycles).padStart(7)} cyc  ` +
        `mean=${fmt(churn.mean).padStart(7)}ms  ` +
        `p50=${fmt(churn.p50).padStart(7)}ms  ` +
        `p95=${fmt(churn.p95).padStart(7)}ms  ` +
        `max=${fmt(churn.max).padStart(7)}ms  ` +
        `err=${churn.errors}`,
    );

    // 6) Reconnect under load — force session loss mid-stream.
    const dropEvery = QUICK ? 400 : 1000;
    const recon = await reconnectUnderLoad(
      mgr,
      DURATION_MS,
      CONCURRENCY,
      dropEvery,
    );
    // Under a forced session-loss storm at high concurrency, the node's
    // single-shot retry can leave a small fraction of ops failing. Pass if
    // we recovered to connected AND ≥99% of ops succeeded; the residual is
    // reported (see "What could be improved" in the README).
    const reconOk = recon.endedConnected && recon.recoveryRate >= 99;
    const reconPass = reconOk ? "✓" : "✗";
    console.log(
      `  ${reconPass} reconnect under load       ` +
        `${String(recon.ops).padStart(7)} ops  ` +
        `${fmt(recon.throughput, 0).padStart(7)} ops/s  ` +
        `p50=${fmt(recon.p50).padStart(7)}ms  ` +
        `p99=${fmt(recon.p99).padStart(7)}ms  ` +
        `drops=${recon.forcedDrops}  ` +
        `recovery=${fmt(recon.recoveryRate, 2)}%  ` +
        `err=${recon.errors}`,
    );

    console.log("");
    console.log("─ Subscribe stress ────────────────────────────────────────");
    const sub = await subscribeStress(mgr, SUB_ITEMS, DURATION_MS);
    const subPass = sub.itemErrors === 0 && sub.teardownErrors === 0 ? "✓" : "✗";
    console.log(
      `  ${subPass} ${SUB_ITEMS} monitored items @100ms over ${fmt(sub.elapsed, 0)}ms`,
    );
    console.log(
      `      notifications=${sub.notifications}  ` +
        `rate=${fmt(sub.notifRate, 0)}/s  ` +
        `itemErrors=${sub.itemErrors}  teardownErrors=${sub.teardownErrors}`,
    );

    console.log("");
    console.log("─ Verdict ──────────────────────────────────────────────────");
    // Steady-state phases must be error-free. The reconnect phase is a
    // deliberate fault-injection storm — judged by recovery rate + final
    // connected state, not by zero transient errors.
    const steadyErrors =
      seq.errors +
      readC.errors +
      readM.errors +
      writeC.errors +
      churn.errors +
      sub.itemErrors +
      sub.teardownErrors;
    if (steadyErrors === 0 && reconOk) {
      console.log(
        "  ✓ ALL PHASES PASS — steady-state clean; recovered cleanly from " +
          `${recon.forcedDrops} forced session drops (${fmt(recon.recoveryRate, 2)}% ops ok)`,
      );
      if (recon.errors > 0) {
        console.log(
          `    note: ${recon.errors} transient op(s) failed during the drop ` +
            "storm despite bounded retry (extreme fault injection).",
        );
      }
    } else {
      if (steadyErrors > 0) {
        console.log(`  ✗ ${steadyErrors} steady-state error(s) — see rows above`);
      }
      if (!reconOk) {
        console.log(
          `  ✗ reconnect phase: recovery=${fmt(recon.recoveryRate, 2)}% ` +
            `endedConnected=${recon.endedConnected}`,
        );
      }
      exitCode = 1;
    }
  } catch (err) {
    console.error("\n  ✗ Benchmark aborted:", err.message);
    exitCode = 1;
  } finally {
    try {
      await mgr.disconnect();
    } catch (e) {
      /* ignore */
    }
    if (server) {
      server.kill("SIGTERM");
    }
    // node-opcua keeps timers alive; force a clean exit after teardown.
    setTimeout(() => process.exit(exitCode), 300);
  }
}

main();
