export function generateTemporaryPassword(seed: string, tenantSlug: string) {
  const namePart = seed.trim().toLowerCase();
  const tenantPart = tenantSlug.trim().toUpperCase();
  const random = Math.floor(100 + Math.random() * 900);
  return `${namePart}@${tenantPart}${random}`;
}

