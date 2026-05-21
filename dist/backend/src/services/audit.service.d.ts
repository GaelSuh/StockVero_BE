export declare function logAuditAction(adminId: string, tenantId: string, action: string, details?: Record<string, any>): Promise<{
    tenantId: string;
    id: string;
    createdAt: Date;
    action: string;
    details: import("@prisma/client/runtime/client").JsonValue;
    adminId: string;
}>;
