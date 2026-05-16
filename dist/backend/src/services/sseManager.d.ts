import { Response, Request } from 'express';
export declare function addConnection(userId: string, tenantId: string, req: Request, res: Response): void;
export declare function removeConnection(userId: string): void;
export declare function pushToUser(userId: string, data: unknown): void;
export declare function getConnectionsForTenant(tenantId: string): string[];
export declare function getConnectionCount(): number;
