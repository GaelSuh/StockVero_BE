import { NextFunction, Response } from 'express';
import { AuthRequest } from '../types/index.js';
import { getConnectionsForTenant, pushToUser } from './sseManager.js';

/**
 * Tells the company's open sessions that data changed, so their browser caches
 * refresh only what is stale: the branch on screen at once, other branches when
 * they are opened again. Carries no data, only where the change happened.
 *
 * ponytail: the SSE connections live in this process's memory. With more than
 * one Railway replica, publish this through Redis pub/sub and let every replica
 * push to its own connections.
 */

/** Writes here are not data changes anyone else caches. */
const IGNORED = new Set(['auth', 'notifications', 'files']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function announceChanges(req: AuthRequest, res: Response, next: NextFunction) {
  if (READ_METHODS.has(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.tenantId || !req.user) return;
    const module = /^\/api\/v1\/([^/?]+)/.exec(req.originalUrl)?.[1];
    if (!module || IGNORED.has(module)) return;
    const event = { type: 'data-changed', branchId: req.branchId ?? null, module, by: req.user.id };
    for (const userId of getConnectionsForTenant(req.tenantId)) {
      if (userId !== req.user.id) pushToUser(userId, event);
    }
  });
  next();
}
