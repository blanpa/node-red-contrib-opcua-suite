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
                    break;
                case 'reconnecting':
                    node.status({ fill: 'yellow', shape: 'ring', text: 'connecting...' });
                    break;
                case 'error':
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    break;
            }
        };
        endpointConfig.registerStatusCallback(statusCallback);

        if (clientManager.isConnected) {
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        } else {
            node.status({ fill: 'yellow', shape: 'ring', text: 'ready' });
        }

        node.on('input', async function(msg, send, done) {
            const action = (msg.action || msg.operation || 'subscribe').toLowerCase();
            try {
                if (!clientManager.isConnected) await clientManager.connect();

                if (action === 'unsubscribe') {
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
                const nodeId = parseNodeId(sourceId);
                if (!nodeId) throw new Error(`Invalid NodeId: ${sourceId}`);

                if (!subscription) {
                    subscription = await clientManager.createSubscription({
                        interval: msg.interval || 500,
                        maxNotificationsPerPublish: 100
                    });
                }

                if (monitoredItem) {
                    await monitoredItem.terminate();
                    monitoredItem = null;
                }

                const { AttributeIds, ClientMonitoredItem,
                        constructEventFilter } = require('node-opcua');

                const eventFilter = constructEventFilter([
                    'EventId', 'EventType', 'SourceNode', 'SourceName',
                    'Time', 'ReceiveTime', 'Message', 'Severity'
                ]);

                monitoredItem = ClientMonitoredItem.create(
                    subscription,
                    {
                        nodeId: clientManager._toOpcUaNodeId(nodeId),
                        attributeId: AttributeIds.EventNotifier
                    },
                    {
                        samplingInterval: msg.interval || 500,
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
                    send({ payload: event, topic: sourceId, operation: 'event' });
                });

                node.status({ fill: 'green', shape: 'dot', text: `events: ${sourceId}` });
                msg.payload = `Event subscription active on ${sourceId}`;
                send(msg);
                done();

            } catch (error) {
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
