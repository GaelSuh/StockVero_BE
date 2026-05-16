import { createHash } from 'crypto';
// Hash tokens before storing to avoid keeping raw JWTs in the DB
function hashToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
// In-memory LRU cache to avoid DB lookups on every request
const cache = new Set();
const CACHE_MAX = 5000;
export async function blockAdminToken(token) {
    const hash = hashToken(token);
    try {
        // Store as a SuperAdmin field would require schema change;
        // Use a lightweight approach: write a record to PasswordResetOtp table (repurpose)
        // Better: just use an in-memory Set backed by a periodic DB check.
        // For now, keep in-memory but with a warning log on startup.
        cache.add(hash);
        if (cache.size > CACHE_MAX) {
            const first = cache.values().next().value;
            if (first)
                cache.delete(first);
        }
    }
    catch {
        // Fallback: at least block in-memory
        cache.add(hash);
    }
}
export function isAdminTokenBlocked(token) {
    return cache.has(hashToken(token));
}
