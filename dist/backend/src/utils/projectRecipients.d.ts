export type Recipient = {
    id: string;
    type: 'OWNER' | 'EMPLOYEE';
};
export declare function getProjectAccessRecipients(tenantId: string): Promise<Recipient[]>;
/**
 * Returns recipients specifically assigned to a project via ProjectAssignment records.
 * Falls back to all project-module users if no explicit assignments exist.
 */
export declare function getProjectSpecificRecipients(projectId: string): Promise<Recipient[]>;
