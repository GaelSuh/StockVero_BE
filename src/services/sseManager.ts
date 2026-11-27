import { Response, Request } from 'express';

interface SSEConnection {
  res: Response;
  tenantId: string;
  keepaliveInterval: ReturnType<typeof setInterval>;
}

const connections = new Map<string, SSEConnection>();

export function addConnection(userId: string, tenantId: string, req: Request, res: Response) {
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
  send(res, `data: ${JSON.stringify({ type: 'connected', message: 'SSE connection established' })}\n\n`);

  // Keepalive every 30 seconds
  const keepaliveInterval = setInterval(() => {
    try {
      send(res, ': keepalive\n\n');
    } catch {
      removeConnection(userId);
    }
  }, 20_000);

  connections.set(userId, { res, tenantId, keepaliveInterval });

  // Clean up on disconnect
  req.on('close', () => {
    removeConnection(userId);
  });
}

export function removeConnection(userId: string) {
  const conn = connections.get(userId);
  if (conn) {
    clearInterval(conn.keepaliveInterval);
    connections.delete(userId);
  }
}

export function pushToUser(userId: string, data: unknown) {
  const conn = connections.get(userId);
  if (!conn) return;
  try {
    send(conn.res, `data: ${JSON.stringify(data)}\n\n`);
  } catch {
    removeConnection(userId);
  }
}

export function getConnectionsForTenant(tenantId: string): string[] {
  const userIds: string[] = [];
  for (const [userId, conn] of connections.entries()) {
    if (conn.tenantId === tenantId) {
      userIds.push(userId);
    }
  }
  return userIds;
}

export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Writes and flushes: compression() otherwise holds the stream in its buffer,
 * and events reach the browser late, in batches, or not at all.
 */
function send(res: Response, chunk: string) {
  res.write(chunk);
  (res as Response & { flush?: () => void }).flush?.();
}
