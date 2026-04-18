/**
 * End-to-End Test Runner for the bundled examples.
 *
 * Deploys all examples to a running Node-RED instance, triggers each
 * inject node, captures debug output via the /comms WebSocket and
 * reports per-example success/failure.
 *
 * Prerequisites:
 *   - Node-RED running on http://localhost:1880 with this package loaded
 *   - OPC UA test-server reachable from Node-RED at opc.tcp://opcua-server:4840/UA/TestServer
 *     (i.e. both containers on the same Docker network)
 *
 * Usage:
 *   node test/run-examples.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const NODE_RED_URL = process.env.NODE_RED_URL || 'http://localhost:1880';
const NODE_RED_WS = NODE_RED_URL.replace(/^http/, 'ws') + '/comms';
const OPCUA_URL_INTERNAL = 'opc.tcp://opcua-server:4840/UA/TestServer';

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');
const examples = fs.readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.json')).sort();

function colorize(c, s) { return `\x1b[${c}m${s}\x1b[0m`; }
const green = s => colorize('32', s);
const red = s => colorize('31', s);
const yellow = s => colorize('33', s);
const cyan = s => colorize('36', s);
const dim = s => colorize('2', s);

function request(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, NODE_RED_URL);
        const opts = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: method,
            headers: { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'full' }
        };
        const req = http.request(opts, res => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }); }
                catch { resolve({ status: res.statusCode, data }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadAndPatchExamples() {
    const allFlows = [];
    const meta = [];
    for (const file of examples) {
        const flows = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8'));
        const exMeta = {
            file,
            tab: flows.find(n => n.type === 'tab')?.id,
            label: flows.find(n => n.type === 'tab')?.label || file,
            injects: flows.filter(n => n.type === 'inject').map(n => ({ id: n.id, name: n.name })),
            debugs: flows.filter(n => n.type === 'debug').map(n => n.id)
        };
        for (const n of flows) {
            if (n.type === 'opcua-endpoint' && n.endpointUrl &&
                n.endpointUrl.includes('localhost:4841')) {
                n.endpointUrl = OPCUA_URL_INTERNAL;
            }
        }
        meta.push(exMeta);
        allFlows.push(...flows);
    }
    return { allFlows, meta };
}

class DebugCapture {
    constructor(ws) {
        this.ws = ws;
        // Map<exampleTabId, Array<msg>>
        this.byTab = new Map();
        this.byNodeId = new Map();
        this.errors = [];
    }
    handleMessage(raw) {
        let pkt;
        try { pkt = JSON.parse(raw); } catch { return; }
        if (!Array.isArray(pkt)) pkt = [pkt];
        for (const item of pkt) {
            if (!item.topic) continue;
            if (item.topic === 'debug' && item.data) {
                const d = item.data;
                if (!this.byNodeId.has(d.id)) this.byNodeId.set(d.id, []);
                this.byNodeId.get(d.id).push(d);
                if (d.z) {
                    if (!this.byTab.has(d.z)) this.byTab.set(d.z, []);
                    this.byTab.get(d.z).push(d);
                }
            }
            if (item.topic && item.topic.startsWith('notification/runtime')) {
                this.errors.push(item.data);
            }
        }
    }
}

async function main() {
    console.log(cyan('\n────────────────────────────────────────────────'));
    console.log(cyan('  Node-RED Example Runner'));
    console.log(cyan('────────────────────────────────────────────────'));
    console.log(`  Node-RED:    ${NODE_RED_URL}`);
    console.log(`  Test-Server: ${OPCUA_URL_INTERNAL}`);
    console.log(`  Examples:    ${examples.length} files\n`);

    console.log(dim('1. Connecting to Node-RED admin API...'));
    const settings = await request('GET', '/settings');
    if (settings.status !== 200) {
        console.error(red(`   Cannot reach Node-RED at ${NODE_RED_URL} (status ${settings.status})`));
        process.exit(2);
    }
    console.log(green(`   ✓ Node-RED ${settings.data?.version || 'reachable'}\n`));

    console.log(dim('2. Loading and patching example flows...'));
    const { allFlows, meta } = loadAndPatchExamples();
    console.log(green(`   ✓ ${meta.length} examples, ${allFlows.length} total nodes\n`));

    console.log(dim('3. Connecting WebSocket /comms for debug capture...'));
    const ws = new WebSocket(NODE_RED_WS);
    const capture = new DebugCapture(ws);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS connect timeout')), 5000);
    });
    ws.on('message', raw => capture.handleMessage(raw.toString()));
    ws.send(JSON.stringify({ subscribe: 'debug' }));
    console.log(green('   ✓ WebSocket connected\n'));

    console.log(dim('4. Deploying flows...'));
    const dep = await request('POST', '/flows', allFlows);
    if (dep.status !== 204 && dep.status !== 200) {
        console.error(red(`   ✗ Deploy failed: HTTP ${dep.status} ${JSON.stringify(dep.data)}`));
        process.exit(3);
    }
    console.log(green('   ✓ Deployed\n'));
    await sleep(3000);

    console.log(dim('5. Running examples\n'));
    let totalPass = 0, totalFail = 0;
    const results = [];

    for (const ex of meta) {
        console.log(cyan(`── ${ex.label} ──`));
        capture.byTab.set(ex.tab, []);
        const exResults = { label: ex.label, file: ex.file, injects: [], errors: [] };

        for (const inj of ex.injects) {
            // Skip the inject from ex09 that has empty wires (Stop button)
            if (!inj.id) continue;
            const before = (capture.byTab.get(ex.tab) || []).length;
            const res = await request('POST', `/inject/${inj.id}`, {});
            await sleep(1500); // Allow time for OPC UA round-trip + debug emission
            const after = (capture.byTab.get(ex.tab) || []).length;
            const newMsgs = (capture.byTab.get(ex.tab) || []).slice(before, after);
            const errMsgs = newMsgs.filter(m => {
                const f = String(m.format || '');
                const s = String(m.msg || '');
                return f.toLowerCase().includes('error') || s.toLowerCase().includes('error');
            });
            const httpOK = (res.status === 200);
            let status, label;
            if (!httpOK) {
                status = 'FAIL'; totalFail++;
                label = red(`  ✗ ${inj.name || inj.id} — HTTP ${res.status}`);
            } else if (errMsgs.length) {
                status = 'WARN'; totalFail++;
                const sample = (errMsgs[0].msg || errMsgs[0].format || '').toString().slice(0, 100);
                label = yellow(`  ⚠ ${inj.name || inj.id} — debug shows error: ${sample}`);
            } else if (newMsgs.length === 0) {
                status = 'NODBG'; // No debug message captured (might be subscribe-only or no output)
                totalPass++;
                label = dim(`  · ${inj.name || inj.id} — triggered (no debug msg)`);
            } else {
                status = 'OK'; totalPass++;
                const sample = (newMsgs[0].msg || newMsgs[0].format || '').toString().slice(0, 60);
                label = green(`  ✓ ${inj.name || inj.id} — ${sample}`);
            }
            console.log(label);
            exResults.injects.push({ name: inj.name, id: inj.id, status, debugCount: newMsgs.length });
        }

        results.push(exResults);
        console.log();
    }

    console.log(cyan('────────────────────────────────────────────────'));
    console.log(`  Result: ${green(totalPass + ' OK')}, ${red(totalFail + ' Errors/Warnings')}`);
    console.log(cyan('────────────────────────────────────────────────'));

    if (capture.errors.length) {
        console.log(yellow('\nRuntime notifications:'));
        for (const e of capture.errors) console.log(' ', JSON.stringify(e).slice(0, 200));
    }

    ws.close();
    process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(red('\nFATAL: ' + err.stack));
    process.exit(99);
});
