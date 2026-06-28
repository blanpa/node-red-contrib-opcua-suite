/**
 * OPC UA Item Node
 *
 * Configures one or more OPC UA items (variables) for read/write operations.
 * Items are added to msg.items for batch operations (collector mode),
 * or set on msg.topic/msg.datatype for single operations (legacy mode).
 *
 * Supports chaining: multiple Item nodes in series each append to msg.items.
 */

module.exports = function(RED) {
    function OpcUaItemNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.collector = config.collector !== undefined ? config.collector : true;

        // Optional: this node may impose the operation and/or request that the
        // client unwrap a single read result into a scalar payload.
        node.operation = config.operation || '';
        node.unwrapSingle = config.unwrapSingle === true || config.unwrapSingle === 'true';

        // Unified items list — also migrates old single-item format
        node.items = config.items || [];
        if (node.items.length === 0 && config.nodeId) {
            node.items = [{
                nodeId: config.nodeId,
                datatype: config.datatype || '',
                itemName: config.itemName || ''
            }];
        }

        // Status
        if (node.items.length === 1) {
            node.status({ fill: 'blue', shape: 'dot', text: node.items[0].itemName || node.items[0].nodeId });
        } else if (node.items.length > 1) {
            node.status({ fill: 'blue', shape: 'dot', text: node.items.length + ' items' });
        }

        node.on('input', function(msg, send, done) {
            // Item node may set the operation (so the downstream Client knows
            // what to do) and request single-value unwrapping. Set these early
            // so the write detection below sees the right operation. A value
            // already on msg is not overwritten unless this node configures one.
            if (node.operation) msg.operation = node.operation;
            if (node.unwrapSingle) msg.unwrapSingle = true;

            // Build list of configured items (skip empty nodeIds)
            const allItems = [];
            for (const cfg of node.items) {
                if (cfg.nodeId) {
                    allItems.push({
                        nodeId: cfg.nodeId,
                        datatype: cfg.datatype || undefined,
                        itemName: cfg.itemName || undefined
                    });
                }
            }

            // No items configured — pass through
            if (allItems.length === 0) {
                send(msg);
                done();
                return;
            }

            // If write operation: attach value from msg.payload
            const isWrite = msg.payload !== undefined &&
                (msg.operation === 'write' || msg.operation === 'writemultiple');
            if (isWrite) {
                for (const item of allItems) {
                    item.value = msg.payload;
                }
            }

            // Collector mode: add items to array
            if (node.collector || Array.isArray(msg.items)) {
                if (!Array.isArray(msg.items)) {
                    msg.items = [];
                }
                for (const item of allItems) {
                    msg.items.push(item);
                }
            } else {
                // Legacy mode: only first item
                const item = allItems[0];
                msg.topic = item.nodeId;
                msg.nodeId = item.nodeId;
                if (item.datatype) msg.datatype = item.datatype;
                if (item.itemName) msg.itemName = item.itemName;
            }

            send(msg);
            done();
        });
    }

    RED.nodes.registerType('opcua-item', OpcUaItemNode);
};
