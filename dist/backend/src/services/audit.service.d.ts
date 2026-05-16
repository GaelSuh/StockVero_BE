export declare function logAuditAction(adminId: string, tenantId: string, action: string, details?: Record<string, any>): Promise<{
    id: string;
    createdAt: Date;
    tenantId: string;
    action: string;
    details: import("@prisma/client/runtime/client").JsonValue;
    adminId: string;
}>;
