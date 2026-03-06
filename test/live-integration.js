#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const http = require('http');

function inject(id) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { hostname: 'localhost', port: 1880, path: '/inject/' + id, method: 'POST' },
            (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }
        );
        req.on('error', reject);
        req.end();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
    const ws = new WebSocket('ws://localhost:1880/comms');
    const results = {};

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    ws.on('message', (data) => {
        for (const m of JSON.parse(data)) {
            if (m.topic === 'debug') {
                const parsed = JSON.parse(m.data.msg);
                results[m.data.name] = {
                    status: parsed.statusCode || parsed.operation || 'ok',
                    hasPayload: parsed.payload !== undefined && parsed.payload !== null,
                    payload: parsed.payload
                };
            }
        }
    });

    const tests = [
        ['inject-read-topic',          'Read Result',        'Single Read (topic)'],
        ['inject-read-nodeid',         'Read Result',        'Single Read (nodeId)'],
        ['inject-read-op',             'Read Result',        'Single Read (operation)'],
        ['inject-readmulti-func',      'Multi-Read Result',  'Read Multiple (items)'],
        ['inject-readmulti-payload',   'Multi-Read Result',  'Read Multiple (payload obj)'],
        ['inject-readcollector',       'Multi-Read Result',  'Read Multiple (collector)'],
        ['inject-readattr',            'Read Result',        'Read Attribute (BrowseName)'],
        ['inject-readattr2',           'Read Result',        'Read Attribute (DisplayName)'],
        ['inject-write-double',        'Write Result',       'Write Double'],
        ['inject-write-bool',          'Write Result',       'Write Boolean'],
        ['inject-write-string',        'Write Result',       'Write String'],
        ['inject-write-op',            'Write Result',       'Write via nodeId'],
        ['inject-writemulti',          'Multi-Write Result', 'Write Multiple (items)'],
        ['inject-writemulti-payload',  'Multi-Write Result', 'Write Multiple (payload obj)'],
        ['inject-browse-root',         'Browse Result',      'Browse RootFolder'],
        ['inject-browse-objects',      'Browse Result',      'Browse ObjectsFolder'],
        ['inject-browse-testdata',     'Browse Result',      'Browse TestData'],
        ['inject-browse-machine',      'Browse Result',      'Browse Machine'],
        ['inject-browse-nodeid',       'Browse Result',      'Browse via nodeId'],
        ['inject-endpoints-default',   'Browse Result',      'Get Endpoints'],
        ['inject-translate',           'Browse Result',      'Translate BrowsePath'],
        ['inject-register',            'Browse Result',      'Register Nodes'],
        ['inject-unregister',          'Browse Result',      'Unregister Nodes'],
        ['inject-method-add',          'Method Result',      'Method Add(3,7)'],
        ['inject-method-multiply',     'Method Result',      'Method Multiply(6,7)'],
        ['inject-method-reset',        'Method Result',      'Method ResetAll()'],
        ['inject-method-payload',      'Method Result',      'Method via payload args'],
        ['inject-history-default',     'History Result',     'History Read (last hour)'],
        ['inject-sub',                 'Subscription Data',  'Subscribe (Sinus)'],
        ['inject-unsub',               'Subscription Data',  'Unsubscribe (Sinus)'],
        ['inject-rmw',                 'Advanced Result',    'Read-Modify-Write'],
        ['inject-condwrite',           'Advanced Result',    'Conditional Write'],
        ['inject-dynamic-ns2',         'Advanced Result',    'Dynamic NodeId (Int32)'],
        ['inject-dynamic-sinus',       'Advanced Result',    'Dynamic NodeId (Sinus)'],
        ['inject-dynamic-motor',       'Advanced Result',    'Dynamic NodeId (Motor)'],
        ['inject-machine-all',         'Advanced Result',    'Batch Read Machine Data'],
    ];

    let passed = 0;
    let failed = 0;

    for (const [injectId, debugName, label] of tests) {
        delete results[debugName];
        try {
            await inject(injectId);
        } catch (e) {
            console.log('FAIL  ' + label.padEnd(38) + 'inject error: ' + e.message);
            failed++;
            continue;
        }
        await sleep(1000);

        const r = results[debugName];
        const ok = r && r.hasPayload;
        const status = r ? r.status : 'NO RESPONSE';
        if (ok) {
            console.log('PASS  ' + label.padEnd(38) + status);
            passed++;
        } else {
            console.log('FAIL  ' + label.padEnd(38) + status);
            failed++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log(passed + ' passed, ' + failed + ' failed out of ' + tests.length);
    console.log('='.repeat(50));

    ws.close();
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
