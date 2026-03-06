/**
 * Automatisierte Tests gegen den OPC UA Test Server
 * Startet: node test-server/test-client.js [endpoint]
 */

const {
    OPCUAClient,
    MessageSecurityMode,
    SecurityPolicy,
    AttributeIds,
    DataType,
    Variant,
    ClientMonitoredItem,
    TimestampsToReturn
} = require('node-opcua');

const ENDPOINT = process.argv[2] || 'opc.tcp://localhost:4840/UA/TestServer';

let passed = 0;
let failed = 0;
const results = [];

function ok(name) {
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

function fail(name, err) {
    failed++;
    results.push({ name, status: 'FAIL', error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`);
}

async function run() {
    console.log(`\nOPC UA Suite — Testlauf`);
    console.log(`Endpoint: ${ENDPOINT}\n`);

    const client = OPCUAClient.create({
        applicationName: 'Test Client',
        securityMode: MessageSecurityMode.None,
        securityPolicy: SecurityPolicy.None,
        endpointMustExist: false
    });

    try {
        // ─── 1. VERBINDUNG ───
        console.log('1. Verbindung');
        try {
            await client.connect(ENDPOINT);
            ok('Connect');
        } catch (e) { fail('Connect', e.message); return; }

        const session = await client.createSession();
        ok('Session erstellen');

        // ─── 2. SINGLE READ ───
        console.log('\n2. Single Read');

        // Boolean
        try {
            const dv = await session.read({ nodeId: 'ns=1;s=Scalar.Boolean', attributeId: AttributeIds.Value });
            if (dv.value.value === true) ok('Read Boolean');
            else fail('Read Boolean', `Expected true, got ${dv.value.value}`);
        } catch (e) { fail('Read Boolean', e.message); }

        // Int32
        try {
            const dv = await session.read({ nodeId: 'ns=1;s=Scalar.Int32', attributeId: AttributeIds.Value });
            if (dv.value.value === -100000) ok('Read Int32');
            else fail('Read Int32', `Expected -100000, got ${dv.value.value}`);
        } catch (e) { fail('Read Int32', e.message); }

        // Double
        try {
            const dv = await session.read({ nodeId: 'ns=1;s=Scalar.Double', attributeId: AttributeIds.Value });
            if (Math.abs(dv.value.value - 2.718281828) < 0.001) ok('Read Double');
            else fail('Read Double', `Expected ~2.718, got ${dv.value.value}`);
        } catch (e) { fail('Read Double', e.message); }

        // String
        try {
            const dv = await session.read({ nodeId: 'ns=1;s=Scalar.String', attributeId: AttributeIds.Value });
            if (dv.value.value === 'Hello OPC UA') ok('Read String');
            else fail('Read String', `Expected 'Hello OPC UA', got ${dv.value.value}`);
        } catch (e) { fail('Read String', e.message); }

        // DateTime
        try {
            const dv = await session.read({ nodeId: 'ns=1;s=Scalar.DateTime', attributeId: AttributeIds.Value });
            if (dv.value.value instanceof Date) ok('Read DateTime');
            else fail('Read DateTime', `Expected Date, got ${typeof dv.value.value}`);
        } catch (e) { fail('Read DateTime', e.message); }

        // Float
        try {
            const dv = await session.read({ nodeId: 'ns=1;s=Scalar.Float', attributeId: AttributeIds.Value });
            if (Math.abs(dv.value.value - 3.14) < 0.01) ok('Read Float');
            else fail('Read Float', `Expected ~3.14, got ${dv.value.value}`);
        } catch (e) { fail('Read Float', e.message); }

        // ─── 3. MULTIPLE READ ───
        console.log('\n3. Multiple Read');
        try {
            const nodesToRead = [
                { nodeId: 'ns=1;s=Scalar.Boolean', attributeId: AttributeIds.Value },
                { nodeId: 'ns=1;s=Scalar.Int32',   attributeId: AttributeIds.Value },
                { nodeId: 'ns=1;s=Scalar.Double',  attributeId: AttributeIds.Value },
                { nodeId: 'ns=1;s=Scalar.String',  attributeId: AttributeIds.Value },
            ];
            const dvs = await session.read(nodesToRead);
            if (Array.isArray(dvs) && dvs.length === 4) ok('Multiple Read (4 items)');
            else fail('Multiple Read (4 items)', `Expected array of 4, got ${dvs?.length}`);

            if (dvs[0].value.value === true && dvs[3].value.value === 'Hello OPC UA') {
                ok('Multiple Read Werte korrekt');
            } else {
                fail('Multiple Read Werte korrekt', 'Unerwartete Werte');
            }
        } catch (e) { fail('Multiple Read', e.message); }

        // ─── 4. ARRAYS READ ───
        console.log('\n4. Array Read');
        try {
            const dv = await session.read({ nodeId: 'ns=1;s=Arrays.IntArray', attributeId: AttributeIds.Value });
            const arr = dv.value.value;
            if (arr && arr.length === 5 && arr[0] === 10 && arr[4] === 50) ok('Read IntArray');
            else fail('Read IntArray', `Unexpected: ${JSON.stringify(arr)}`);
        } catch (e) { fail('Read IntArray', e.message); }

        try {
            const dv = await session.read({ nodeId: 'ns=1;s=Arrays.StringArray', attributeId: AttributeIds.Value });
            const arr = dv.value.value;
            if (arr && arr.length === 3 && arr[0] === 'Alpha') ok('Read StringArray');
            else fail('Read StringArray', `Unexpected: ${JSON.stringify(arr)}`);
        } catch (e) { fail('Read StringArray', e.message); }

        // ─── 5. SINGLE WRITE ───
        console.log('\n5. Single Write');
        try {
            const sc = await session.write({
                nodeId: 'ns=1;s=Writable.Temperature',
                attributeId: AttributeIds.Value,
                value: { value: new Variant({ dataType: DataType.Double, value: 99.9 }) }
            });
            if (sc.isGood()) ok('Write Double');
            else fail('Write Double', sc.toString());

            // Verify
            const dv = await session.read({ nodeId: 'ns=1;s=Writable.Temperature', attributeId: AttributeIds.Value });
            if (Math.abs(dv.value.value - 99.9) < 0.01) ok('Write Double verify');
            else fail('Write Double verify', `Expected 99.9, got ${dv.value.value}`);
        } catch (e) { fail('Write Double', e.message); }

        try {
            const sc = await session.write({
                nodeId: 'ns=1;s=Writable.Active',
                attributeId: AttributeIds.Value,
                value: { value: new Variant({ dataType: DataType.Boolean, value: true }) }
            });
            if (sc.isGood()) ok('Write Boolean');
            else fail('Write Boolean', sc.toString());
        } catch (e) { fail('Write Boolean', e.message); }

        try {
            const sc = await session.write({
                nodeId: 'ns=1;s=Writable.MachineName',
                attributeId: AttributeIds.Value,
                value: { value: new Variant({ dataType: DataType.String, value: 'TestMachine-42' }) }
            });
            if (sc.isGood()) ok('Write String');
            else fail('Write String', sc.toString());

            const dv = await session.read({ nodeId: 'ns=1;s=Writable.MachineName', attributeId: AttributeIds.Value });
            if (dv.value.value === 'TestMachine-42') ok('Write String verify');
            else fail('Write String verify', `Expected TestMachine-42, got ${dv.value.value}`);
        } catch (e) { fail('Write String', e.message); }

        // ─── 6. MULTIPLE WRITE ───
        console.log('\n6. Multiple Write');
        try {
            const nodesToWrite = [
                {
                    nodeId: 'ns=1;s=Writable.Temperature',
                    attributeId: AttributeIds.Value,
                    value: { value: new Variant({ dataType: DataType.Double, value: 42.0 }) }
                },
                {
                    nodeId: 'ns=1;s=Writable.Pressure',
                    attributeId: AttributeIds.Value,
                    value: { value: new Variant({ dataType: DataType.Double, value: 1000.0 }) }
                },
                {
                    nodeId: 'ns=1;s=Writable.Counter',
                    attributeId: AttributeIds.Value,
                    value: { value: new Variant({ dataType: DataType.Int32, value: 777 }) }
                }
            ];
            const statusCodes = await session.write(nodesToWrite);
            const scs = Array.isArray(statusCodes) ? statusCodes : [statusCodes];
            if (scs.length === 3 && scs.every(sc => sc.isGood())) ok('Multiple Write (3 items)');
            else fail('Multiple Write', `Some writes failed: ${scs.map(s => s.toString())}`);

            // Verify
            const dvs = await session.read([
                { nodeId: 'ns=1;s=Writable.Temperature', attributeId: AttributeIds.Value },
                { nodeId: 'ns=1;s=Writable.Pressure', attributeId: AttributeIds.Value },
                { nodeId: 'ns=1;s=Writable.Counter', attributeId: AttributeIds.Value }
            ]);
            if (dvs[0].value.value === 42.0 && dvs[1].value.value === 1000.0 && dvs[2].value.value === 777) {
                ok('Multiple Write verify');
            } else {
                fail('Multiple Write verify', `Values: ${dvs.map(d => d.value.value)}`);
            }
        } catch (e) { fail('Multiple Write', e.message); }

        // ─── 7. DYNAMIC VALUES ───
        console.log('\n7. Dynamische Werte');
        try {
            const dv1 = await session.read({ nodeId: 'ns=1;s=Dynamic.Sinus', attributeId: AttributeIds.Value });
            await new Promise(r => setTimeout(r, 1500));
            const dv2 = await session.read({ nodeId: 'ns=1;s=Dynamic.Sinus', attributeId: AttributeIds.Value });
            if (dv1.value.value !== dv2.value.value) ok('Dynamic Sinus (Wert ändert sich)');
            else fail('Dynamic Sinus', 'Wert hat sich nicht geändert');
        } catch (e) { fail('Dynamic Sinus', e.message); }

        try {
            const dv = await session.read({ nodeId: 'ns=1;s=Dynamic.Ramp', attributeId: AttributeIds.Value });
            if (typeof dv.value.value === 'number' && dv.value.value >= 0 && dv.value.value < 100) {
                ok('Dynamic Ramp');
            } else {
                fail('Dynamic Ramp', `Unexpected: ${dv.value.value}`);
            }
        } catch (e) { fail('Dynamic Ramp', e.message); }

        // ─── 8. BROWSE ───
        console.log('\n8. Browse');
        try {
            const result = await session.browse('RootFolder');
            if (result.references && result.references.length > 0) ok('Browse RootFolder');
            else fail('Browse RootFolder', 'Keine Referenzen');
        } catch (e) { fail('Browse RootFolder', e.message); }

        try {
            const result = await session.browse({ nodeId: 'ns=1;s=TestData', resultMask: 63 });
            const refs = result.references || [];
            const names = refs.map(r => r.browseName.name || r.browseName.toString());
            if (names.includes('Scalar') && names.includes('Dynamic') && names.includes('Writable')) {
                ok('Browse TestData Ordnerstruktur');
            } else {
                fail('Browse TestData', `Found ${refs.length} refs: ${names.join(', ')}`);
            }
        } catch (e) { fail('Browse TestData', e.message); }

        try {
            const result = await session.browse({ nodeId: 'ns=1;s=Machine', resultMask: 63 });
            const refs = result.references || [];
            const names = refs.map(r => r.browseName.name || r.browseName.toString());
            if (names.includes('Motor') && names.includes('Pump') && names.includes('Sensors')) {
                ok('Browse Machine Struktur');
            } else {
                fail('Browse Machine', `Found ${refs.length} refs: ${names.join(', ')}`);
            }
        } catch (e) { fail('Browse Machine', e.message); }

        // ─── 9. SUBSCRIPTION ───
        console.log('\n9. Subscription');
        try {
            const subscription = await session.createSubscription2({
                requestedPublishingInterval: 250,
                requestedMaxKeepAliveCount: 10,
                requestedLifetimeCount: 100,
                maxNotificationsPerPublish: 100,
                publishingEnabled: true,
                priority: 10
            });
            ok('Subscription erstellen');

            let valueReceived = false;
            const monitoredItem = ClientMonitoredItem.create(
                subscription,
                { nodeId: 'ns=1;s=Dynamic.Sinus', attributeId: AttributeIds.Value },
                { samplingInterval: 250, discardOldest: true, queueSize: 10 },
                TimestampsToReturn.Both
            );

            await new Promise((resolve) => {
                monitoredItem.on('changed', (dataValue) => {
                    if (!valueReceived) {
                        valueReceived = true;
                        resolve();
                    }
                });
                setTimeout(resolve, 5000);
            });

            if (valueReceived) ok('MonitoredItem Wert empfangen');
            else fail('MonitoredItem', 'Kein Wert in 5s empfangen');

            await monitoredItem.terminate();
            ok('MonitoredItem beenden');

            await subscription.terminate();
            ok('Subscription beenden');
        } catch (e) { fail('Subscription', e.message); }

        // ─── 10. METHOD CALL ───
        console.log('\n10. Method Call');
        try {
            // objectId muss eine Objekt-NodeId sein, die die Methode enthält
            const methodResult = await session.call({
                objectId: 'ns=1;s=Methods',
                methodId: 'ns=1;s=Methods.Add',
                inputArguments: [
                    new Variant({ dataType: DataType.Double, value: 3.0 }),
                    new Variant({ dataType: DataType.Double, value: 7.0 })
                ]
            });
            if (methodResult.statusCode.isGood() && methodResult.outputArguments[0].value === 10.0) {
                ok('Method Call Add(3, 7) = 10');
            } else {
                fail('Method Call Add', `Status: ${methodResult.statusCode}, Value: ${methodResult.outputArguments?.[0]?.value}`);
            }
        } catch (e) {
            // Fallback: versuche mit dem Folder als ObjectId
            try {
                const browseRes = await session.browse({ nodeId: 'ns=1;s=TestData' });
                const methodsRef = browseRes.references.find(r => r.browseName.name === 'Methods');
                if (methodsRef) {
                    const res = await session.call({
                        objectId: methodsRef.nodeId,
                        methodId: 'ns=1;s=Methods.Add',
                        inputArguments: [
                            new Variant({ dataType: DataType.Double, value: 3.0 }),
                            new Variant({ dataType: DataType.Double, value: 7.0 })
                        ]
                    });
                    if (res.statusCode.isGood() && res.outputArguments[0].value === 10.0) {
                        ok('Method Call Add(3, 7) = 10 (via browse)');
                    } else {
                        fail('Method Call Add', `Status: ${res.statusCode}`);
                    }
                } else {
                    fail('Method Call Add', e.message);
                }
            } catch (e2) { fail('Method Call Add', `${e.message} / ${e2.message}`); }
        }

        try {
            const result = await session.call({
                objectId: 'ns=1;s=Methods',
                methodId: 'ns=1;s=Methods.Multiply',
                inputArguments: [
                    new Variant({ dataType: DataType.Double, value: 6.0 }),
                    new Variant({ dataType: DataType.Double, value: 7.0 })
                ]
            });
            if (result.statusCode.isGood() && result.outputArguments[0].value === 42.0) {
                ok('Method Call Multiply(6, 7) = 42');
            } else {
                fail('Method Call Multiply', `Value: ${result.outputArguments?.[0]?.value}`);
            }
        } catch (e) { fail('Method Call Multiply', e.message); }

        try {
            const result = await session.call({
                objectId: 'ns=1;s=Methods',
                methodId: 'ns=1;s=Methods.ResetAll',
                inputArguments: []
            });
            if (result.statusCode.isGood()) ok('Method Call ResetAll');
            else fail('Method Call ResetAll', result.statusCode.toString());

            // Verify reset
            const dv = await session.read({ nodeId: 'ns=1;s=Writable.Temperature', attributeId: AttributeIds.Value });
            if (dv.value.value === 20.0) ok('ResetAll verify (Temperature = 20.0)');
            else fail('ResetAll verify', `Temperature = ${dv.value.value}`);
        } catch (e) { fail('Method Call ResetAll', e.message); }

        // ─── 11. MACHINE STRUCTURE ───
        console.log('\n11. Machine Struktur');
        try {
            const nodes = [
                'ns=1;s=Machine.Motor.Speed',
                'ns=1;s=Machine.Motor.Current',
                'ns=1;s=Machine.Pump.FlowRate',
                'ns=1;s=Machine.Sensors.AmbientTemp',
                'ns=1;s=Machine.Sensors.Vibration'
            ];
            const dvs = await session.read(nodes.map(n => ({ nodeId: n, attributeId: AttributeIds.Value })));
            const allGood = dvs.every(d => d.statusCode.isGood());
            if (allGood && dvs.length === 5) ok('Read alle Machine-Variablen (5 items)');
            else fail('Machine Read', `StatusCodes: ${dvs.map(d => d.statusCode.toString())}`);
        } catch (e) { fail('Machine Read', e.message); }

        // Machine Write
        try {
            const nodesToWrite = [
                { nodeId: 'ns=1;s=Machine.Motor.Speed', attributeId: AttributeIds.Value, value: { value: new Variant({ dataType: DataType.Double, value: 3000.0 }) } },
                { nodeId: 'ns=1;s=Machine.Pump.FlowRate', attributeId: AttributeIds.Value, value: { value: new Variant({ dataType: DataType.Double, value: 200.0 }) } },
            ];
            const scs = await session.write(nodesToWrite);
            const arr = Array.isArray(scs) ? scs : [scs];
            if (arr.every(s => s.isGood())) ok('Write Machine-Variablen');
            else fail('Write Machine', arr.map(s => s.toString()));
        } catch (e) { fail('Write Machine', e.message); }

        // ─── CLEANUP ───
        console.log('\n--- Cleanup ---');
        await session.close();
        ok('Session schließen');

        await client.disconnect();
        ok('Disconnect');

    } catch (e) {
        fail('FATAL', e.message);
        try { await client.disconnect(); } catch (_) {}
    }

    // ─── ZUSAMMENFASSUNG ───
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  Ergebnis: \x1b[32m${passed} bestanden\x1b[0m, \x1b[31m${failed} fehlgeschlagen\x1b[0m`);
    console.log(`${'═'.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

run();
