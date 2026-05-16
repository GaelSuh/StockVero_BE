import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';
export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'solarflow-files';

export const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

/**
 * Delete a single stored file by its URL. Convenience wrapper around deleteStorageFiles.
 */
export const deleteStoredFile = async (url?: string | null): Promise<void> => {
  if (!url) return;
  await deleteStorageFiles([url]);
};

/**
 * Extract the storage object key from a Supabase public URL.
 * Returns null if the URL is not a Supabase public URL for our bucket.
 */
export const extractStorageKey = (url: string): string | null => {
  if (!supabaseUrl) return null;
  try {
    const parsed = new URL(url);
    const origin = new URL(supabaseUrl).origin;
    if (parsed.origin !== origin) return null;
    const prefix = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
    const idx = parsed.pathname.indexOf(prefix);
    if (idx === -1) return null;
    return decodeURIComponent(parsed.pathname.slice(idx + prefix.length));
  } catch {
    return null;
  }
};

/**
 * Delete one or more files from Supabase storage by their public URLs.
 * Silently ignores local/non-Supabase URLs.
 */
export const deleteStorageFiles = async (urls: string[]): Promise<void> => {
  if (!supabase || !urls.length) return;
  const keys = urls.map(extractStorageKey).filter((k): k is string => Boolean(k));
  if (!keys.length) return;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(keys);
  if (error) console.warn('[storage] Failed to delete files:', error.message);
};

/**
 * Convert a Supabase public URL to a short-lived signed URL (1-hour TTL).
 * Returns the original URL unchanged if it's not a Supabase URL or signing fails.
 * Returns null if the input is null/undefined.
 */
export const resolveSignedUrl = async (url?: string | null): Promise<string | null> => {
  if (!url) return null;
  if (!supabase) return url;
  try {
    const parsed = new URL(url);
    const supabaseOrigin = new URL(supabaseUrl).origin;
    const publicPrefix = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
    const signedPrefix = `/storage/v1/object/sign/${STORAGE_BUCKET}/`;

    if (parsed.origin !== supabaseOrigin) return url;
    if (parsed.pathname.includes(signedPrefix)) return url;
    if (!parsed.pathname.includes(publicPrefix)) return url;

    const key = decodeURIComponent(parsed.pathname.split(publicPrefix)[1] ?? '');
    if (!key) return url;

    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(key, 60 * 60);
    if (error || !data?.signedUrl) return url;
    return data.signedUrl;
  } catch {
    return url;
  }
};
