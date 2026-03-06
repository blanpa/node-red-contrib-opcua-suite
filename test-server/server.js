/**
 * OPC UA Test Server
 * Supports ALL OPC UA authentication methods:
 *   - Anonymous
 *   - Username/Password
 *   - X509 Certificate
 * And all Security Modes / Policies
 */

const {
    OPCUAServer,
    Variant,
    DataType,
    StatusCodes,
    VariantArrayType,
    UAMethod,
    SessionContext,
    MessageSecurityMode,
    SecurityPolicy,
    nodesets,
    OPCUACertificateManager
} = require('node-opcua');

const fs = require('fs');
const path = require('path');

const PORT = 4840;

// ─── Test Users for Username/Password Authentication ───
const TEST_USERS = {
    'admin':    { password: 'admin123',    role: 'admin' },
    'operator': { password: 'operator123', role: 'operator' },
    'viewer':   { password: 'viewer123',   role: 'viewer' }
};

// ─── Certificate directories ───
const PKI_DIR = path.join(__dirname, 'pki');
const CERTS_DIR = path.join(PKI_DIR, 'certs');
const USER_CERTS_DIR = path.join(PKI_DIR, 'user-certs');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

async function startServer() {
    ensureDir(PKI_DIR);
    ensureDir(CERTS_DIR);
    ensureDir(USER_CERTS_DIR);

    // Server certificate manager (auto-generates if missing)
    const serverCertificateManager = new OPCUACertificateManager({
        automaticallyAcceptUnknownCertificate: true,
        rootFolder: path.join(PKI_DIR, 'server')
    });
    await serverCertificateManager.initialize();

    // User certificate manager for X509 token validation
    const userCertificateManager = new OPCUACertificateManager({
        automaticallyAcceptUnknownCertificate: true,
        rootFolder: path.join(PKI_DIR, 'user')
    });
    await userCertificateManager.initialize();

    const server = new OPCUAServer({
        port: PORT,
        resourcePath: '/UA/TestServer',
        buildInfo: {
            productName: 'OPC UA Test Server',
            buildNumber: '1.0.0',
            buildDate: new Date()
        },
        serverInfo: {
            applicationUri: 'urn:NodeRED:OPCUATestServer',
            productUri: 'urn:NodeRED:OPCUATestServer',
            applicationName: { text: 'OPC UA Test Server' }
        },
        maxAllowedSessionNumber: 50,
        maxConnectionsPerEndpoint: 50,

        // ─── Security: ALL modes and policies ───
        securityModes: [
            MessageSecurityMode.None,
            MessageSecurityMode.Sign,
            MessageSecurityMode.SignAndEncrypt
        ],
        securityPolicies: [
            SecurityPolicy.None,
            SecurityPolicy.Basic256Sha256,
            SecurityPolicy.Aes128_Sha256_RsaOaep,
            SecurityPolicy.Aes256_Sha256_RsaPss
        ],

        // ─── Authentication: ALL methods ───
        allowAnonymous: true,

        // Username/Password validation
        userManager: {
            isValidUser: function(userName, password) {
                const user = TEST_USERS[userName];
                return user !== undefined && user.password === password;
            }
        },

        // X509 Certificate validation
        userCertificateManager: userCertificateManager,

        // Server certificate manager
        serverCertificateManager: serverCertificateManager
    });

    await server.initialize();

    const addressSpace = server.engine.addressSpace;
    const ns = addressSpace.getOwnNamespace();

    // ─── Ordnerstruktur ───

    const rootFolder = addressSpace.findNode('ObjectsFolder');

    const testFolder = ns.addFolder(rootFolder, { browseName: 'TestData', nodeId: 's=TestData' });
    const scalarFolder = ns.addFolder(testFolder, { browseName: 'Scalar', nodeId: 's=Scalar' });
    const arrayFolder = ns.addFolder(testFolder, { browseName: 'Arrays', nodeId: 's=Arrays' });
    const dynamicFolder = ns.addFolder(testFolder, { browseName: 'Dynamic', nodeId: 's=Dynamic' });
    const methodFolder = ns.addFolder(testFolder, { browseName: 'Methods', nodeId: 's=Methods' });
    const structFolder = ns.addFolder(testFolder, { browseName: 'Structure', nodeId: 's=Structure' });

    // ─── Skalare Variablen (alle wichtigen Datentypen) ───

    const scalars = [
        { name: 'Boolean',  dataType: DataType.Boolean,  value: true },
        { name: 'SByte',    dataType: DataType.SByte,    value: -42 },
        { name: 'Byte',     dataType: DataType.Byte,     value: 200 },
        { name: 'Int16',    dataType: DataType.Int16,    value: -1234 },
        { name: 'UInt16',   dataType: DataType.UInt16,   value: 5678 },
        { name: 'Int32',    dataType: DataType.Int32,    value: -100000 },
        { name: 'UInt32',   dataType: DataType.UInt32,   value: 250000 },
        { name: 'Float',    dataType: DataType.Float,    value: 3.14 },
        { name: 'Double',   dataType: DataType.Double,   value: 2.718281828 },
        { name: 'String',   dataType: DataType.String,   value: 'Hello OPC UA' },
        { name: 'DateTime', dataType: DataType.DateTime, value: new Date() },
    ];

    for (const s of scalars) {
        const variantOpts = { dataType: s.dataType, value: s.value };
        if (s.arrayType) variantOpts.arrayType = s.arrayType;
        ns.addVariable({
            componentOf: scalarFolder,
            browseName: s.name,
            nodeId: `s=Scalar.${s.name}`,
            dataType: s.dataType,
            value: new Variant(variantOpts),
            writable: true
        });
    }

    // ─── Array-Variablen ───

    ns.addVariable({
        componentOf: arrayFolder,
        browseName: 'IntArray',
        nodeId: 's=Arrays.IntArray',
        dataType: DataType.Int32,
        valueRank: 1,
        arrayDimensions: [5],
        value: new Variant({
            dataType: DataType.Int32,
            arrayType: VariantArrayType.Array,
            value: Int32Array.from([10, 20, 30, 40, 50])
        }),
        writable: true
    });

    ns.addVariable({
        componentOf: arrayFolder,
        browseName: 'DoubleArray',
        nodeId: 's=Arrays.DoubleArray',
        dataType: DataType.Double,
        valueRank: 1,
        arrayDimensions: [4],
        value: new Variant({
            dataType: DataType.Double,
            arrayType: VariantArrayType.Array,
            value: Float64Array.from([1.1, 2.2, 3.3, 4.4])
        }),
        writable: true
    });

    ns.addVariable({
        componentOf: arrayFolder,
        browseName: 'StringArray',
        nodeId: 's=Arrays.StringArray',
        dataType: DataType.String,
        valueRank: 1,
        arrayDimensions: [3],
        value: new Variant({
            dataType: DataType.String,
            arrayType: VariantArrayType.Array,
            value: ['Alpha', 'Bravo', 'Charlie']
        }),
        writable: true
    });

    ns.addVariable({
        componentOf: arrayFolder,
        browseName: 'BoolArray',
        nodeId: 's=Arrays.BoolArray',
        dataType: DataType.Boolean,
        valueRank: 1,
        arrayDimensions: [4],
        value: new Variant({
            dataType: DataType.Boolean,
            arrayType: VariantArrayType.Array,
            value: [true, false, true, false]
        }),
        writable: true
    });

    // ─── Dynamische Variablen (ändern sich zyklisch) ───

    let sineCounter = 0;
    let randomValue = 50;
    let toggleState = false;
    let rampValue = 0;

    const sinusVar = ns.addVariable({
        componentOf: dynamicFolder,
        browseName: 'Sinus',
        nodeId: 's=Dynamic.Sinus',
        dataType: DataType.Double,
        value: new Variant({ dataType: DataType.Double, value: 0 })
    });

    const randomVar = ns.addVariable({
        componentOf: dynamicFolder,
        browseName: 'Random',
        nodeId: 's=Dynamic.Random',
        dataType: DataType.Double,
        value: new Variant({ dataType: DataType.Double, value: 50 })
    });

    const toggleVar = ns.addVariable({
        componentOf: dynamicFolder,
        browseName: 'Toggle',
        nodeId: 's=Dynamic.Toggle',
        dataType: DataType.Boolean,
        value: new Variant({ dataType: DataType.Boolean, value: false })
    });

    const rampVar = ns.addVariable({
        componentOf: dynamicFolder,
        browseName: 'Ramp',
        nodeId: 's=Dynamic.Ramp',
        dataType: DataType.Int32,
        value: new Variant({ dataType: DataType.Int32, value: 0 })
    });

    const timestampVar = ns.addVariable({
        componentOf: dynamicFolder,
        browseName: 'Timestamp',
        nodeId: 's=Dynamic.Timestamp',
        dataType: DataType.DateTime,
        value: new Variant({ dataType: DataType.DateTime, value: new Date() })
    });

    // Werte alle 1s aktualisieren
    setInterval(() => {
        sineCounter += 0.1;
        randomValue += (Math.random() - 0.5) * 10;
        randomValue = Math.max(0, Math.min(100, randomValue));
        toggleState = !toggleState;
        rampValue = (rampValue + 1) % 100;

        sinusVar.setValueFromSource(new Variant({ dataType: DataType.Double, value: Math.sin(sineCounter) * 100 }));
        randomVar.setValueFromSource(new Variant({ dataType: DataType.Double, value: randomValue }));
        toggleVar.setValueFromSource(new Variant({ dataType: DataType.Boolean, value: toggleState }));
        rampVar.setValueFromSource(new Variant({ dataType: DataType.Int32, value: rampValue }));
        timestampVar.setValueFromSource(new Variant({ dataType: DataType.DateTime, value: new Date() }));
    }, 1000);

    // ─── Beschreibbare Variablen (für Write-Tests) ───

    const writableFolder = ns.addFolder(testFolder, { browseName: 'Writable', nodeId: 's=Writable' });

    ns.addVariable({
        componentOf: writableFolder,
        browseName: 'Temperature',
        nodeId: 's=Writable.Temperature',
        dataType: DataType.Double,
        value: new Variant({ dataType: DataType.Double, value: 20.0 }),
        writable: true
    });

    ns.addVariable({
        componentOf: writableFolder,
        browseName: 'Pressure',
        nodeId: 's=Writable.Pressure',
        dataType: DataType.Double,
        value: new Variant({ dataType: DataType.Double, value: 1013.25 }),
        writable: true
    });

    ns.addVariable({
        componentOf: writableFolder,
        browseName: 'SetPoint',
        nodeId: 's=Writable.SetPoint',
        dataType: DataType.Float,
        value: new Variant({ dataType: DataType.Float, value: 75.0 }),
        writable: true
    });

    ns.addVariable({
        componentOf: writableFolder,
        browseName: 'MachineName',
        nodeId: 's=Writable.MachineName',
        dataType: DataType.String,
        value: new Variant({ dataType: DataType.String, value: 'Machine-001' }),
        writable: true
    });

    ns.addVariable({
        componentOf: writableFolder,
        browseName: 'Active',
        nodeId: 's=Writable.Active',
        dataType: DataType.Boolean,
        value: new Variant({ dataType: DataType.Boolean, value: false }),
        writable: true
    });

    ns.addVariable({
        componentOf: writableFolder,
        browseName: 'Counter',
        nodeId: 's=Writable.Counter',
        dataType: DataType.Int32,
        value: new Variant({ dataType: DataType.Int32, value: 0 }),
        writable: true
    });

    // ─── Methoden ───

    // Add-Methode: addiert zwei Zahlen
    const addMethod = ns.addMethod(methodFolder, {
        browseName: 'Add',
        nodeId: 's=Methods.Add',
        inputArguments: [
            {
                name: 'A',
                description: { text: 'Erster Operand' },
                dataType: DataType.Double
            },
            {
                name: 'B',
                description: { text: 'Zweiter Operand' },
                dataType: DataType.Double
            }
        ],
        outputArguments: [
            {
                name: 'Result',
                description: { text: 'Summe von A und B' },
                dataType: DataType.Double
            }
        ]
    });

    addMethod.bindMethod((inputArguments, context, callback) => {
        const a = inputArguments[0].value;
        const b = inputArguments[1].value;
        callback(null, {
            statusCode: StatusCodes.Good,
            outputArguments: [
                new Variant({ dataType: DataType.Double, value: a + b })
            ]
        });
    });

    // Multiply-Methode
    const multiplyMethod = ns.addMethod(methodFolder, {
        browseName: 'Multiply',
        nodeId: 's=Methods.Multiply',
        inputArguments: [
            { name: 'A', description: { text: 'Faktor A' }, dataType: DataType.Double },
            { name: 'B', description: { text: 'Faktor B' }, dataType: DataType.Double }
        ],
        outputArguments: [
            { name: 'Result', description: { text: 'Produkt' }, dataType: DataType.Double }
        ]
    });

    multiplyMethod.bindMethod((inputArguments, context, callback) => {
        const a = inputArguments[0].value;
        const b = inputArguments[1].value;
        callback(null, {
            statusCode: StatusCodes.Good,
            outputArguments: [
                new Variant({ dataType: DataType.Double, value: a * b })
            ]
        });
    });

    // Reset-Methode: setzt alle Writable-Variablen zurück
    const resetMethod = ns.addMethod(methodFolder, {
        browseName: 'ResetAll',
        nodeId: 's=Methods.ResetAll',
        inputArguments: [],
        outputArguments: [
            { name: 'Message', description: { text: 'Reset-Bestätigung' }, dataType: DataType.String }
        ]
    });

    resetMethod.bindMethod((inputArguments, context, callback) => {
        // Writable-Variablen auf Standardwerte zurücksetzen
        const tempNode = ns.findNode('s=Writable.Temperature');
        const pressNode = ns.findNode('s=Writable.Pressure');
        const setpNode = ns.findNode('s=Writable.SetPoint');
        const nameNode = ns.findNode('s=Writable.MachineName');
        const activeNode = ns.findNode('s=Writable.Active');
        const counterNode = ns.findNode('s=Writable.Counter');

        if (tempNode) tempNode.setValueFromSource(new Variant({ dataType: DataType.Double, value: 20.0 }));
        if (pressNode) pressNode.setValueFromSource(new Variant({ dataType: DataType.Double, value: 1013.25 }));
        if (setpNode) setpNode.setValueFromSource(new Variant({ dataType: DataType.Float, value: 75.0 }));
        if (nameNode) nameNode.setValueFromSource(new Variant({ dataType: DataType.String, value: 'Machine-001' }));
        if (activeNode) activeNode.setValueFromSource(new Variant({ dataType: DataType.Boolean, value: false }));
        if (counterNode) counterNode.setValueFromSource(new Variant({ dataType: DataType.Int32, value: 0 }));

        callback(null, {
            statusCode: StatusCodes.Good,
            outputArguments: [
                new Variant({ dataType: DataType.String, value: 'Alle Werte zurückgesetzt' })
            ]
        });
    });

    // ─── Maschinenstruktur (realistischeres Beispiel) ───

    const machineFolder = ns.addFolder(rootFolder, { browseName: 'Machine', nodeId: 's=Machine' });

    const motorFolder = ns.addFolder(machineFolder, { browseName: 'Motor', nodeId: 's=Machine.Motor' });
    ns.addVariable({ componentOf: motorFolder, browseName: 'Speed',       nodeId: 's=Machine.Motor.Speed',       dataType: DataType.Double,  value: new Variant({ dataType: DataType.Double,  value: 1500.0 }), writable: true });
    ns.addVariable({ componentOf: motorFolder, browseName: 'Current',     nodeId: 's=Machine.Motor.Current',     dataType: DataType.Double,  value: new Variant({ dataType: DataType.Double,  value: 4.2 }),    writable: true });
    ns.addVariable({ componentOf: motorFolder, browseName: 'Temperature', nodeId: 's=Machine.Motor.Temperature', dataType: DataType.Double,  value: new Variant({ dataType: DataType.Double,  value: 65.0 }),   writable: true });
    ns.addVariable({ componentOf: motorFolder, browseName: 'Running',     nodeId: 's=Machine.Motor.Running',     dataType: DataType.Boolean, value: new Variant({ dataType: DataType.Boolean, value: true }),    writable: true });

    const pumpFolder = ns.addFolder(machineFolder, { browseName: 'Pump', nodeId: 's=Machine.Pump' });
    ns.addVariable({ componentOf: pumpFolder, browseName: 'FlowRate',    nodeId: 's=Machine.Pump.FlowRate',    dataType: DataType.Double,  value: new Variant({ dataType: DataType.Double,  value: 120.5 }), writable: true });
    ns.addVariable({ componentOf: pumpFolder, browseName: 'Pressure',    nodeId: 's=Machine.Pump.Pressure',    dataType: DataType.Double,  value: new Variant({ dataType: DataType.Double,  value: 3.5 }),   writable: true });
    ns.addVariable({ componentOf: pumpFolder, browseName: 'ValveOpen',   nodeId: 's=Machine.Pump.ValveOpen',   dataType: DataType.Boolean, value: new Variant({ dataType: DataType.Boolean, value: true }),   writable: true });

    const sensorFolder = ns.addFolder(machineFolder, { browseName: 'Sensors', nodeId: 's=Machine.Sensors' });
    ns.addVariable({ componentOf: sensorFolder, browseName: 'AmbientTemp',  nodeId: 's=Machine.Sensors.AmbientTemp',  dataType: DataType.Double, value: new Variant({ dataType: DataType.Double, value: 22.5 }), writable: true });
    ns.addVariable({ componentOf: sensorFolder, browseName: 'Humidity',     nodeId: 's=Machine.Sensors.Humidity',     dataType: DataType.Double, value: new Variant({ dataType: DataType.Double, value: 45.0 }), writable: true });
    ns.addVariable({ componentOf: sensorFolder, browseName: 'Vibration',    nodeId: 's=Machine.Sensors.Vibration',    dataType: DataType.Double, value: new Variant({ dataType: DataType.Double, value: 0.3 }),  writable: true });

    // ─── Server starten ───

    await server.start();

    const endpointUrl = server.getEndpointUrl();

    // Collect supported auth methods from endpoints
    const endpoints = server.endpoints.flatMap(ep => ep.endpointDescriptions());
    const authTypes = new Set();
    for (const ep of endpoints) {
        for (const token of (ep.userIdentityTokens || [])) {
            const typeNames = { 0: 'Anonymous', 1: 'Username/Password', 2: 'X509 Certificate', 3: 'IssuedToken' };
            authTypes.add(typeNames[token.tokenType] || 'Unknown');
        }
    }
    const secModes = new Set(endpoints.map(ep => MessageSecurityMode[ep.securityMode]));
    const secPolicies = new Set(endpoints.map(ep => (ep.securityPolicyUri || '').split('#').pop()).filter(Boolean));

    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║           OPC UA Test Server gestartet                  ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Endpoint: ${endpointUrl.padEnd(44)}║`);
    console.log(`║  Port:     ${String(PORT).padEnd(44)}║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Authentication:                                        ║');
    for (const at of authTypes) {
        console.log(`║    ✓ ${at.padEnd(50)}║`);
    }
    console.log('║                                                         ║');
    console.log('║  Test Users (Username/Password):                        ║');
    console.log('║    admin    / admin123     (admin role)                  ║');
    console.log('║    operator / operator123  (operator role)               ║');
    console.log('║    viewer   / viewer123    (viewer role)                 ║');
    console.log('║                                                         ║');
    console.log('║  X509 Certificate:                                      ║');
    console.log('║    Auto-accept enabled (any valid cert accepted)        ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Security Modes:                                        ║');
    for (const sm of secModes) {
        console.log(`║    ✓ ${sm.padEnd(50)}║`);
    }
    console.log('║  Security Policies:                                     ║');
    for (const sp of secPolicies) {
        console.log(`║    ✓ ${sp.padEnd(50)}║`);
    }
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  Struktur:                                              ║');
    console.log('║    TestData/                                            ║');
    console.log('║      Scalar/     → Boolean, Int16..64, Float, String..  ║');
    console.log('║      Arrays/     → IntArray, DoubleArray, StringArray   ║');
    console.log('║      Dynamic/    → Sinus, Random, Toggle, Ramp (1s)    ║');
    console.log('║      Writable/   → Temperature, Pressure, SetPoint..   ║');
    console.log('║      Methods/    → Add, Multiply, ResetAll             ║');
    console.log('║    Machine/                                             ║');
    console.log('║      Motor/      → Speed, Current, Temperature         ║');
    console.log('║      Pump/       → FlowRate, Pressure, ValveOpen       ║');
    console.log('║      Sensors/    → AmbientTemp, Humidity, Vibration    ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`Total endpoints: ${endpoints.length}`);
    console.log('Dynamische Werte werden jede Sekunde aktualisiert.');
    console.log('Alle Variablen unter Writable/ und Machine/ sind beschreibbar.');
    console.log('');
    console.log('Ctrl+C zum Beenden.');

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\nServer wird gestoppt...');
        await server.shutdown();
        console.log('Server gestoppt.');
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await server.shutdown();
        process.exit(0);
    });
}

startServer().catch(err => {
    console.error('Fehler beim Starten:', err);
    process.exit(1);
});
