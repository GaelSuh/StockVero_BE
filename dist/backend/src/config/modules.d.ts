export declare const MODULE_KEYS: {
    readonly DASHBOARD: "dashboard";
    readonly INVENTORY: "inventory";
    readonly CRM: "crm";
    readonly PROJECTS: "projects";
    readonly FINANCE: "finance";
    readonly ANALYTICS: "analytics";
    readonly BILLING: "billing";
    readonly SETTINGS: "settings";
    readonly ADMINISTRATION: "administration";
    readonly AUDIT: "audit";
};
/** Modules permanently enabled for owner accounts regardless of DB state */
export declare const OWNER_PERMANENT_MODULES: readonly ["dashboard", "billing", "settings", "administration", "audit"];
export declare const MODULES_CONFIG: ({
    key: "dashboard";
    displayName: string;
    description: string;
    table: null;
} | {
    key: "inventory";
    displayName: string;
    description: string;
    table: string;
} | {
    key: "crm";
    displayName: string;
    description: string;
    table: string;
} | {
    key: "projects";
    displayName: string;
    description: string;
    table: string;
} | {
    key: "finance";
    displayName: string;
    description: string;
    table: string;
} | {
    key: "analytics";
    displayName: string;
    description: string;
    table: null;
} | {
    key: "billing";
    displayName: string;
    description: string;
    table: null;
} | {
    key: "settings";
    displayName: string;
    description: string;
    table: null;
} | {
    key: "administration";
    displayName: string;
    description: string;
    table: null;
} | {
    key: "audit";
    displayName: string;
    description: string;
    table: string;
})[];
