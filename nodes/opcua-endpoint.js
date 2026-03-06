/**
 * OPC UA Endpoint Configuration Node
 * Manages endpoint configurations and a shared OPC UA connection.
 * All client nodes with the same endpoint share a connection (connection sharing).
 */

const fs = require('fs');
const path = require('path');
const OpcUaClientManager = require('../lib/opcua-client-manager');

module.exports = function(RED) {

    // ─── Certificate Upload HTTP Endpoint ───
    const certsDir = path.join((RED.settings && RED.settings.userDir) || '/data', 'opcua-certs');
    if (!fs.existsSync(certsDir)) {
        try { fs.mkdirSync(certsDir, { recursive: true }); } catch (e) { /* ignore in test */ }
    }

    if (!RED.httpAdmin) {
        // Skip HTTP endpoints in test environment
    } else {

    RED.httpAdmin.post('/opcua-endpoint/upload-cert', function(req, res) {
        try {
            // Node-RED httpAdmin already parses JSON body via express.json()
            const data = req.body;
            if (!data || !data.content) {
                return res.status(400).json({ success: false, error: 'Missing content' });
            }
            const filename = (data.filename || 'cert.pem').replace(/[^a-zA-Z0-9._\-]/g, '_');
            const content = Buffer.from(data.content, 'base64');
            const destPath = path.join(certsDir, filename);
            fs.writeFileSync(destPath, content);
            res.json({ success: true, path: destPath, filename: filename, size: content.length });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    RED.httpAdmin.get('/opcua-endpoint/certs', function(req, res) {
        try {
            const files = fs.readdirSync(certsDir).filter(f => /\.(pem|der|crt|key|pfx|p12)$/i.test(f));
            res.json(files.map(f => ({ name: f, path: path.join(certsDir, f) })));
        } catch (e) {
            res.json([]);
        }
    });

    RED.httpAdmin.delete('/opcua-endpoint/upload-cert/:filename', function(req, res) {
        try {
            const filename = req.params.filename.replace(/[^a-zA-Z0-9._\-]/g, '_');
            const filePath = path.join(certsDir, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                res.json({ success: true });
            } else {
                res.status(404).json({ success: false, error: 'File not found' });
            }
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    } // end if (RED.httpAdmin)

    function OpcUaEndpointNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Endpoint URL
        node.endpointUrl = config.endpointUrl || 'opc.tcp://localhost:4840';

        // Security Settings
        node.securityMode = config.securityMode || 'None';
        node.securityPolicy = config.securityPolicy || 'None';

        // Transport Certificate Settings
        node.certificateFile = config.certificateFile || '';
        node.privateKeyFile = config.privateKeyFile || '';
        node.caCertificateFile = config.caCertificateFile || '';

        // User Certificate (X509 Token) Settings
        node.userCertificateFile = config.userCertificateFile || '';
        node.userPrivateKeyFile = config.userPrivateKeyFile || '';

        // ─── Shared Connection ───
        node._sharedManager = null;
        node._refCount = 0;
        node._statusCallbacks = new Set();

        node.getCertificateData = function() {
            const data = {};
            if (node.certificateFile && fs.existsSync(node.certificateFile)) {
                data.certificateFile = node.certificateFile;
            }
            if (node.privateKeyFile && fs.existsSync(node.privateKeyFile)) {
                data.privateKeyFile = node.privateKeyFile;
            }
            if (node.caCertificateFile && fs.existsSync(node.caCertificateFile)) {
                data.caCertificateFile = node.caCertificateFile;
            }
            if (node.userCertificateFile && fs.existsSync(node.userCertificateFile)) {
                data.userCertificateFile = node.userCertificateFile;
            }
            if (node.userPrivateKeyFile && fs.existsSync(node.userPrivateKeyFile)) {
                data.userPrivateKeyFile = node.userPrivateKeyFile;
            }
            return data;
        };

        /**
         * Returns the shared ClientManager (creates it on first call).
         * Each client node must call getSharedManager() on start and
         * releaseSharedManager() on close.
         */
        node.getSharedManager = function(clientConfig) {
            node._refCount++;
            node.log(`Connection ref +1 (now ${node._refCount})`);

            if (!node._sharedManager) {
                const certData = node.getCertificateData();
                const managerConfig = {
                    endpointUrl: node.endpointUrl,
                    userName: node.credentials?.userName || '',
                    password: node.credentials?.password || '',
                    securityMode: node.securityMode || 'None',
                    securityPolicy: node.securityPolicy || 'None',
                    applicationName: (clientConfig && clientConfig.applicationName) || 'Node-RED OPC UA Client',
                    maxReconnectAttempts: (clientConfig && clientConfig.maxReconnectAttempts) || 10,
                    reconnectDelay: (clientConfig && clientConfig.reconnectDelay) || 5000,
                    certificateFile: certData.certificateFile || '',
                    privateKeyFile: certData.privateKeyFile || '',
                    caCertificateFile: certData.caCertificateFile || '',
                    userCertificateFile: certData.userCertificateFile || '',
                    userPrivateKeyFile: certData.userPrivateKeyFile || ''
                };
                node._sharedManager = new OpcUaClientManager(managerConfig);

                // Propagate status events to all registered client nodes
                node._sharedManager.on('connected', () => {
                    node._statusCallbacks.forEach(cb => cb('connected'));
                });
                node._sharedManager.on('disconnected', () => {
                    node._statusCallbacks.forEach(cb => cb('disconnected'));
                });
                node._sharedManager.on('reconnecting', () => {
                    node._statusCallbacks.forEach(cb => cb('reconnecting'));
                });
                node._sharedManager.on('error', (error) => {
                    node._statusCallbacks.forEach(cb => cb('error', error));
                });

                node.log(`Shared connection created for ${node.endpointUrl}`);
            }

            return node._sharedManager;
        };

        /**
         * Registers a status callback for a client node.
         */
        node.registerStatusCallback = function(callback) {
            node._statusCallbacks.add(callback);
        };

        node.unregisterStatusCallback = function(callback) {
            node._statusCallbacks.delete(callback);
        };

        /**
         * Releases the shared connection. Disconnects only when the last client closes.
         */
        node.releaseSharedManager = async function() {
            node._refCount = Math.max(0, node._refCount - 1);
            node.log(`Connection ref -1 (now ${node._refCount})`);

            if (node._refCount === 0 && node._sharedManager) {
                node.log(`Last client closed — disconnecting from ${node.endpointUrl}`);
                try {
                    await node._sharedManager.disconnect();
                } catch (e) { /* ignore */ }
                node._sharedManager = null;
                node._statusCallbacks.clear();
            }
        };

        node.on('close', async function(done) {
            // Force cleanup if endpoint config itself is removed
            if (node._sharedManager) {
                try { await node._sharedManager.disconnect(); } catch (e) { /* ignore */ }
                node._sharedManager = null;
            }
            node._refCount = 0;
            node._statusCallbacks.clear();
            done();
        });
    }

    RED.nodes.registerType('opcua-endpoint', OpcUaEndpointNode, {
        credentials: {
            userName: { type: 'text' },
            password: { type: 'password' }
        }
    });
};
