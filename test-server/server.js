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
  OPCUACertificateManager,
  coerceNodeId,
} = require("node-opcua");

const fs = require("fs");
const path = require("path");

const PORT = 4840;

// ─── Test Users for Username/Password Authentication ───
const TEST_USERS = {
  admin: { password: "admin123", role: "admin" },
  operator: { password: "operator123", role: "operator" },
  viewer: { password: "viewer123", role: "viewer" },
};

// ─── Certificate directories ───
const PKI_DIR = path.join(__dirname, "pki");
const CERTS_DIR = path.join(PKI_DIR, "certs");
const USER_CERTS_DIR = path.join(PKI_DIR, "user-certs");

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
    rootFolder: path.join(PKI_DIR, "server"),
  });
  await serverCertificateManager.initialize();

  // User certificate manager for X509 token validation
  const userCertificateManager = new OPCUACertificateManager({
    automaticallyAcceptUnknownCertificate: true,
    rootFolder: path.join(PKI_DIR, "user"),
  });
  await userCertificateManager.initialize();

  const server = new OPCUAServer({
    port: PORT,
    resourcePath: "/UA/TestServer",
    buildInfo: {
      productName: "OPC UA Test Server",
      buildNumber: "1.0.0",
      buildDate: new Date(),
    },
    serverInfo: {
      applicationUri: "urn:NodeRED:OPCUATestServer",
      productUri: "urn:NodeRED:OPCUATestServer",
      applicationName: { text: "OPC UA Test Server" },
    },
    maxAllowedSessionNumber: 50,
    maxConnectionsPerEndpoint: 50,

    // ─── Security: ALL modes and policies ───
    securityModes: [
      MessageSecurityMode.None,
      MessageSecurityMode.Sign,
      MessageSecurityMode.SignAndEncrypt,
    ],
    securityPolicies: [
      SecurityPolicy.None,
      SecurityPolicy.Basic256Sha256,
      SecurityPolicy.Aes128_Sha256_RsaOaep,
      SecurityPolicy.Aes256_Sha256_RsaPss,
    ],

    // ─── Authentication: ALL methods ───
    allowAnonymous: true,

    // Username/Password validation
    userManager: {
      isValidUser: function (userName, password) {
        const user = TEST_USERS[userName];
        return user !== undefined && user.password === password;
      },
    },

    // X509 Certificate validation
    userCertificateManager: userCertificateManager,

    // Server certificate manager
    serverCertificateManager: serverCertificateManager,
  });

  await server.initialize();

  const addressSpace = server.engine.addressSpace;
  const ns = addressSpace.getOwnNamespace();

  // ─── Ordnerstruktur ───

  const rootFolder = addressSpace.findNode("ObjectsFolder");

  const testFolder = ns.addFolder(rootFolder, {
    browseName: "TestData",
    nodeId: "s=TestData",
  });
  const scalarFolder = ns.addFolder(testFolder, {
    browseName: "Scalar",
    nodeId: "s=Scalar",
  });
  const arrayFolder = ns.addFolder(testFolder, {
    browseName: "Arrays",
    nodeId: "s=Arrays",
  });
  const dynamicFolder = ns.addFolder(testFolder, {
    browseName: "Dynamic",
    nodeId: "s=Dynamic",
  });
  const methodFolder = ns.addFolder(testFolder, {
    browseName: "Methods",
    nodeId: "s=Methods",
  });
  const structFolder = ns.addFolder(testFolder, {
    browseName: "Structure",
    nodeId: "s=Structure",
  });

  // ─── Skalare Variablen (alle wichtigen Datentypen) ───

  const scalars = [
    { name: "Boolean", dataType: DataType.Boolean, value: true },
    { name: "SByte", dataType: DataType.SByte, value: -42 },
    { name: "Byte", dataType: DataType.Byte, value: 200 },
    { name: "Int16", dataType: DataType.Int16, value: -1234 },
    { name: "UInt16", dataType: DataType.UInt16, value: 5678 },
    { name: "Int32", dataType: DataType.Int32, value: -100000 },
    { name: "UInt32", dataType: DataType.UInt32, value: 250000 },
    { name: "Float", dataType: DataType.Float, value: 3.14 },
    { name: "Double", dataType: DataType.Double, value: 2.718281828 },
    { name: "String", dataType: DataType.String, value: "Hello OPC UA" },
    { name: "DateTime", dataType: DataType.DateTime, value: new Date() },
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
      writable: true,
    });
  }

  // ─── Array-Variablen ───

  ns.addVariable({
    componentOf: arrayFolder,
    browseName: "IntArray",
    nodeId: "s=Arrays.IntArray",
    dataType: DataType.Int32,
    valueRank: 1,
    arrayDimensions: [5],
    value: new Variant({
      dataType: DataType.Int32,
      arrayType: VariantArrayType.Array,
      value: Int32Array.from([10, 20, 30, 40, 50]),
    }),
    writable: true,
  });

  ns.addVariable({
    componentOf: arrayFolder,
    browseName: "DoubleArray",
    nodeId: "s=Arrays.DoubleArray",
    dataType: DataType.Double,
    valueRank: 1,
    arrayDimensions: [4],
    value: new Variant({
      dataType: DataType.Double,
      arrayType: VariantArrayType.Array,
      value: Float64Array.from([1.1, 2.2, 3.3, 4.4]),
    }),
    writable: true,
  });

  ns.addVariable({
    componentOf: arrayFolder,
    browseName: "StringArray",
    nodeId: "s=Arrays.StringArray",
    dataType: DataType.String,
    valueRank: 1,
    arrayDimensions: [3],
    value: new Variant({
      dataType: DataType.String,
      arrayType: VariantArrayType.Array,
      value: ["Alpha", "Bravo", "Charlie"],
    }),
    writable: true,
  });

  ns.addVariable({
    componentOf: arrayFolder,
    browseName: "BoolArray",
    nodeId: "s=Arrays.BoolArray",
    dataType: DataType.Boolean,
    valueRank: 1,
    arrayDimensions: [4],
    value: new Variant({
      dataType: DataType.Boolean,
      arrayType: VariantArrayType.Array,
      value: [true, false, true, false],
    }),
    writable: true,
  });

  // ─── Dynamische Variablen (ändern sich zyklisch) ───

  let sineCounter = 0;
  let randomValue = 50;
  let toggleState = false;
  let rampValue = 0;

  const sinusVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "Sinus",
    nodeId: "s=Dynamic.Sinus",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 0 }),
  });

  const randomVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "Random",
    nodeId: "s=Dynamic.Random",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 50 }),
  });

  const toggleVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "Toggle",
    nodeId: "s=Dynamic.Toggle",
    dataType: DataType.Boolean,
    value: new Variant({ dataType: DataType.Boolean, value: false }),
  });

  const rampVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "Ramp",
    nodeId: "s=Dynamic.Ramp",
    dataType: DataType.Int32,
    value: new Variant({ dataType: DataType.Int32, value: 0 }),
  });

  const timestampVar = ns.addVariable({
    componentOf: dynamicFolder,
    browseName: "Timestamp",
    nodeId: "s=Dynamic.Timestamp",
    dataType: DataType.DateTime,
    value: new Variant({ dataType: DataType.DateTime, value: new Date() }),
  });

  // Werte alle 1s aktualisieren
  setInterval(() => {
    sineCounter += 0.1;
    randomValue += (Math.random() - 0.5) * 10;
    randomValue = Math.max(0, Math.min(100, randomValue));
    toggleState = !toggleState;
    rampValue = (rampValue + 1) % 100;

    sinusVar.setValueFromSource(
      new Variant({
        dataType: DataType.Double,
        value: Math.sin(sineCounter) * 100,
      }),
    );
    randomVar.setValueFromSource(
      new Variant({ dataType: DataType.Double, value: randomValue }),
    );
    toggleVar.setValueFromSource(
      new Variant({ dataType: DataType.Boolean, value: toggleState }),
    );
    rampVar.setValueFromSource(
      new Variant({ dataType: DataType.Int32, value: rampValue }),
    );
    timestampVar.setValueFromSource(
      new Variant({ dataType: DataType.DateTime, value: new Date() }),
    );
  }, 1000);

  // ─── Beschreibbare Variablen (für Write-Tests) ───

  const writableFolder = ns.addFolder(testFolder, {
    browseName: "Writable",
    nodeId: "s=Writable",
  });

  ns.addVariable({
    componentOf: writableFolder,
    browseName: "Temperature",
    nodeId: "s=Writable.Temperature",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 20.0 }),
    writable: true,
  });

  ns.addVariable({
    componentOf: writableFolder,
    browseName: "Pressure",
    nodeId: "s=Writable.Pressure",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 1013.25 }),
    writable: true,
  });

  ns.addVariable({
    componentOf: writableFolder,
    browseName: "SetPoint",
    nodeId: "s=Writable.SetPoint",
    dataType: DataType.Float,
    value: new Variant({ dataType: DataType.Float, value: 75.0 }),
    writable: true,
  });

  ns.addVariable({
    componentOf: writableFolder,
    browseName: "MachineName",
    nodeId: "s=Writable.MachineName",
    dataType: DataType.String,
    value: new Variant({ dataType: DataType.String, value: "Machine-001" }),
    writable: true,
  });

  ns.addVariable({
    componentOf: writableFolder,
    browseName: "Active",
    nodeId: "s=Writable.Active",
    dataType: DataType.Boolean,
    value: new Variant({ dataType: DataType.Boolean, value: false }),
    writable: true,
  });

  ns.addVariable({
    componentOf: writableFolder,
    browseName: "Counter",
    nodeId: "s=Writable.Counter",
    dataType: DataType.Int32,
    value: new Variant({ dataType: DataType.Int32, value: 0 }),
    writable: true,
  });

  // ─── Methoden ───

  // Add-Methode: addiert zwei Zahlen
  const addMethod = ns.addMethod(methodFolder, {
    browseName: "Add",
    nodeId: "s=Methods.Add",
    inputArguments: [
      {
        name: "A",
        description: { text: "Erster Operand" },
        dataType: DataType.Double,
      },
      {
        name: "B",
        description: { text: "Zweiter Operand" },
        dataType: DataType.Double,
      },
    ],
    outputArguments: [
      {
        name: "Result",
        description: { text: "Summe von A und B" },
        dataType: DataType.Double,
      },
    ],
  });

  addMethod.bindMethod((inputArguments, context, callback) => {
    const a = inputArguments[0].value;
    const b = inputArguments[1].value;
    callback(null, {
      statusCode: StatusCodes.Good,
      outputArguments: [
        new Variant({ dataType: DataType.Double, value: a + b }),
      ],
    });
  });

  // Multiply-Methode
  const multiplyMethod = ns.addMethod(methodFolder, {
    browseName: "Multiply",
    nodeId: "s=Methods.Multiply",
    inputArguments: [
      {
        name: "A",
        description: { text: "Faktor A" },
        dataType: DataType.Double,
      },
      {
        name: "B",
        description: { text: "Faktor B" },
        dataType: DataType.Double,
      },
    ],
    outputArguments: [
      {
        name: "Result",
        description: { text: "Produkt" },
        dataType: DataType.Double,
      },
    ],
  });

  multiplyMethod.bindMethod((inputArguments, context, callback) => {
    const a = inputArguments[0].value;
    const b = inputArguments[1].value;
    callback(null, {
      statusCode: StatusCodes.Good,
      outputArguments: [
        new Variant({ dataType: DataType.Double, value: a * b }),
      ],
    });
  });

  // KillSessions-Methode: schließt alle aktiven Sessions serverseitig
  // Simuliert den Fehler "Session is no longer valid" auf der Client-Seite
  // ohne den Server komplett neu zu starten.
  const killSessionsMethod = ns.addMethod(methodFolder, {
    browseName: "KillSessions",
    nodeId: "s=Methods.KillSessions",
    inputArguments: [],
    outputArguments: [
      {
        name: "ClosedCount",
        description: { text: "Anzahl geschlossener Sessions" },
        dataType: DataType.UInt32,
      },
    ],
  });

  killSessionsMethod.bindMethod(async (inputArguments, context, callback) => {
    const engine = server.engine;
    const sessions = Array.from(engine._sessions ? Object.values(engine._sessions) : []);
    let closed = 0;
    for (const session of sessions) {
      try {
        engine.closeSession(session.authenticationToken, true, "Terminated");
        closed++;
      } catch (_) { /* ignore */ }
    }
    console.log(`[KillSessions] Killed ${closed} session(s) on request`);
    callback(null, {
      statusCode: StatusCodes.Good,
      outputArguments: [
        new Variant({ dataType: DataType.UInt32, value: closed }),
      ],
    });
  });

  // Reset-Methode: setzt alle Writable-Variablen zurück
  const resetMethod = ns.addMethod(methodFolder, {
    browseName: "ResetAll",
    nodeId: "s=Methods.ResetAll",
    inputArguments: [],
    outputArguments: [
      {
        name: "Message",
        description: { text: "Reset-Bestätigung" },
        dataType: DataType.String,
      },
    ],
  });

  resetMethod.bindMethod((inputArguments, context, callback) => {
    // Writable-Variablen auf Standardwerte zurücksetzen
    const tempNode = ns.findNode("s=Writable.Temperature");
    const pressNode = ns.findNode("s=Writable.Pressure");
    const setpNode = ns.findNode("s=Writable.SetPoint");
    const nameNode = ns.findNode("s=Writable.MachineName");
    const activeNode = ns.findNode("s=Writable.Active");
    const counterNode = ns.findNode("s=Writable.Counter");

    if (tempNode)
      tempNode.setValueFromSource(
        new Variant({ dataType: DataType.Double, value: 20.0 }),
      );
    if (pressNode)
      pressNode.setValueFromSource(
        new Variant({ dataType: DataType.Double, value: 1013.25 }),
      );
    if (setpNode)
      setpNode.setValueFromSource(
        new Variant({ dataType: DataType.Float, value: 75.0 }),
      );
    if (nameNode)
      nameNode.setValueFromSource(
        new Variant({ dataType: DataType.String, value: "Machine-001" }),
      );
    if (activeNode)
      activeNode.setValueFromSource(
        new Variant({ dataType: DataType.Boolean, value: false }),
      );
    if (counterNode)
      counterNode.setValueFromSource(
        new Variant({ dataType: DataType.Int32, value: 0 }),
      );

    callback(null, {
      statusCode: StatusCodes.Good,
      outputArguments: [
        new Variant({
          dataType: DataType.String,
          value: "Alle Werte zurückgesetzt",
        }),
      ],
    });
  });

  // ─── Maschinenstruktur (realistischeres Beispiel) ───

  const machineFolder = ns.addFolder(rootFolder, {
    browseName: "Machine",
    nodeId: "s=Machine",
  });

  const motorFolder = ns.addFolder(machineFolder, {
    browseName: "Motor",
    nodeId: "s=Machine.Motor",
  });
  ns.addVariable({
    componentOf: motorFolder,
    browseName: "Speed",
    nodeId: "s=Machine.Motor.Speed",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 1500.0 }),
    writable: true,
  });
  ns.addVariable({
    componentOf: motorFolder,
    browseName: "Current",
    nodeId: "s=Machine.Motor.Current",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 4.2 }),
    writable: true,
  });
  ns.addVariable({
    componentOf: motorFolder,
    browseName: "Temperature",
    nodeId: "s=Machine.Motor.Temperature",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 65.0 }),
    writable: true,
  });
  ns.addVariable({
    componentOf: motorFolder,
    browseName: "Running",
    nodeId: "s=Machine.Motor.Running",
    dataType: DataType.Boolean,
    value: new Variant({ dataType: DataType.Boolean, value: true }),
    writable: true,
  });

  const pumpFolder = ns.addFolder(machineFolder, {
    browseName: "Pump",
    nodeId: "s=Machine.Pump",
  });
  ns.addVariable({
    componentOf: pumpFolder,
    browseName: "FlowRate",
    nodeId: "s=Machine.Pump.FlowRate",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 120.5 }),
    writable: true,
  });
  ns.addVariable({
    componentOf: pumpFolder,
    browseName: "Pressure",
    nodeId: "s=Machine.Pump.Pressure",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 3.5 }),
    writable: true,
  });
  ns.addVariable({
    componentOf: pumpFolder,
    browseName: "ValveOpen",
    nodeId: "s=Machine.Pump.ValveOpen",
    dataType: DataType.Boolean,
    value: new Variant({ dataType: DataType.Boolean, value: true }),
    writable: true,
  });

  const sensorFolder = ns.addFolder(machineFolder, {
    browseName: "Sensors",
    nodeId: "s=Machine.Sensors",
  });
  ns.addVariable({
    componentOf: sensorFolder,
    browseName: "AmbientTemp",
    nodeId: "s=Machine.Sensors.AmbientTemp",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 22.5 }),
    writable: true,
  });
  ns.addVariable({
    componentOf: sensorFolder,
    browseName: "Humidity",
    nodeId: "s=Machine.Sensors.Humidity",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 45.0 }),
    writable: true,
  });
  ns.addVariable({
    componentOf: sensorFolder,
    browseName: "Vibration",
    nodeId: "s=Machine.Sensors.Vibration",
    dataType: DataType.Double,
    value: new Variant({ dataType: DataType.Double, value: 0.3 }),
    writable: true,
  });

  // ─── ExtensionObject / Structured Types ───
  //
  // node-opcua v2.x workflow:
  //   1. ns.createDataType({ ..., partialDefinition: [...] })  — creates the type
  //   2. Add a "Default Binary" encoding node + HasEncoding reference
  //   3. Clear the internal cache so the encoding is found
  //   4. dtm.getExtensionObjectConstructorFromDataTypeAsync()  — registers the JS constructor
  //   5. addressSpace.constructExtensionObject()               — creates instances
  //   6. Patch schema.encodingDefaultBinary so the server can serialize the value
  //

  const dtm = addressSpace.getDataTypeManager();

  /**
   * Helper: fully registers a custom structured DataType so it can be
   * constructed, serialized over the wire and read/written by clients.
   */
  async function registerStructuredType(dataType) {
    // 1. Add a "Default Binary" encoding node (required for OPC UA binary transport)
    const encNode = ns.addObject({ browseName: "Default Binary" });
    dataType.addReference({
      referenceType: "HasEncoding",
      isForward: true,
      nodeId: encNode.nodeId,
    });
    // 2. Invalidate the internal encoding cache so the new reference is picked up
    if (dataType._cache) {
      dataType._cache._encoding = undefined;
    }
    // 3. Register the JS constructor in the DataType factory
    await dtm.getExtensionObjectConstructorFromDataTypeAsync(dataType.nodeId);
  }

  /**
   * Helper: construct an ExtensionObject and make sure the schema's
   * encodingDefaultBinary points to the actual encoding node so the
   * server can serialize it on the wire.
   */
  function createExtObj(dataType, fields) {
    const obj = addressSpace.constructExtensionObject(dataType.nodeId, fields);
    // Patch: the schema may have encodingDefaultBinary = NodeId(0,0) which
    // causes "Cannot find encodingDefaultBinary" on serialization.
    if (
      obj.schema &&
      (!obj.schema.encodingDefaultBinary ||
        obj.schema.encodingDefaultBinary.isEmpty())
    ) {
      const encId = dataType.binaryEncodingNodeId;
      if (encId) {
        obj.schema.encodingDefaultBinary = encId;
      }
    }
    return obj;
  }

  // ── 1. SensorReading — a simple struct with 5 fields ──

  const sensorReadingType = ns.createDataType({
    browseName: "SensorReadingType",
    nodeId: "s=SensorReadingType",
    isAbstract: false,
    subtypeOf: "Structure",
    partialDefinition: [
      { name: "Temperature", dataType: DataType.Double },
      { name: "Humidity", dataType: DataType.Double },
      { name: "Pressure", dataType: DataType.Double },
      { name: "SensorId", dataType: DataType.String },
      { name: "Timestamp", dataType: DataType.DateTime },
    ],
  });
  await registerStructuredType(sensorReadingType);

  const sensorReadingValue = createExtObj(sensorReadingType, {
    temperature: 22.5,
    humidity: 48.3,
    pressure: 1013.25,
    sensorId: "SENSOR-001",
    timestamp: new Date(),
  });

  /**
   * Helper: add an ExtensionObject variable AND expose each field as an
   * individually browsable / subscribable child Variable (via HasComponent).
   *
   * The child variables stay in sync with the parent ExtensionObject:
   *   - Reading a child reads the current field value from the parent.
   *   - Writing a child updates the field inside the parent ExtensionObject.
   *
   * Returns { parentVar, childVars: { fieldName: UAVariable, ... } }
   */
  function addExtensionObjectWithComponents(opts) {
    const {
      componentOf,
      browseName,
      nodeId,
      dataType,
      extObj,
      fieldDefinitions,
    } = opts;

    // 1. Create the parent ExtensionObject variable
    const parentVar = ns.addVariable({
      componentOf,
      browseName,
      nodeId,
      dataType: dataType.nodeId,
      value: new Variant({
        dataType: DataType.ExtensionObject,
        value: extObj,
      }),
      writable: true,
    });

    // 2. For each field, add a child variable with a getter/setter
    //    that reads/writes through the parent's ExtensionObject value
    const childVars = {};
    for (const fieldDef of fieldDefinitions) {
      const fieldName = fieldDef.name;
      // Field names in the ExtensionObject use lowerCamelCase
      const propName = fieldName.charAt(0).toLowerCase() + fieldName.slice(1);
      const fieldDataType = fieldDef.dataType;
      const childNodeId = nodeId + "." + fieldName;

      const childVar = ns.addVariable({
        componentOf: parentVar,
        browseName: fieldName,
        nodeId: childNodeId,
        dataType: fieldDataType,
        minimumSamplingInterval: 100,
        value: {
          get: function () {
            const ext = parentVar.readValue().value.value;
            const val = ext ? ext[propName] : null;
            return new Variant({
              dataType: fieldDataType,
              value: val !== undefined ? val : null,
            });
          },
          set: function (variant) {
            const ext = parentVar.readValue().value.value;
            if (ext) {
              ext[propName] = variant.value;
              parentVar.setValueFromSource(
                new Variant({
                  dataType: DataType.ExtensionObject,
                  value: ext,
                }),
              );
            }
            return StatusCodes.Good;
          },
        },
      });
      childVars[fieldName] = childVar;
    }

    return { parentVar, childVars };
  }

  const sensorReadingFields = [
    { name: "Temperature", dataType: DataType.Double },
    { name: "Humidity", dataType: DataType.Double },
    { name: "Pressure", dataType: DataType.Double },
    { name: "SensorId", dataType: DataType.String },
    { name: "Timestamp", dataType: DataType.DateTime },
  ];

  addExtensionObjectWithComponents({
    componentOf: structFolder,
    browseName: "SensorReading",
    nodeId: "s=Structure.SensorReading",
    dataType: sensorReadingType,
    extObj: sensorReadingValue,
    fieldDefinitions: sensorReadingFields,
  });

  // ── 2. MachineStatus — a more complex struct with 6 fields ──

  const machineStatusType = ns.createDataType({
    browseName: "MachineStatusType",
    nodeId: "s=MachineStatusType",
    isAbstract: false,
    subtypeOf: "Structure",
    partialDefinition: [
      { name: "State", dataType: DataType.String },
      { name: "ErrorCode", dataType: DataType.UInt32 },
      { name: "OperatingHours", dataType: DataType.Double },
      { name: "IsRunning", dataType: DataType.Boolean },
      { name: "ProductCount", dataType: DataType.UInt32 },
      { name: "LastService", dataType: DataType.DateTime },
    ],
  });
  await registerStructuredType(machineStatusType);

  const machineStatusValue = createExtObj(machineStatusType, {
    state: "Running",
    errorCode: 0,
    operatingHours: 1234.5,
    isRunning: true,
    productCount: 45678,
    lastService: new Date("2025-02-15T08:00:00Z"),
  });

  const machineStatusFields = [
    { name: "State", dataType: DataType.String },
    { name: "ErrorCode", dataType: DataType.UInt32 },
    { name: "OperatingHours", dataType: DataType.Double },
    { name: "IsRunning", dataType: DataType.Boolean },
    { name: "ProductCount", dataType: DataType.UInt32 },
    { name: "LastService", dataType: DataType.DateTime },
  ];

  addExtensionObjectWithComponents({
    componentOf: structFolder,
    browseName: "MachineStatus",
    nodeId: "s=Structure.MachineStatus",
    dataType: machineStatusType,
    extObj: machineStatusValue,
    fieldDefinitions: machineStatusFields,
  });

  // ── 3. Array of SensorReadings ──

  const sensorReadingArray = [
    createExtObj(sensorReadingType, {
      temperature: 22.5,
      humidity: 48.3,
      pressure: 1013.25,
      sensorId: "SENSOR-001",
      timestamp: new Date(),
    }),
    createExtObj(sensorReadingType, {
      temperature: 19.8,
      humidity: 55.1,
      pressure: 1012.8,
      sensorId: "SENSOR-002",
      timestamp: new Date(),
    }),
    createExtObj(sensorReadingType, {
      temperature: 25.2,
      humidity: 42.7,
      pressure: 1014.1,
      sensorId: "SENSOR-003",
      timestamp: new Date(),
    }),
  ];

  ns.addVariable({
    componentOf: structFolder,
    browseName: "SensorReadingArray",
    nodeId: "s=Structure.SensorReadingArray",
    dataType: sensorReadingType.nodeId,
    valueRank: 1,
    arrayDimensions: [3],
    value: new Variant({
      dataType: DataType.ExtensionObject,
      arrayType: VariantArrayType.Array,
      value: sensorReadingArray,
    }),
    writable: true,
  });

  console.log(
    "  ✓ ExtensionObject types registered: SensorReadingType, MachineStatusType",
  );
  console.log(
    "  ✓ Structure variables: SensorReading, MachineStatus, SensorReadingArray",
  );

  // ─── Server starten ───

  await server.start();

  const endpointUrl = server.getEndpointUrl();

  // Collect supported auth methods from endpoints
  const endpoints = server.endpoints.flatMap((ep) => ep.endpointDescriptions());
  const authTypes = new Set();
  for (const ep of endpoints) {
    for (const token of ep.userIdentityTokens || []) {
      const typeNames = {
        0: "Anonymous",
        1: "Username/Password",
        2: "X509 Certificate",
        3: "IssuedToken",
      };
      authTypes.add(typeNames[token.tokenType] || "Unknown");
    }
  }
  const secModes = new Set(
    endpoints.map((ep) => MessageSecurityMode[ep.securityMode]),
  );
  const secPolicies = new Set(
    endpoints
      .map((ep) => (ep.securityPolicyUri || "").split("#").pop())
      .filter(Boolean),
  );

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║           OPC UA Test Server gestartet                  ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Endpoint: ${endpointUrl.padEnd(44)}║`);
  console.log(`║  Port:     ${String(PORT).padEnd(44)}║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Authentication:                                        ║");
  for (const at of authTypes) {
    console.log(`║    ✓ ${at.padEnd(50)}║`);
  }
  console.log("║                                                         ║");
  console.log("║  Test Users (Username/Password):                        ║");
  console.log("║    admin    / admin123     (admin role)                  ║");
  console.log("║    operator / operator123  (operator role)               ║");
  console.log("║    viewer   / viewer123    (viewer role)                 ║");
  console.log("║                                                         ║");
  console.log("║  X509 Certificate:                                      ║");
  console.log("║    Auto-accept enabled (any valid cert accepted)        ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Security Modes:                                        ║");
  for (const sm of secModes) {
    console.log(`║    ✓ ${sm.padEnd(50)}║`);
  }
  console.log("║  Security Policies:                                     ║");
  for (const sp of secPolicies) {
    console.log(`║    ✓ ${sp.padEnd(50)}║`);
  }
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Struktur:                                              ║");
  console.log("║    TestData/                                            ║");
  console.log("║      Scalar/     → Boolean, Int16..64, Float, String..  ║");
  console.log("║      Arrays/     → IntArray, DoubleArray, StringArray   ║");
  console.log("║      Dynamic/    → Sinus, Random, Toggle, Ramp (1s)    ║");
  console.log("║      Writable/   → Temperature, Pressure, SetPoint..   ║");
  console.log("║      Methods/    → Add, Multiply, ResetAll             ║");
  console.log("║      Structure/  → SensorReading, MachineStatus,       ║");
  console.log("║                    SensorReadingArray (ExtensionObject) ║");
  console.log("║    Machine/                                             ║");
  console.log("║      Motor/      → Speed, Current, Temperature         ║");
  console.log("║      Pump/       → FlowRate, Pressure, ValveOpen       ║");
  console.log("║      Sensors/    → AmbientTemp, Humidity, Vibration    ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`Total endpoints: ${endpoints.length}`);
  console.log("Dynamische Werte werden jede Sekunde aktualisiert.");
  console.log("Alle Variablen unter Writable/ und Machine/ sind beschreibbar.");
  console.log("");
  console.log("Ctrl+C zum Beenden.");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nServer wird gestoppt...");
    await server.shutdown();
    console.log("Server gestoppt.");
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.shutdown();
    process.exit(0);
  });
}

startServer().catch((err) => {
  console.error("Fehler beim Starten:", err);
  process.exit(1);
});
