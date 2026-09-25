/**
 * Makes sure every module in MODULES_CONFIG has a row in the `modules` table.
 *
 * tenant_modules.module_key is a foreign key to modules.key, so a module that
 * exists in code but not in the database cannot be enabled for any tenant —
 * the insert fails and the admin panel gets a 500. That happened in production
 * when retail_sales / wholesale_sales shipped: migrations ran on deploy, the
 * seed did not.
 *
 * Only missing rows are created. Existing rows are left exactly as they are,
 * so an is_active flag or display name changed in the database survives a
 * restart. Runs once at startup; failure is logged, never fatal.
 */
export declare function syncModules(): Promise<void>;
