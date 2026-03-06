/**
 * OPC UA Browse Client Node (Experimental)
 * Browse the OPC UA address space in the editor, select any node type,
 * then read or subscribe to them at runtime.
 */

const { parseNodeId, createError } = require('../lib/opcua-utils');
const OpcUaClientManager = require('../lib/opcua-client-manager');
const { resolveNodeId, NodeClass, AttributeIds, DataType } = require('node-opcua');

module.exports = function(RED) {

    // ─── Cached browse connections (per endpoint, shared across editor tabs) ───
    const browseConnections = new Map(); // endpointId -> { mgr, timer, refCount }

    async function getBrowseConnection(endpointNode) {
        const id = endpointNode.id;

        if (browseConnections.has(id)) {
            const entry = browseConnections.get(id);
            // Reset idle timer
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => closeBrowseConnection(id), 60000);
            if (entry.mgr.isConnected) {
                return entry.mgr;
            }
            // Connection lost — recreate
            try { await entry.mgr.disconnect(); } catch (e) { /* ignore */ }
            browseConnections.delete(id);
        }

        const certData = endpointNode.getCertificateData ? endpointNode.getCertificateData() : {};
        const mgr = new OpcUaClientManager({
            endpointUrl: endpointNode.endpointUrl,
            userName: endpointNode.credentials?.userName || '',
            password: endpointNode.credentials?.password || '',
            securityMode: endpointNode.securityMode || 'None',
            securityPolicy: endpointNode.securityPolicy || 'None',
            applicationName: 'Node-RED OPC UA Browser (Editor)',
            maxReconnectAttempts: 0,
            reconnectDelay: 5000,
            certificateFile: certData.certificateFile || '',
            privateKeyFile: certData.privateKeyFile || '',
            caCertificateFile: certData.caCertificateFile || '',
            userCertificateFile: certData.userCertificateFile || '',
            userPrivateKeyFile: certData.userPrivateKeyFile || ''
        });

        await mgr.connect();

        const timer = setTimeout(() => closeBrowseConnection(id), 60000);
        browseConnections.set(id, { mgr, timer });
        return mgr;
    }

    async function closeBrowseConnection(id) {
        const entry = browseConnections.get(id);
        if (entry) {
            clearTimeout(entry.timer);
            browseConnections.delete(id);
            try { await entry.mgr.disconnect(); } catch (e) { /* ignore */ }
        }
    }

    // NodeClass number -> name mapping (node-opcua uses enums that may serialize as numbers)
    function resolveNodeClassName(nc) {
        if (typeof nc === 'string') return nc;
        if (typeof nc === 'number') return NodeClass[nc] || String(nc);
        return String(nc);
    }

    // Which NodeClasses can have children (worth expanding)
    const EXPANDABLE_CLASSES = new Set([
        'Object', 'Variable', 'ObjectType', 'VariableType',
        'ReferenceType', 'DataType', 'View',
        // Numeric equivalents
        1, 2, 8, 16, 32, 64, 128
    ]);

    function canHaveChildren(nodeClass, nodeClassNum) {
        return EXPANDABLE_CLASSES.has(nodeClass) || EXPANDABLE_CLASSES.has(nodeClassNum);
    }

    // Well-known OPC UA DataType NodeIds -> friendly names
    const BUILTIN_DATATYPE_MAP = {
        'i=1': 'Boolean', 'i=2': 'SByte', 'i=3': 'Byte', 'i=4': 'Int16',
        'i=5': 'UInt16', 'i=6': 'Int32', 'i=7': 'UInt32', 'i=8': 'Int64',
        'i=9': 'UInt64', 'i=10': 'Float', 'i=11': 'Double', 'i=12': 'String',
        'i=13': 'DateTime', 'i=14': 'Guid', 'i=15': 'ByteString',
        'i=16': 'XmlElement', 'i=17': 'NodeId', 'i=19': 'StatusCode',
        'i=20': 'QualifiedName', 'i=21': 'LocalizedText', 'i=22': 'Structure',
        'i=24': 'BaseDataType', 'i=26': 'Number', 'i=27': 'Integer',
        'i=28': 'UInteger', 'i=29': 'Enumeration'
    };

    function resolveDataTypeName(dtNodeId) {
        if (!dtNodeId) return '';
        const s = dtNodeId.toString();
        return BUILTIN_DATATYPE_MAP[s] || s;
    }

    // NodeClasses that support Value attribute subscription
    const SUBSCRIBABLE_CLASSES = new Set(['Variable', 'VariableType']);

    // ─── HTTP API for Editor Tree Browsing ───

    if (RED.httpAdmin) {

        RED.httpAdmin.post('/opcua-browse-client/browse', async function(req, res) {
            try {
                const { endpointId, nodeId } = req.body;
                if (!endpointId) {
                    return res.status(400).json({ error: 'endpointId required' });
                }

                const endpointNode = RED.nodes.getNode(endpointId);
                if (!endpointNode) {
                    return res.status(404).json({ error: 'Endpoint node not found. Deploy first.' });
                }

                const mgr = await getBrowseConnection(endpointNode);
                const session = mgr.getSession();

                const browseNodeId = nodeId || 'RootFolder';
                const browseResult = await session.browse({
                    nodeId: resolveNodeId(browseNodeId),
                    resultMask: 63
                });

                const forwardRefs = (browseResult.references || []).filter(ref => ref.isForward);

                // Collect Variable nodeIds to batch-read their DataType attribute
                const variableIndices = [];
                const variableNodeIds = [];
                forwardRefs.forEach((ref, idx) => {
                    const nc = resolveNodeClassName(ref.nodeClass);
                    if (nc === 'Variable' || nc === 'VariableType') {
                        variableIndices.push(idx);
                        variableNodeIds.push(ref.nodeId);
                    }
                });

                // Batch read DataType attribute for all variables
                const dataTypeMap = {};
                if (variableNodeIds.length > 0) {
                    try {
                        const readItems = variableNodeIds.map(nid => ({
                            nodeId: nid,
                            attributeId: AttributeIds.DataType
                        }));
                        const dataValues = await session.read(readItems);
                        const results = Array.isArray(dataValues) ? dataValues : [dataValues];
                        results.forEach((dv, i) => {
                            const nidStr = variableNodeIds[i].toString();
                            if (dv.value && dv.value.value) {
                                // DataType attribute returns a NodeId pointing to the type
                                const dtNodeId = dv.value.value;
                                const dtName = resolveDataTypeName(dtNodeId);
                                dataTypeMap[nidStr] = dtName;
                            }
                        });
                    } catch (e) {
                        // Non-critical — just skip datatype info
                    }
                }

                const refs = forwardRefs.map(ref => {
                    const ncRaw = ref.nodeClass;
                    const ncName = resolveNodeClassName(ncRaw);
                    const ncNum = typeof ncRaw === 'number' ? ncRaw : undefined;
                    const nidStr = ref.nodeId?.toString() || '';
                    return {
                        browseName: ref.browseName?.name || '',
                        nodeId: nidStr,
                        nodeClass: ncName,
                        displayName: ref.displayName?.text || ref.browseName?.name || '',
                        typeDefinition: ref.typeDefinition?.toString() || '',
                        dataType: dataTypeMap[nidStr] || '',
                        hasChildren: canHaveChildren(ncName, ncNum)
                    };
                });

                res.json({ references: refs });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // Disconnect cached browse connection
        RED.httpAdmin.post('/opcua-browse-client/disconnect', async function(req, res) {
            try {
                const { endpointId } = req.body;
                if (endpointId) {
                    await closeBrowseConnection(endpointId);
                }
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });
    }

    // ─── Runtime Node ───

    function OpcUaBrowseClientNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const endpointConfig = RED.nodes.getNode(config.endpoint);
        if (!endpointConfig) {
            node.error('Endpoint configuration missing');
            return;
        }
        if (!endpointConfig.getSharedManager) {
            node.error('Endpoint node does not support connection sharing');
            return;
        }

        const clientManager = endpointConfig.getSharedManager({
            applicationName: config.applicationName || 'Node-RED OPC UA Browse Client',
            maxReconnectAttempts: config.maxReconnectAttempts || 10,
            reconnectDelay: config.reconnectDelay || 5000
        });

        const selectedItems = config.selectedItems || [];
        const mode = config.mode || 'read';
        const publishInterval = config.publishInterval || 1000;

        let subscription = null;
        const monitorItems = new Map();

        node.status({ fill: 'red', shape: 'ring', text: 'not connected' });

        const statusCallback = (event, error) => {
            switch (event) {
                case 'connected':
                    node.status({ fill: 'green', shape: 'dot', text: `connected (${selectedItems.length} items)` });
                    if (mode === 'subscribe' && selectedItems.length > 0) {
                        setupSubscriptions();
                    }
                    break;
                case 'disconnected':
                    node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
                    monitorItems.clear();
                    subscription = null;
                    break;
                case 'reconnecting':
                    node.status({ fill: 'yellow', shape: 'ring', text: 'connecting...' });
                    break;
                case 'error':
                    node.error(`OPC UA error: ${error ? error.message : 'unknown'}`);
                    node.status({ fill: 'red', shape: 'ring', text: 'error' });
                    break;
            }
        };
        endpointConfig.registerStatusCallback(statusCallback);

        if (clientManager.isConnected) {
            node.status({ fill: 'green', shape: 'dot', text: `connected (${selectedItems.length} items)` });
            if (mode === 'subscribe' && selectedItems.length > 0) {
                setupSubscriptions();
            }
        }

        // ─── Subscribe Mode ───

        async function setupSubscriptions() {
            if (subscription || selectedItems.length === 0) return;

            try {
                const { ClientMonitoredItem } = require('node-opcua');
                subscription = await clientManager.createSubscription({
                    interval: publishInterval
                });

                const subscribableItems = selectedItems.filter(
                    item => SUBSCRIBABLE_CLASSES.has(item.nodeClass)
                );
                const skippedCount = selectedItems.length - subscribableItems.length;
                if (skippedCount > 0) {
                    node.warn(`Skipping ${skippedCount} non-subscribable item(s) (only Variable/VariableType support subscriptions)`);
                }

                for (const item of subscribableItems) {
                    try {
                        const opcuaNodeId = resolveNodeId(item.nodeId);
                        const monitorItem = ClientMonitoredItem.create(
                            subscription,
                            { nodeId: opcuaNodeId, attributeId: AttributeIds.Value },
                            { samplingInterval: publishInterval, discardOldest: true, queueSize: 10 }
                        );

                        monitorItem.on('changed', (dataValue) => {
                            node.send({
                                payload: dataValue.value?.value,
                                statusCode: dataValue.statusCode?.toString(),
                                sourceTimestamp: dataValue.sourceTimestamp,
                                serverTimestamp: dataValue.serverTimestamp,
                                nodeId: item.nodeId,
                                browseName: item.browseName || '',
                                displayName: item.displayName || '',
                                nodeClass: item.nodeClass || '',
                                dataType: item.dataType || '',
                                operation: 'subscribe'
                            });
                        });

                        monitorItems.set(item.nodeId, monitorItem);
                    } catch (e) {
                        node.warn(`Failed to subscribe to ${item.nodeId} (${item.nodeClass}): ${e.message}`);
                    }
                }

                node.status({ fill: 'green', shape: 'dot', text: `subscribed (${monitorItems.size}/${subscribableItems.length})` });
            } catch (e) {
                node.error(`Subscription setup failed: ${e.message}`);
            }
        }

        // ─── Input Handler ───

        node.on('input', async function(msg, send, done) {
            try {
                if (!clientManager.isConnected) {
                    await clientManager.connect();
                }

                const operation = (msg.operation || mode).toLowerCase();

                if (operation === 'read' || operation === 'readmultiple') {
                    const items = selectedItems.length > 0 ? selectedItems : [];
                    if (items.length === 0) {
                        throw new Error('No items selected. Open node settings and browse the server to select items.');
                    }

                    const nodeIds = items.map(item => parseNodeId(item.nodeId));
                    const results = await clientManager.readMultiple(nodeIds);

                    const enriched = results.map((r, idx) => ({
                        ...r,
                        browseName: items[idx].browseName || '',
                        displayName: items[idx].displayName || '',
                        nodeClass: items[idx].nodeClass || ''
                    }));

                    msg.payload = enriched;
                    msg.operation = 'readmultiple';
                    msg.count = enriched.length;
                    send(msg);
                    done();

                } else if (operation === 'subscribe') {
                    await setupSubscriptions();
                    msg.payload = `Subscribed to ${monitorItems.size} items`;
                    send(msg);
                    done();

                } else if (operation === 'unsubscribe') {
                    for (const mi of monitorItems.values()) {
                        try { await mi.terminate(); } catch (e) { /* ignore */ }
                    }
                    monitorItems.clear();
                    if (subscription) {
                        try { await subscription.terminate(); } catch (e) { /* ignore */ }
                        subscription = null;
                    }
                    msg.payload = 'Unsubscribed';
                    send(msg);
                    done();

                } else {
                    throw new Error(`Unknown operation: ${operation}`);
                }

            } catch (error) {
                node.error(`Operation error: ${error.message}`);
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                msg.error = createError(error.message, error);
                send(msg);
                done(error);
            }
        });

        // ─── Cleanup ───

        node.on('close', async function(removed, done) {
            for (const mi of monitorItems.values()) {
                try { await mi.terminate(); } catch (e) { /* ignore */ }
            }
            monitorItems.clear();

            if (subscription) {
                try { await subscription.terminate(); } catch (e) { /* ignore */ }
                subscription = null;
            }

            if (endpointConfig.unregisterStatusCallback) {
                endpointConfig.unregisterStatusCallback(statusCallback);
            }
            if (endpointConfig.releaseSharedManager) {
                try { await endpointConfig.releaseSharedManager(); } catch (e) { /* ignore */ }
            }
            done();
        });
    }

    RED.nodes.registerType('opcua-browse-client', OpcUaBrowseClientNode);
};
