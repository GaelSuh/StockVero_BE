/** 3–20 chars, lowercase letters, numbers and hyphens only */
const SLUG_REGEX = /^[a-z0-9-]{3,20}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}

/**
 * Auto-generate a slug from an organisation name.
 * – Uses first word only if it is ≥ 4 chars.
 * – Combines first two words if the first is under 4 chars.
 * – Truncates to 20 chars.
 */
export function generateSlug(orgName: string): string {
  const words = orgName.trim().toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  let slug = words[0] || 'tenant';

  if (slug.length < 4 && words[1]) {
    slug = words[0] + words[1];
  }

  return slug.slice(0, 20);
}

/** @deprecated Use generateSlug instead */
export function slugifyTenant(name: string): string {
  return generateSlug(name);
}

