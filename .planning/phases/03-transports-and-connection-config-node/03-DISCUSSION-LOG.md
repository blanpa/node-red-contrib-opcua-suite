# Phase 3: Transports and Connection Config Node — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-13
**Phase:** 03-transports-and-connection-config-node
**Areas discussed:** BaseTransport API-Vertrag, Ref-counted Lifecycle + 500ms Grace Period, PublisherId UX im Editor, MQTT Broker-Config + Auth + QoS

---

## Area 1 — BaseTransport API-Vertrag

### Q1.1 — Interface form

| Option | Description | Selected |
|--------|-------------|----------|
| ES6 abstract class (empfohlen) | `class BaseTransport extends EventEmitter` mit Methoden die throw wenn nicht ueberschrieben | ✓ |
| Plain object factory | `createUdpTransport(opts) -> { send, close, on, off }` | |
| Duck-typed object literal | Plain object mit erwarteten Methoden, maximaler flex, kein Vertrag | |

**User's choice:** ES6 abstract class — D-01

### Q1.2 — send() chunk handling

| Option | Description | Selected |
|--------|-------------|----------|
| Transport akzeptiert Buffer \| Buffer[] (empfohlen) | Encoder gibt einer von beiden zurueck, Transport prueft `Array.isArray` | ✓ |
| Transport akzeptiert nur Buffer | Caller loopt selbst | |

**User's choice:** Buffer | Buffer[] — D-02

### Q1.3 — Status events emitted

| Option | Description | Selected |
|--------|-------------|----------|
| Same as opcua-endpoint: connected/disconnected/reconnecting/error (empfohlen) | 4 Events, 1:1 mirror | ✓ |
| Extended: + offline/reconnect/timeout | Mehr Granularitaet, aber UDP-Mapping fragwuerdig | |
| Reduced: nur up/down/error | Simpler, aber UI verliert reconnect-Info | |

**User's choice:** Same 4 events as opcua-endpoint — D-03

### Q1.4 — Subscriber receive path

| Option | Description | Selected |
|--------|-------------|----------|
| EventEmitter 'message' Event (empfohlen) | `transport.on('message', buf => ...)` konsistent mit Status-Events | ✓ |
| Explicit receive(callback) Setter | Einzelner Receiver, klarere Ownership | |
| Async Iterator (for await of) | Modern, aber ungewohnt fuer Node-RED | |

**User's choice:** 'message' EventEmitter — D-04

---

## Area 2 — Ref-counted Lifecycle + 500ms Grace Period

### Q2.1 — When does grace timer start?

| Option | Description | Selected |
|--------|-------------|----------|
| Wenn refCount von 1 auf 0 faellt (empfohlen) | Klassisches Refcount-Pattern, mitigates redeploy-thrash | ✓ |
| Bei jedem Node-RED 'close' Event | Mehrere ueberlappende Timer moeglich | |
| Keine Grace - sofortiges close() | Garantiert EADDRINUSE auf UDP | |

**User's choice:** refCount 1→0 — D-05

### Q2.2 — Re-acquire during grace

| Option | Description | Selected |
|--------|-------------|----------|
| Timer canceln, Transport bleibt offen (empfohlen) | clearTimeout, Pointer bleibt valide, Status zurueck auf connected | ✓ |
| Grace fertig laufen lassen, neuer Transport | Latency-Penalty fuer den Re-Acquirer | |

**User's choice:** Cancel timer, reuse transport — D-06

### Q2.3 — Lifecycle owner

| Option | Description | Selected |
|--------|-------------|----------|
| Connection-Node owned (empfohlen) | lib/ bleibt Node-RED-frei, mirrors opcua-endpoint | ✓ |
| BaseTransport-Klasse selbst | Lifecycle in lib/ - Tests muessten Node-RED-Behavior simulieren | |

**User's choice:** Connection-Node — D-07

### Q2.4 — Grace configurable in editor?

| Option | Description | Selected |
|--------|-------------|----------|
| Fest 500ms, nicht in UI (empfohlen) | Konstante; REQ nennt explizit 500ms | ✓ |
| Editor-Field 'reconnectGraceMs' default 500 | User-Tuning, aber noise | |

**User's choice:** Hardcoded 500ms — D-08

---

## Area 3 — PublisherId UX im Editor

### Q3.1 — Type selection

| Option | Description | Selected |
|--------|-------------|----------|
| Dropdown: String/UInt16/UInt32/UInt64 (empfohlen) | Explizite Type-Wahl, kein silent coercion | ✓ |
| Single text input, Type per Heuristik | Weniger Felder, aber silent type-coercion | |

**User's choice:** Dropdown — D-09

### Q3.2 — Default value

| Option | Description | Selected |
|--------|-------------|----------|
| String + Auto-UUID (empfohlen) | `crypto.randomUUID()` beim Anlegen, eindeutig out-of-box | ✓ |
| Leer, User muss eintragen | Validation-Error UX bei jedem neuen Drag | |
| UInt16=1 Default | Collision-Risiko bei Multi-Tenant | |

**User's choice:** String + Auto-UUID — D-10

### Q3.3 — Per-Publisher override

| Option | Description | Selected |
|--------|-------------|----------|
| Nein - PublisherId nur auf Connection (empfohlen) | Per CFG-02 Spec, einfacheres mental model | ✓ |
| Publisher-Node kann override | Flexibler, aber bricht Spec-Konzept | |

**User's choice:** No per-Publisher override — D-11

### Q3.4 — Encoder flow

| Option | Description | Selected |
|--------|-------------|----------|
| Publisher-Node liest+packt in NetworkMessage (empfohlen) | Encoder stateless (Phase 2 D-01), Connection = single source | ✓ |
| Transport-Layer pflegt sie | Verletzt Layering, Transport sollte domain-agnostic sein | |

**User's choice:** Publisher-Node packs into NetworkMessage — D-12

---

## Area 4 — MQTT Broker-Config + Auth + QoS

### Q4.1 — Broker URL + TLS

| Option | Description | Selected |
|--------|-------------|----------|
| Single URL field, TLS aus Scheme (empfohlen) | `mqtts://` triggert TLS auto | ✓ |
| URL + separater TLS-Toggle | Redundant | |
| Host + Port + TLS als 3 Felder | Mehr Edit-Schritte ohne Mehrwert | |

**User's choice:** Single URL field — D-13

### Q4.2 — Auth methods

| Option | Description | Selected |
|--------|-------------|----------|
| User/Password als credentials (empfohlen) | Wie opcua-endpoint, 90% der Broker | ✓ |
| Nur Client-Cert (mTLS) | Hohe Friction fuer test-broker | |
| Beide als Toggle | UI komplizierter ohne klaren Gewinn | |

**User's choice:** User/Password credentials — D-14

### Q4.3 — QoS configurability

| Option | Description | Selected |
|--------|-------------|----------|
| QoS 1 default, editor-configurable (empfohlen) | Safe middle, dropdown 0/1/2, Phase 4 kann per-call override | ✓ |
| Fest QoS 0 | Keine Option fuer Events/Config | |
| QoS 1 fest | Kein QoS 2 fuer kritische topics | |

**User's choice:** QoS 1 default, configurable — D-15

### Q4.4 — Topic structure

| Option | Description | Selected |
|--------|-------------|----------|
| Spec-default + per-Publisher overridable (empfohlen) | `{prefix}/{pubId}/{wgId}/{dswId}`, prefix=ua default | ✓ |
| Explicit topic pro Publisher | Maximal flexibel, noisier Setup | |
| Connection-Node Template-String | User muss Template-Syntax lernen | |

**User's choice:** Spec-default + override — D-16

---

## Claude's Discretion

- Layout: `lib/transports/` subfolder (vs flat lib/)
- UDP socket-option defaults (`reuseAddr`, `addMembership` timing) — implementation choice
- Internal helper names, JSDoc wording, error code naming (`MQTT_*` / `UDP_*` prefixes per Phase 2 pattern)

## Deferred Ideas

- mTLS client-certificate auth for MQTT (Phase 3.1 / v2)
- AMQP transport (already deferred to v2 at Init)
- Per-Publisher PublisherId override (D-11)
- Configurable reconnect grace in UI (D-08; opts path exists)
- Discovery / announcement (Part 14 §7.4)
- MQTT 5.0 user properties / response topic
