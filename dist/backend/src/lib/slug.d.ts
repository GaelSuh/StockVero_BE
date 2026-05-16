export declare function isValidSlug(slug: string): boolean;
/**
 * Auto-generate a slug from an organisation name.
 * – Uses first word only if it is ≥ 4 chars.
 * – Combines first two words if the first is under 4 chars.
 * – Truncates to 20 chars.
 */
export declare function generateSlug(orgName: string): string;
/** @deprecated Use generateSlug instead */
export declare function slugifyTenant(name: string): string;
