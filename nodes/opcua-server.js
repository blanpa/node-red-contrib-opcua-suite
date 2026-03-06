/**
 * OPC UA Server Node
 * Modern OPC UA server implementation
 */

const { OPCUAServer, Variant, DataType, StatusCodes, coerceLocalizedText } = require('node-opcua');

module.exports = function(RED) {
    function OpcUaServerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        const port = config.port || 4840;
        const serverName = config.serverName || 'Node-RED OPC UA Server';
        const maxAllowedSessionNumber = config.maxAllowedSessionNumber || 10;
        const maxConnectionsPerEndpoint = config.maxConnectionsPerEndpoint || 10;

        let server = null;
        let namespace = null;
        let addressSpace = null;

        // Initialize status
        node.status({ fill: 'red', shape: 'ring', text: 'stopped' });

        // Start server
        async function startServer() {
            try {
                server = new OPCUAServer({
                    port: port,
                    resourcePath: '/UA/NodeRED',
                    buildInfo: {
                        productName: serverName,
                        buildNumber: '1.0.0'
                    },
                    serverInfo: {
                        applicationUri: `urn:Node-RED:${serverName}`,
                        productUri: 'urn:Node-RED:OPCUA-Suite'
                    },
                    maxAllowedSessionNumber: maxAllowedSessionNumber,
                    maxConnectionsPerEndpoint: maxConnectionsPerEndpoint
                });

                await server.initialize();

                // Get namespace
                addressSpace = server.engine.addressSpace;
                namespace = addressSpace.getOwnNamespace();

                await server.start();

                const endpointUrl = server.getEndpointUrl();
                node.status({ fill: 'green', shape: 'dot', text: `Port ${port}` });
                node.log(`OPC UA Server started on ${endpointUrl}`);

                // Attach server info to node
                node.server = server;
                node.namespace = namespace;
                node.addressSpace = addressSpace;
                node.endpointUrl = endpointUrl;

            } catch (error) {
                node.error(`Error starting server: ${error.message}`, { error });
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                throw error;
            }
        }

        // Input handler for server commands
        node.on('input', async function(msg, send, done) {
            try {
                if (!server || !namespace) {
                    throw new Error('Server not started');
                }

                const command = msg.command || msg.payload?.command;
                let result;

                switch (command) {
                    case 'addFolder':
                        result = await handleAddFolder(msg, namespace);
                        break;

                    case 'addVariable':
                        result = await handleAddVariable(msg, namespace);
                        break;

                    case 'setValue':
                        result = await handleSetValue(msg, namespace);
                        break;

                    case 'deleteNode':
                        result = await handleDeleteNode(msg, namespace);
                        break;

                    case 'addMethod':
                        result = await handleAddMethod(msg, namespace, addressSpace);
                        break;

                    case 'addObject':
                        result = await handleAddObject(msg, namespace);
                        break;

                    case 'getServerInfo':
                        result = await handleGetServerInfo(server);
                        break;

                    case 'setWritable':
                        result = await handleSetWritable(msg, namespace, addressSpace);
                        break;

                    case 'raiseEvent':
                        result = await handleRaiseEvent(msg, namespace, addressSpace);
                        break;

                    case 'getNamespaceIndex':
                        result = { namespaceIndex: namespace.index };
                        break;

                    default:
                        throw new Error(`Unknown command: ${command}`);
                }

                Object.assign(msg, result);
                send(msg);
                done();

            } catch (error) {
                node.error(`Server command error: ${error.message}`, { error });
                msg.error = error.message;
                send(msg);
                done(error);
            }
        });

        // Start server
        startServer().catch(error => {
            node.error(`Critical error: ${error.message}`, { error });
        });

        // Cleanup on close
        node.on('close', async function(removed, done) {
            if (server) {
                try {
                    await server.shutdown();
                    node.status({ fill: 'red', shape: 'ring', text: 'stopped' });
                    node.log('OPC UA Server stopped');
                } catch (error) {
                    node.error(`Error stopping server: ${error.message}`);
                }
            }
            done();
        });
    }

    // Handler functions
    async function handleAddFolder(msg, namespace) {
        const folderName = msg.folderName || msg.payload?.folderName;
        const parentNodeId = msg.parentNodeId || msg.payload?.parentNodeId || 'ObjectsFolder';

        if (!folderName) {
            throw new Error('folderName missing');
        }

        const folder = namespace.addFolder(parentNodeId, {
            browseName: folderName,
            nodeId: msg.nodeId || undefined
        });

        return {
            payload: folder.nodeId.toString(),
            nodeId: folder.nodeId.toString(),
            folderName: folderName
        };
    }

    async function handleAddVariable(msg, namespace) {
        const variableName = msg.variableName || msg.payload?.variableName;
        const parentNodeId = msg.parentNodeId || msg.payload?.parentNodeId || 'ObjectsFolder';
        const datatype = msg.datatype || msg.payload?.datatype || 'Double';
        const initialValue = msg.initialValue !== undefined ? msg.initialValue : msg.payload?.initialValue;

        if (!variableName) {
            throw new Error('variableName missing');
        }

        const dataType = DataType[datatype] || DataType.Double;
        const variant = new Variant({
            dataType: dataType,
            value: initialValue !== undefined ? initialValue : getDefaultValue(dataType)
        });

        const variable = namespace.addVariable({
            componentOf: parentNodeId,
            browseName: variableName,
            nodeId: msg.nodeId || undefined,
            dataType: dataType,
            value: variant
        });

        return {
            payload: variable.nodeId.toString(),
            nodeId: variable.nodeId.toString(),
            variableName: variableName,
            value: initialValue
        };
    }

    async function handleSetValue(msg, namespace) {
        const nodeId = msg.nodeId || msg.topic;
        const value = msg.payload;

        if (!nodeId) {
            throw new Error('nodeId missing');
        }

        if (value === undefined || value === null) {
            throw new Error('Value missing');
        }

        const node = namespace.findNode(nodeId);
        if (!node) {
            throw new Error(`Node not found: ${nodeId}`);
        }

        const datatype = msg.datatype || node.dataType;
        const dataType = DataType[datatype] || DataType.Double;
        const variant = new Variant({
            dataType: dataType,
            value: value
        });

        node.setValueFromSource(variant);

        return {
            payload: value,
            nodeId: nodeId,
            statusCode: StatusCodes.Good.toString()
        };
    }

    async function handleDeleteNode(msg, namespace) {
        const nodeId = msg.nodeId || msg.topic;

        if (!nodeId) {
            throw new Error('nodeId missing');
        }

        const node = namespace.findNode(nodeId);
        if (!node) {
            throw new Error(`Node not found: ${nodeId}`);
        }

        node.delete();

        return {
            payload: true,
            nodeId: nodeId
        };
    }

    async function handleAddMethod(msg, namespace, addressSpace) {
        const methodName = msg.methodName || msg.payload?.methodName;
        const parentNodeId = msg.parentNodeId || msg.payload?.parentNodeId || 'ObjectsFolder';

        if (!methodName) {
            throw new Error('methodName missing');
        }

        const inputArguments = (msg.inputArguments || msg.payload?.inputArguments || []).map(arg => ({
            name: arg.name,
            dataType: DataType[arg.dataType] || DataType.String,
            description: coerceLocalizedText(arg.description || arg.name)
        }));

        const outputArguments = (msg.outputArguments || msg.payload?.outputArguments || []).map(arg => ({
            name: arg.name,
            dataType: DataType[arg.dataType] || DataType.String,
            description: coerceLocalizedText(arg.description || arg.name)
        }));

        const methodOpts = {
            componentOf: parentNodeId,
            browseName: methodName,
            nodeId: msg.nodeId || undefined,
            inputArguments: inputArguments,
            outputArguments: outputArguments
        };

        const funcBody = msg.func || msg.payload?.func;
        if (funcBody && typeof funcBody === 'string') {
            methodOpts.onCall = new Function('inputArguments', 'context', funcBody);
        } else {
            // Default handler that returns StatusCodes.Good with empty outputs
            methodOpts.onCall = function(inputArgs, context) {
                return {
                    statusCode: StatusCodes.Good,
                    outputArguments: outputArguments.map(arg => new Variant({
                        dataType: arg.dataType,
                        value: getDefaultValue(arg.dataType)
                    }))
                };
            };
        }

        const method = namespace.addMethod(methodOpts);

        return {
            payload: method.nodeId.toString(),
            nodeId: method.nodeId.toString(),
            methodName: methodName
        };
    }

    async function handleAddObject(msg, namespace) {
        const objectName = msg.objectName || msg.payload?.objectName;
        const parentNodeId = msg.parentNodeId || msg.payload?.parentNodeId || 'ObjectsFolder';

        if (!objectName) {
            throw new Error('objectName missing');
        }

        const obj = namespace.addObject({
            organizedBy: parentNodeId,
            browseName: objectName,
            nodeId: msg.nodeId || undefined
        });

        return {
            payload: obj.nodeId.toString(),
            nodeId: obj.nodeId.toString(),
            objectName: objectName
        };
    }

    async function handleGetServerInfo(server) {
        const serverDiag = server.engine && server.engine.serverDiagnosticsSummary;
        const info = {
            currentSessionCount: serverDiag ? serverDiag.currentSessionCount : 0,
            currentSubscriptionCount: serverDiag ? serverDiag.currentSubscriptionCount : 0,
            endpointUrl: server.getEndpointUrl(),
            serverState: server.engine.serverStatus.state.toString(),
            buildInfo: server.engine.serverStatus.buildInfo
        };

        return {
            payload: info
        };
    }

    async function handleSetWritable(msg, namespace, addressSpace) {
        const nodeId = msg.nodeId || msg.topic;

        if (!nodeId) {
            throw new Error('nodeId missing');
        }

        const variable = addressSpace.findNode(nodeId) || namespace.findNode(nodeId);
        if (!variable) {
            throw new Error(`Node not found: ${nodeId}`);
        }

        const AccessLevelFlag = require('node-opcua').AccessLevelFlag;
        variable.accessLevel = AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite;
        variable.userAccessLevel = AccessLevelFlag.CurrentRead | AccessLevelFlag.CurrentWrite;

        return {
            payload: true,
            nodeId: nodeId
        };
    }

    async function handleRaiseEvent(msg, namespace, addressSpace) {
        const eventType = msg.eventType || msg.payload?.eventType || 'BaseEventType';
        const sourceNodeId = msg.sourceNodeId || msg.payload?.sourceNodeId;
        const message = msg.message || msg.payload?.message || '';
        const severity = msg.severity || msg.payload?.severity || 100;

        if (!sourceNodeId) {
            throw new Error('sourceNodeId missing');
        }

        const sourceNode = addressSpace.findNode(sourceNodeId) || namespace.findNode(sourceNodeId);
        if (!sourceNode) {
            throw new Error(`Source node not found: ${sourceNodeId}`);
        }

        const eventTypeNode = addressSpace.findEventType(eventType);
        if (!eventTypeNode) {
            throw new Error(`Event type not found: ${eventType}`);
        }

        sourceNode.raiseEvent(eventTypeNode, {
            message: {
                dataType: DataType.LocalizedText,
                value: coerceLocalizedText(message)
            },
            severity: {
                dataType: DataType.UInt16,
                value: severity
            }
        });

        return {
            payload: true,
            eventType: eventType,
            sourceNodeId: sourceNodeId,
            message: message,
            severity: severity
        };
    }

    function getDefaultValue(dataType) {
        switch (dataType) {
            case DataType.Boolean:
                return false;
            case DataType.Int8:
            case DataType.Int16:
            case DataType.Int32:
            case DataType.Int64:
            case DataType.UInt8:
            case DataType.UInt16:
            case DataType.UInt32:
            case DataType.UInt64:
                return 0;
            case DataType.Float:
            case DataType.Double:
                return 0.0;
            case DataType.String:
                return '';
            default:
                return null;
        }
    }

    RED.nodes.registerType('opcua-server', OpcUaServerNode);
};
