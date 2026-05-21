interface SendNotificationParams {
    tenantId: string;
    userId: string;
    userType: 'OWNER' | 'EMPLOYEE';
    type: string;
    title: string;
    message: string;
    link?: string;
    /** The module this notification belongs to — used to check user category prefs */
    moduleKey?: string;
}
interface BroadcastParams {
    type: string;
    title: string;
    message: string;
    link?: string;
}
export declare function sendNotification(params: SendNotificationParams): Promise<{
    tenantId: string;
    id: string;
    userId: string;
    createdAt: Date;
    link: string | null;
    userType: import("@prisma/client").$Enums.NotificationUserType;
    type: string;
    title: string;
    message: string;
    isRead: boolean;
} | null>;
export declare function broadcastToTenant(tenantId: string, params: BroadcastParams): Promise<void>;
/**
 * Sends a notification to all users in a tenant who have at least 'read' access to a specific module.
 * Each recipient's category toggle and cadence preference are respected.
 * Owners always receive the notification (subject to their own preferences).
 */
export declare function broadcastToModule(tenantId: string, moduleKey: string, params: BroadcastParams): Promise<void>;
export {};
