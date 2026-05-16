export const MODULE_KEYS = {
    DASHBOARD: 'dashboard',
    INVENTORY: 'inventory',
    CRM: 'crm',
    PROJECTS: 'projects',
    FINANCE: 'finance',
    ANALYTICS: 'analytics',
    BILLING: 'billing',
    SETTINGS: 'settings',
    ADMINISTRATION: 'administration',
    AUDIT: 'audit',
};
/** Modules permanently enabled for owner accounts regardless of DB state */
export const OWNER_PERMANENT_MODULES = [
    MODULE_KEYS.DASHBOARD,
    MODULE_KEYS.BILLING,
    MODULE_KEYS.SETTINGS,
    MODULE_KEYS.ADMINISTRATION,
    MODULE_KEYS.AUDIT,
];
export const MODULES_CONFIG = [
    {
        key: MODULE_KEYS.DASHBOARD,
        displayName: 'Dashboard',
        description: 'Overview metrics and summaries',
        table: null,
    },
    {
        key: MODULE_KEYS.INVENTORY,
        displayName: 'Inventory',
        description: 'Manage items, movements, and stock levels',
        table: 'inventory_items',
    },
    {
        key: MODULE_KEYS.CRM,
        displayName: 'CRM',
        description: 'CRM for customer relationships',
        table: 'customers',
    },
    {
        key: MODULE_KEYS.PROJECTS,
        displayName: 'Projects',
        description: 'Project tracking with milestones and materials',
        table: 'projects',
    },
    {
        key: MODULE_KEYS.FINANCE,
        displayName: 'Finance',
        description: 'Financial ledger and reporting',
        table: 'transactions',
    },
    {
        key: MODULE_KEYS.ANALYTICS,
        displayName: 'Analytics',
        description: 'Business insights and reporting',
        table: null,
    },
    {
        key: MODULE_KEYS.BILLING,
        displayName: 'Billing',
        description: 'Subscription, payments, and invoices',
        table: null,
    },
    {
        key: MODULE_KEYS.SETTINGS,
        displayName: 'Settings',
        description: 'Tenant configuration and preferences',
        table: null,
    },
    {
        key: MODULE_KEYS.ADMINISTRATION,
        displayName: 'Administration',
        description: 'Team management, roles, and permissions',
        table: null,
    },
    {
        key: MODULE_KEYS.AUDIT,
        displayName: 'Audit Log',
        description: 'System-wide activity and change history',
        table: 'audit_logs',
    },
];
