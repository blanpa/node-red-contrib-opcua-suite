"use strict";

/**
 * MqttTransport test suite (TRP-02).
 *
 * The `mqtt` npm module is mocked by overwriting its require.cache entry with a
 * stub `{ connect }` before MqttTransport is loaded. This is the same cache-injection
 * mechanism established in test/connection-sharing.test.js (Module-level require
 * interception) — here we resolve the real "mqtt" path and replace its cached
 * exports so `const mqtt = require("mqtt")` inside the transport observes the stub.
 *
 * No real network calls are made: mockMqtt.connect returns a MockMqttClient
 * (an EventEmitter) and records (brokerUrl, opts). All tests use reconnectPeriod: 0
 * to guarantee the library would never schedule a reconnect even if it were real.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const EventEmitter = require("events");

// ---- mqtt module mock (cache injection) -------------------------------------
const mqttPath = require.resolve("mqtt");
const mockMqtt = { connect: sinon.stub() };

/**
 * Minimal mqtt.js client stand-in. EventEmitter so the transport's
 * client.on(...) handlers fire when a test emits the native event.
 */
class MockMqttClient extends EventEmitter {
  constructor() {
    super();
    this.publish = sinon.stub();
    this.subscribe = sinon.stub();
    // end(force, opts, cb) — cb is zero-args per mqtt.js (Pitfall 4).
    this.end = sinon.stub().callsFake((force, opts, cb) => {
      setImmediate(() => cb && cb());
    });
  }
}

let MqttTransport;
let BaseTransport;

before(function () {
  require.cache[mqttPath] = {
    id: mqttPath,
    filename: mqttPath,
    loaded: true,
    exports: mockMqtt,
  };
  // Load AFTER the cache is poisoned so the transport binds to the stub.
  MqttTransport = require("../../lib/transports/mqtt-transport").MqttTransport;
  BaseTransport = require("../../lib/transports/base-transport").BaseTransport;
});

after(function () {
  delete require.cache[mqttPath];
});

beforeEach(function () {
  mockMqtt.connect.reset();
});

/** Helper: make connect() return a fresh mock client and wire it to auto-connect. */
function stubClient() {
  const client = new MockMqttClient();
  mockMqtt.connect.returns(client);
  return client;
}

function baseConfig(overrides) {
  return Object.assign(
    {
      brokerUrl: "mqtt://localhost:1883",
      qos: 1,
      topicPrefix: "ua",
      publisherId: "my-pub",
      reconnectPeriod: 0,
    },
    overrides || {}
  );
}

describe("MqttTransport — connect/close + event mapping + 5→4 fallback (TRP-02)", function () {
  it("1. extends BaseTransport (instanceof check)", function () {
    const t = new MqttTransport(baseConfig());
    expect(t).to.be.instanceOf(BaseTransport);
  });

  it("2. connect() calls mqtt.connect(brokerUrl, opts) with protocolVersion: 5", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig());
    const p = t.connect();
    client.emit("connect");
    await p;
    expect(mockMqtt.connect.calledOnce).to.equal(true);
    expect(
      mockMqtt.connect.calledWith(
        "mqtt://localhost:1883",
        sinon.match({ protocolVersion: 5 })
      )
    ).to.equal(true);
    expect(t._client).to.equal(client);
  });

  it("3. opts include username/password when provided; absent when both empty (anonymous)", async function () {
    // With credentials
    let client = stubClient();
    let t = new MqttTransport(baseConfig({ username: "u", password: "p" }));
    let p = t.connect();
    client.emit("connect");
    await p;
    let opts = mockMqtt.connect.firstCall.args[1];
    expect(opts.username).to.equal("u");
    expect(opts.password).to.equal("p");

    // Anonymous
    mockMqtt.connect.reset();
    client = stubClient();
    t = new MqttTransport(baseConfig({ username: "", password: "" }));
    p = t.connect();
    client.emit("connect");
    await p;
    opts = mockMqtt.connect.firstCall.args[1];
    expect(opts).to.not.have.property("username");
    expect(opts).to.not.have.property("password");
  });

  it("4. opts include reconnectPeriod from config (default 5000; 0 in tests)", async function () {
    let client = stubClient();
    let t = new MqttTransport(baseConfig({ reconnectPeriod: 0 }));
    let p = t.connect();
    client.emit("connect");
    await p;
    expect(mockMqtt.connect.firstCall.args[1].reconnectPeriod).to.equal(0);

    // Default when unset
    mockMqtt.connect.reset();
    client = stubClient();
    const cfg = baseConfig();
    delete cfg.reconnectPeriod;
    t = new MqttTransport(cfg);
    p = t.connect();
    client.emit("connect");
    await p;
    expect(mockMqtt.connect.firstCall.args[1].reconnectPeriod).to.equal(5000);
  });

  it("5. opts NEVER include rejectUnauthorized:false (T-03-02 TLS bypass guard)", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig({ rejectUnauthorized: false }));
    const p = t.connect();
    client.emit("connect");
    await p;
    const opts = mockMqtt.connect.firstCall.args[1];
    expect(opts.rejectUnauthorized).to.equal(undefined);
  });

  it("6. native 'connect' fires 'connected' on the transport", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig());
    let fired = 0;
    t.on("connected", () => fired++);
    const p = t.connect();
    client.emit("connect");
    await p;
    expect(fired).to.equal(1);
  });

  it("7. native 'close' fires 'disconnected'", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig());
    const p = t.connect();
    client.emit("connect");
    await p;
    let fired = 0;
    t.on("disconnected", () => fired++);
    client.emit("close");
    expect(fired).to.equal(1);
  });

  it("8. native 'reconnect' fires 'reconnecting'", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig());
    const p = t.connect();
    client.emit("connect");
    await p;
    let fired = 0;
    t.on("reconnecting", () => fired++);
    client.emit("reconnect");
    expect(fired).to.equal(1);
  });

  it("9. native 'error' fires 'error' (post-connect, non-fallback case)", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig());
    const p = t.connect();
    client.emit("connect");
    await p;
    let captured = null;
    t.on("error", (e) => (captured = e));
    const err = new Error("some broker hiccup");
    client.emit("error", err);
    expect(captured).to.equal(err);
  });

  it("10. native 'message' fires 'message' with (payload, { topic, packet })", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig());
    const p = t.connect();
    client.emit("connect");
    await p;
    let args = null;
    t.on("message", (payload, meta) => (args = { payload, meta }));
    const buf = Buffer.from([9, 8, 7]);
    const packet = { qos: 1 };
    client.emit("message", "ua/my-pub/1/2", buf, packet);
    expect(args.payload).to.equal(buf);
    expect(args.meta.topic).to.equal("ua/my-pub/1/2");
    expect(args.meta.packet).to.equal(packet);
  });

  it("11. MQTT 5.0 → 3.1.1 fallback on protocol-rejection error before connect", async function () {
    const v5 = new MockMqttClient();
    const v4 = new MockMqttClient();
    mockMqtt.connect.onCall(0).returns(v5);
    mockMqtt.connect.onCall(1).returns(v4);

    const t = new MqttTransport(baseConfig());
    let connectedCount = 0;
    t.on("connected", () => connectedCount++);
    const p = t.connect();

    v5.emit("error", new Error("unsupported protocol version"));
    // fallback should have invoked a second connect with protocolVersion 4
    v4.emit("connect");
    await p;

    expect(mockMqtt.connect.callCount).to.equal(2);
    expect(mockMqtt.connect.firstCall.args[1].protocolVersion).to.equal(5);
    expect(mockMqtt.connect.secondCall.args[1].protocolVersion).to.equal(4);
    expect(connectedCount).to.equal(1);
    expect(t._client).to.equal(v4);
  });

  it("11b. fallback fires on alternate broker error texts (Mosquitto/HiveMQ/EMQX)", async function () {
    const variants = [
      "Unacceptable protocol version",
      "Protocol version not supported",
      "unsupported protocol",
    ];
    for (const msg of variants) {
      mockMqtt.connect.reset();
      const v5 = new MockMqttClient();
      const v4 = new MockMqttClient();
      mockMqtt.connect.onCall(0).returns(v5);
      mockMqtt.connect.onCall(1).returns(v4);

      const t = new MqttTransport(baseConfig());
      const p = t.connect();
      v5.emit("error", new Error(msg));
      v4.emit("connect");
      await p;
      expect(
        mockMqtt.connect.callCount,
        `variant "${msg}" should trigger fallback`
      ).to.equal(2);
      expect(mockMqtt.connect.secondCall.args[1].protocolVersion).to.equal(4);
    }
  });

  it("12. fallback runs at most once; second failure propagates as 'error'", async function () {
    const v5 = new MockMqttClient();
    const v4 = new MockMqttClient();
    mockMqtt.connect.onCall(0).returns(v5);
    mockMqtt.connect.onCall(1).returns(v4);

    const t = new MqttTransport(baseConfig());
    let errored = null;
    t.on("error", (e) => (errored = e));

    t.connect();
    v5.emit("error", new Error("unsupported protocol version"));
    const secondErr = new Error("unsupported protocol version");
    v4.emit("error", secondErr);

    expect(mockMqtt.connect.callCount).to.equal(2);
    expect(errored).to.equal(secondErr);
  });

  it("12b. fallback flag resets on close() — a later connect() can fall back again", async function () {
    const v5a = new MockMqttClient();
    const v4a = new MockMqttClient();
    mockMqtt.connect.onCall(0).returns(v5a);
    mockMqtt.connect.onCall(1).returns(v4a);

    const t = new MqttTransport(baseConfig());
    let p = t.connect();
    v5a.emit("error", new Error("unsupported protocol version"));
    v4a.emit("connect");
    await p;
    expect(t._protocolFallbackDone).to.equal(true);

    await t.close();
    expect(t._protocolFallbackDone).to.equal(false);

    // Second session — v5 rejects again, should fall back once more.
    const v5b = new MockMqttClient();
    const v4b = new MockMqttClient();
    mockMqtt.connect.onCall(2).returns(v5b);
    mockMqtt.connect.onCall(3).returns(v4b);
    p = t.connect();
    v5b.emit("error", new Error("unsupported protocol version"));
    v4b.emit("connect");
    await p;
    expect(mockMqtt.connect.callCount).to.equal(4);
    expect(mockMqtt.connect.getCall(3).args[1].protocolVersion).to.equal(4);
  });

  it("13. close() calls client.end(false, {}, cb) and resolves on cb", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig());
    const p = t.connect();
    client.emit("connect");
    await p;
    await t.close();
    expect(
      client.end.calledWith(false, sinon.match.object, sinon.match.func)
    ).to.equal(true);
  });

  it("14. close() is idempotent — second call resolves without throwing", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig());
    const p = t.connect();
    client.emit("connect");
    await p;
    await t.close();
    await t.close(); // must not throw
    expect(t._client).to.equal(null);
  });

  it("15. close() nulls _client", async function () {
    const client = stubClient();
    const t = new MqttTransport(baseConfig());
    const p = t.connect();
    client.emit("connect");
    await p;
    await t.close();
    expect(t._client).to.equal(null);
  });
});

describe("send() — TRP-02 + topic-injection guard", function () {
  /** Build a connected transport with a fresh mock client ready for publish assertions. */
  async function connected(configOverrides) {
    const client = stubClient();
    const t = new MqttTransport(baseConfig(configOverrides));
    const p = t.connect();
    client.emit("connect");
    await p;
    return { t, client };
  }

  it("16. send(Buffer) publishes once with topic prefix/pub/wg/dsw", async function () {
    const { t, client } = await connected();
    const buf = Buffer.from([1, 2, 3]);
    t.send(buf, { writerGroupId: 1, dataSetWriterId: 2 });
    expect(client.publish.calledOnce).to.equal(true);
    expect(client.publish.firstCall.args[0]).to.equal("ua/my-pub/1/2");
    expect(client.publish.firstCall.args[1]).to.equal(buf);
  });

  it("17. send() ALWAYS publishes with retain:false even when opts.retain=true (T-03-06)", async function () {
    const { t, client } = await connected();
    t.send(Buffer.from([1]), {
      writerGroupId: 1,
      dataSetWriterId: 2,
      retain: true,
    });
    expect(client.publish.firstCall.args[2].retain).to.equal(false);
  });

  it("18. send() qos: opts.qos > config.qos > default 1", async function () {
    // opts.qos wins
    let ctx = await connected({ qos: 1 });
    ctx.t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2, qos: 2 });
    expect(ctx.client.publish.firstCall.args[2].qos).to.equal(2);

    // config.qos when no opts.qos
    ctx = await connected({ qos: 2 });
    ctx.t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2 });
    expect(ctx.client.publish.firstCall.args[2].qos).to.equal(2);

    // default 1 when neither
    const cfg = baseConfig();
    delete cfg.qos;
    ctx = await (async () => {
      const client = stubClient();
      const t = new MqttTransport(cfg);
      const p = t.connect();
      client.emit("connect");
      await p;
      return { t, client };
    })();
    ctx.t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2 });
    expect(ctx.client.publish.firstCall.args[2].qos).to.equal(1);
  });

  it("19. send(Buffer[]) publishes N times in array order", async function () {
    const { t, client } = await connected();
    const bufs = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])];
    t.send(bufs, { writerGroupId: 1, dataSetWriterId: 2 });
    expect(client.publish.callCount).to.equal(3);
    expect(client.publish.getCall(0).args[1]).to.equal(bufs[0]);
    expect(client.publish.getCall(1).args[1]).to.equal(bufs[1]);
    expect(client.publish.getCall(2).args[1]).to.equal(bufs[2]);
  });

  it("20. send() with publisherId containing '/' THROWS and does NOT publish (T-03-04)", async function () {
    const { t, client } = await connected();
    t.config.publisherId = "evil/path";
    expect(() => t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2 })).to.throw(
      /TOPIC_INVALID_CHARACTER/
    );
    expect(client.publish.notCalled).to.equal(true);
  });

  it("21. send() with publisherId containing '+' or '#' THROWS (wildcard injection)", async function () {
    let ctx = await connected();
    ctx.t.config.publisherId = "a+b";
    expect(() => ctx.t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2 })).to.throw(
      /TOPIC_INVALID_CHARACTER/
    );

    ctx = await connected();
    ctx.t.config.publisherId = "a#b";
    expect(() => ctx.t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2 })).to.throw(
      /TOPIC_INVALID_CHARACTER/
    );
  });

  it("22. send() with publisherId containing control char (\\x00) THROWS", async function () {
    const { t } = await connected();
    t.config.publisherId = "abc" + String.fromCharCode(0) + "def";
    expect(() => t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2 })).to.throw(
      /TOPIC_INVALID_CHARACTER/
    );
  });

  it("23. send() with empty/undefined writerGroupId THROWS", async function () {
    const { t } = await connected();
    expect(() => t.send(Buffer.from([1]), {})).to.throw(/TOPIC_INVALID_CHARACTER/);
  });

  it("24. send() with topicPrefix containing '/' THROWS", async function () {
    const { t } = await connected();
    t.config.topicPrefix = "a/b";
    expect(() => t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2 })).to.throw(
      /TOPIC_INVALID_CHARACTER/
    );
  });

  it("25. send() before connect: emits MQTT_SEND_NOT_CONNECTED and does NOT throw", function () {
    const t = new MqttTransport(baseConfig());
    let captured = null;
    t.on("error", (e) => (captured = e));
    expect(() => t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2 })).to.not.throw();
    expect(captured).to.not.equal(null);
    expect(captured.message).to.match(/MQTT_SEND_NOT_CONNECTED/);
  });

  it("26. publish broker error is emitted as 'error' with MQTT_PUBLISH_ERROR", async function () {
    const { t, client } = await connected();
    client.publish.callsFake((topic, chunk, opts, cb) => cb(new Error("disconnected")));
    let captured = null;
    t.on("error", (e) => (captured = e));
    t.send(Buffer.from([1]), { writerGroupId: 1, dataSetWriterId: 2 });
    expect(captured).to.not.equal(null);
    expect(captured.message).to.match(/MQTT_PUBLISH_ERROR/);
  });
});
