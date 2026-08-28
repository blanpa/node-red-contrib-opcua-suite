/**
 * OPC UA Event Node — Subscribes to OPC UA events (BaseEventType etc.)
 */
const { parseNodeId, createError } = require('../lib/opcua-utils');

module.exports = function(RED) {
    function OpcUaEventNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.sourceNodeId = config.sourceNodeId || 'i=2253'; // Server node default
        node.eventType = config.eventType || 'BaseEventType';

        let subscription = null;
        let monitoredItem = null;
        // Remembers the active subscription request so it can be replayed after
        // the server drops the session (e.g. a Siemens S7 ~60s session timeout).
        // Without this the node kept a ClientSubscription bound to the dead
        // session and silently stopped delivering events — the same failure
        // opcua-client fixed for issue #15.
        let activeRequest = null;
        let resubscribeInFlight = false;

        // Endpoint config node (for shared connection)
        const endpointConfig = RED.nodes.getNode(config.endpoint);
        if (!endpointConfig || !endpointConfig.getSharedManager) {
            node.status({ fill: 'red', shape: 'ring', text: 'no endpoint' });
            return;
        }

        const clientManager = endpointConfig.getSharedManager({
            applicationName: 'Node-RED OPC UA Event'
        });

        // Status callback
        const statusCallback = (event, error) => {
            switch (event) {
                case 'connected':
                    node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                    break;
                case 'disconnected':
                    node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
                    // The handles below belong to a session that is gone;
                    // reusing them throws "expecting a valid session".
                    // activeRequest is kept so we can replay after recovery.
                    monitoredItem = null;
                    subscription = null;
                    break;
                case 'session_recreated':
                    monitoredItem = null;
                    subscription = null;
                    resubscribe();
                    break;
                case 'reconnecting':
                    node.status({ fill: 'yellow', shape: 'ring', text: 'connecting...' });
                    break;
                case 'error':
                    // The connection error was previously received and dropped,
                    // leaving a red dot with no explanation anywhere.
                    node.error(`OPC UA error: ${error ? error.message : 'unknown'}`);
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    break;
            }
        };

        /**
         * Rebuilds the remembered event subscription on the fresh session.
         * Event messages go out via node.send() (not the input handler's
         * scoped send) because they are produced asynchronously, long after
         * the message that started the subscription was acknowledged.
         */
        function resubscribe() {
            if (resubscribeInFlight || !activeRequest) return;
            resubscribeInFlight = true;
            Promise.resolve()
                .then(() => subscribeEvents(activeRequest))
                .then(() => {
                    node.status({
                        fill: 'green', shape: 'dot',
                        text: `events: ${activeRequest.sourceId}`
                    });
                })
                .catch((err) => {
                    node.warn(`Re-subscribe after reconnect failed: ${err.message}`);
                })
                .finally(() => { resubscribeInFlight = false; });
        }
        endpointConfig.registerStatusCallback(statusCallback);

        if (clientManager.isConnected) {
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        } else {
            node.status({ fill: 'yellow', shape: 'ring', text: 'ready' });
        }

        /**
         * Creates (or recreates) the subscription + event monitored item for
         * `request`. Safe to call repeatedly: any previous monitored item is
         * terminated first.
         */
        async function subscribeEvents(request) {
            const nodeId = parseNodeId(request.sourceId);
            if (!nodeId) throw new Error(`Invalid NodeId: ${request.sourceId}`);

            if (!subscription) {
                subscription = await clientManager.createSubscription({
                    interval: request.interval,
                    maxNotificationsPerPublish: 100
                });
            }

            if (monitoredItem) {
                try { await monitoredItem.terminate(); } catch (e) { /* stale session */ }
                monitoredItem = null;
            }

            const { AttributeIds, ClientMonitoredItem, constructEventFilter,
                    ofType, resolveNodeId } = require('node-opcua');

            const SELECT_FIELDS = [
                'EventId', 'EventType', 'SourceNode', 'SourceName',
                'Time', 'ReceiveTime', 'Message', 'Severity'
            ];

            // The configured event type was previously read and then thrown
            // away — every event type was delivered regardless of the setting.
            // Translate it into an OfType where-clause. BaseEventType is the
            // root of the hierarchy, so filtering on it would be a no-op.
            let whereClause;
            const eventTypeName = request.eventType || 'BaseEventType';
            if (eventTypeName !== 'BaseEventType') {
                try {
                    whereClause = ofType(resolveNodeId(eventTypeName));
                } catch (e) {
                    throw new Error(
                        `Unknown event type "${eventTypeName}": ${e.message}`
                    );
                }
            }

            const eventFilter = constructEventFilter(SELECT_FIELDS, whereClause);

            monitoredItem = ClientMonitoredItem.create(
                subscription,
                {
                    nodeId: clientManager._toOpcUaNodeId(nodeId),
                    attributeId: AttributeIds.EventNotifier
                },
                {
                    samplingInterval: request.interval,
                    discardOldest: true,
                    queueSize: 100,
                    filter: eventFilter
                }
            );

            monitoredItem.on('changed', (eventFields) => {
                const fields = Array.isArray(eventFields) ? eventFields : [];
                const fieldNames = ['EventId', 'EventType', 'SourceNode', 'SourceName',
                                   'Time', 'ReceiveTime', 'Message', 'Severity'];
                const event = {};
                fieldNames.forEach((name, i) => {
                    if (fields[i] !== undefined) {
                        const val = fields[i];
                        event[name.charAt(0).toLowerCase() + name.slice(1)] =
                            val && val.value !== undefined ? val.value : val;
                    }
                });
                node.send({ payload: event, topic: request.sourceId, operation: 'event' });
            });
        }

        node.on('input', async function(msg, send, done) {
            const action = (msg.action || msg.operation || 'subscribe').toLowerCase();
            try {
                if (!clientManager.isConnected) await clientManager.connect();

                if (action === 'unsubscribe') {
                    activeRequest = null;
                    if (monitoredItem) {
                        await monitoredItem.terminate();
                        monitoredItem = null;
                    }
                    if (subscription) {
                        await subscription.terminate();
                        subscription = null;
                    }
                    node.status({ fill: 'yellow', shape: 'ring', text: 'stopped' });
                    msg.payload = 'Event subscription ended';
                    send(msg);
                    done();
                    return;
                }

                // Subscribe
                const sourceId = msg.sourceNodeId || msg.topic || node.sourceNodeId;
                const eventTypeStr = msg.eventType || node.eventType;
                if (!parseNodeId(sourceId)) throw new Error(`Invalid NodeId: ${sourceId}`);

                activeRequest = {
                    sourceId,
                    eventType: eventTypeStr,
                    interval: msg.interval || 500
                };
                await subscribeEvents(activeRequest);

                node.status({ fill: 'green', shape: 'dot', text: `events: ${sourceId}` });
                msg.payload = `Event subscription active on ${sourceId}`;
                send(msg);
                done();

            } catch (error) {
                // DEBT-01: if the failure looks like a lost connection,
                // delegate recovery to the manager's single-flight reconnect
                // loop so the next message gets a fresh session.
                if (clientManager._isConnectionLostError && clientManager._isConnectionLostError(error)) {
                    try { await clientManager.reconnect({ reason: "session-lost" }); } catch (e) { /* handled by reconnect */ }
                }
                node.error(`Event error: ${error.message}`);
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                msg.error = createError(error.message, error);
                send(msg);
                done(error);
            }
        });

        node.on('close', async function(removed, done) {
            if (monitoredItem) try { await monitoredItem.terminate(); } catch (e) { /**/ }
            if (subscription) try { await subscription.terminate(); } catch (e) { /**/ }
            if (endpointConfig.unregisterStatusCallback) {
                endpointConfig.unregisterStatusCallback(statusCallback);
            }
            if (endpointConfig.releaseSharedManager) {
                try { await endpointConfig.releaseSharedManager(); } catch (e) { /* ignore */ }
            }
            done();
        });
    }

    RED.nodes.registerType('opcua-event', OpcUaEventNode);
};
