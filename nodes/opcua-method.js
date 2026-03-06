/**
 * OPC UA Method Node — Calls OPC UA methods
 */
const { parseNodeId, createError } = require('../lib/opcua-utils');

module.exports = function(RED) {
    function OpcUaMethodNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.methodNodeId = config.methodNodeId || '';
        node.objectNodeId = config.objectNodeId || '';

        // Endpoint config node (for shared connection)
        const endpointConfig = RED.nodes.getNode(config.endpoint);
        if (!endpointConfig || !endpointConfig.getSharedManager) {
            node.status({ fill: 'red', shape: 'ring', text: 'no endpoint' });
            return;
        }

        const clientManager = endpointConfig.getSharedManager({
            applicationName: 'Node-RED OPC UA Method'
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
            try {
                if (!clientManager.isConnected) await clientManager.connect();

                const methodStr = msg.methodNodeId || node.methodNodeId;
                const objectStr = msg.objectNodeId || node.objectNodeId || msg.topic;

                if (!methodStr) throw new Error('Method NodeId missing');
                if (!objectStr) throw new Error('Object NodeId missing');

                const methodId = parseNodeId(methodStr);
                const objectId = parseNodeId(objectStr);
                if (!methodId) throw new Error(`Invalid Method NodeId: ${methodStr}`);
                if (!objectId) throw new Error(`Invalid Object NodeId: ${objectStr}`);

                // Input arguments: Array of {dataType, value} or simple values
                const inputArgs = msg.inputArguments || msg.payload || [];
                const args = Array.isArray(inputArgs) ? inputArgs : [inputArgs];

                node.status({ fill: 'blue', shape: 'dot', text: 'calling...' });

                const result = await clientManager.callMethod(objectId, methodId, args);

                node.status({ fill: 'green', shape: 'dot', text: result.statusCode });

                msg.payload = result.outputArguments.map(a => a.value);
                msg.methodResult = result;
                msg.statusCode = result.statusCode;

                send(msg);
                done();
            } catch (error) {
                node.error(`Method error: ${error.message}`);
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                msg.error = createError(error.message, error);
                send(msg);
                done(error);
            }
        });

        // Cleanup
        node.on('close', async function(removed, done) {
            if (endpointConfig.unregisterStatusCallback) {
                endpointConfig.unregisterStatusCallback(statusCallback);
            }
            if (endpointConfig.releaseSharedManager) {
                try { await endpointConfig.releaseSharedManager(); } catch (e) { /* ignore */ }
            }
            done();
        });
    }

    RED.nodes.registerType('opcua-method', OpcUaMethodNode);
};
