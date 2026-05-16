const connections = new Map();
export function addConnection(userId, tenantId, req, res) {
    // Remove any existing connection for this user
    removeConnection(userId);
    // Set SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
    });
    // Send initial connected event
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'SSE connection established' })}\n\n`);
    // Keepalive every 30 seconds
    const keepaliveInterval = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
        }
        catch {
            removeConnection(userId);
        }
    }, 20000);
    connections.set(userId, { res, tenantId, keepaliveInterval });
    // Clean up on disconnect
    req.on('close', () => {
        removeConnection(userId);
    });
}
export function removeConnection(userId) {
    const conn = connections.get(userId);
    if (conn) {
        clearInterval(conn.keepaliveInterval);
        connections.delete(userId);
    }
}
export function pushToUser(userId, data) {
    const conn = connections.get(userId);
    if (!conn)
        return;
    try {
        conn.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
    catch {
        removeConnection(userId);
    }
}
export function getConnectionsForTenant(tenantId) {
    const userIds = [];
    for (const [userId, conn] of connections.entries()) {
        if (conn.tenantId === tenantId) {
            userIds.push(userId);
        }
    }
    return userIds;
}
export function getConnectionCount() {
    return connections.size;
}
