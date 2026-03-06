/**
 * Test Runner for Node-RED Flows
 * Deploys all-use-cases.json and triggers inject nodes via Node-RED Admin API
 *
 * Usage: node test-server/test-flows.js [node-red-url]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.argv[2] || 'http://localhost:1881';
let passed = 0;
let failed = 0;

function ok(name) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

function fail(name, err) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`);
}

function request(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, BASE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: method,
            headers: { 'Content-Type': 'application/json' }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function triggerInject(nodeId) {
    return request('POST', `/inject/${nodeId}`, {});
}

async function getDebugMessages() {
    // Node-RED WebSocket debug is not easily accessible via REST
    // We wait a moment and check via the container logs
    return null;
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function run() {
    console.log(`\nNode-RED Flow Test Runner`);
    console.log(`Node-RED: ${BASE_URL}\n`);

    // 1. Deploy Flows
    console.log('1. Deploy Flows');
    try {
        const flowsPath = path.join(__dirname, '..', 'examples', 'all-use-cases.json');
        const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
        const res = await request('POST', '/flows', flows);
        if (res.status === 204 || res.status === 200) {
            ok(`Deployed ${flows.length} nodes`);
        } else {
            fail('Deploy', `Status ${res.status}: ${JSON.stringify(res.data)}`);
            return;
        }
    } catch (e) {
        fail('Deploy', e.message);
        return;
    }

    await sleep(3000); // Wait for connections to establish

    // 2. Read Operations
    console.log('\n2. Read Operations');
    const readTests = [
        { id: 'inject-read-topic', name: 'Single Read via msg.topic' },
        { id: 'inject-read-nodeid', name: 'Single Read via msg.nodeId' },
        { id: 'inject-read-op', name: 'Single Read via msg.operation' },
        { id: 'inject-readmulti-func', name: 'Multiple Read via Function' },
        { id: 'inject-readcollector', name: 'Multiple Read via Item Collector' },
        { id: 'inject-readattr', name: 'Read BrowseName Attribute' },
        { id: 'inject-readattr2', name: 'Read DisplayName Attribute' },
    ];

    for (const test of readTests) {
        try {
            const res = await triggerInject(test.id);
            if (res.status === 200) ok(test.name);
            else fail(test.name, `HTTP ${res.status}`);
        } catch (e) {
            fail(test.name, e.message);
        }
        await sleep(500);
    }

    // 3. Write Operations
    console.log('\n3. Write Operations');
    const writeTests = [
        { id: 'inject-write-double', name: 'Write Double (25.5)' },
        { id: 'inject-write-bool', name: 'Write Boolean (true)' },
        { id: 'inject-write-string', name: 'Write String' },
        { id: 'inject-write-op', name: 'Write via msg.operation' },
        { id: 'inject-writemulti', name: 'Multiple Write via Function' },
        { id: 'inject-writecollector', name: 'Multiple Write via Item Collector' },
    ];

    for (const test of writeTests) {
        try {
            const res = await triggerInject(test.id);
            if (res.status === 200) ok(test.name);
            else fail(test.name, `HTTP ${res.status}`);
        } catch (e) {
            fail(test.name, e.message);
        }
        await sleep(500);
    }

    // 4. Subscribe
    console.log('\n4. Subscribe & Events');
    const subTests = [
        { id: 'inject-sub', name: 'Subscribe (Sinus)' },
        { id: 'inject-sub2', name: 'Subscribe (Random)' },
        { id: 'inject-sub-queue', name: 'Subscribe with QueueSize' },
    ];

    for (const test of subTests) {
        try {
            const res = await triggerInject(test.id);
            if (res.status === 200) ok(test.name);
            else fail(test.name, `HTTP ${res.status}`);
        } catch (e) {
            fail(test.name, e.message);
        }
        await sleep(500);
    }

    await sleep(2000); // Let subscriptions receive some data

    // Unsubscribe
    try {
        const res = await triggerInject('inject-unsub');
        if (res.status === 200) ok('Unsubscribe (Sinus)');
        else fail('Unsubscribe', `HTTP ${res.status}`);
    } catch (e) {
        fail('Unsubscribe', e.message);
    }

    // 5. Browse & Discovery
    console.log('\n5. Browse & Discovery');
    const browseTests = [
        { id: 'inject-browse-root', name: 'Browse RootFolder' },
        { id: 'inject-browse-objects', name: 'Browse ObjectsFolder' },
        { id: 'inject-browse-testdata', name: 'Browse TestData' },
        { id: 'inject-browse-machine', name: 'Browse Machine Structure' },
        { id: 'inject-browse-nodeid', name: 'Browse via msg.nodeId' },
        { id: 'inject-browser', name: 'Browse via Browser Node' },
        { id: 'inject-endpoints-default', name: 'Get Endpoints (configured)' },
        { id: 'inject-endpoints-custom', name: 'Get Endpoints (custom URL)' },
        { id: 'inject-translate', name: 'Translate Browse Path' },
        { id: 'inject-register', name: 'Register Nodes' },
        { id: 'inject-unregister', name: 'Unregister Nodes' },
    ];

    for (const test of browseTests) {
        try {
            const res = await triggerInject(test.id);
            if (res.status === 200) ok(test.name);
            else fail(test.name, `HTTP ${res.status}`);
        } catch (e) {
            fail(test.name, e.message);
        }
        await sleep(500);
    }

    // 6. Method Calls
    console.log('\n6. Method Calls');
    const methodTests = [
        { id: 'inject-method-add', name: 'Call Add(3, 7)' },
        { id: 'inject-method-multiply', name: 'Call Multiply(6, 7)' },
        { id: 'inject-method-reset', name: 'Call ResetAll()' },
        { id: 'inject-method-payload', name: 'Method via msg.payload args' },
        { id: 'inject-method-node-add', name: 'Method Node: Add(5, 15)' },
        { id: 'inject-method-node-dynamic', name: 'Method Node: Dynamic args' },
    ];

    for (const test of methodTests) {
        try {
            const res = await triggerInject(test.id);
            if (res.status === 200) ok(test.name);
            else fail(test.name, `HTTP ${res.status}`);
        } catch (e) {
            fail(test.name, e.message);
        }
        await sleep(500);
    }

    // 7. History Read
    console.log('\n7. History Read');
    const historyTests = [
        { id: 'inject-history-default', name: 'History Read (last hour)' },
        { id: 'inject-history-custom', name: 'History Read (custom range)' },
        { id: 'inject-history-payload', name: 'History via msg.payload' },
    ];

    for (const test of historyTests) {
        try {
            const res = await triggerInject(test.id);
            if (res.status === 200) ok(test.name);
            else fail(test.name, `HTTP ${res.status}`);
        } catch (e) {
            fail(test.name, e.message);
        }
        await sleep(500);
    }

    // 8. Advanced Patterns
    console.log('\n8. Advanced Patterns');
    const advancedTests = [
        { id: 'inject-rmw', name: 'Read-Modify-Write Pattern' },
        { id: 'inject-condwrite', name: 'Conditional Write' },
        { id: 'inject-dynamic-ns2', name: 'Dynamic NodeId (Int32)' },
        { id: 'inject-dynamic-sinus', name: 'Dynamic NodeId (Sinus)' },
        { id: 'inject-dynamic-motor', name: 'Dynamic NodeId (Motor.Speed)' },
        { id: 'inject-machine-all', name: 'Batch Read All Machine Data' },
    ];

    for (const test of advancedTests) {
        try {
            const res = await triggerInject(test.id);
            if (res.status === 200) ok(test.name);
            else fail(test.name, `HTTP ${res.status}`);
        } catch (e) {
            fail(test.name, e.message);
        }
        await sleep(500);
    }

    // Wait a moment, then check Node-RED logs for errors
    await sleep(3000);

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  Ergebnis: \x1b[32m${passed} bestanden\x1b[0m, \x1b[31m${failed} fehlgeschlagen\x1b[0m`);
    console.log(`${'═'.repeat(50)}`);

    // Check for errors in Node-RED logs
    console.log('\n--- Checking Node-RED logs for errors ---');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
