import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';
/**
 * Supabase storage bucket.
 *
 * Still named solarflow-files, deliberately. The bucket name is baked into every
 * URL already written to the database — product images, documents, avatars and
 * tenant logos all point at /storage/v1/object/public/solarflow-files/... — so
 * changing this default alone would 404 all of them.
 *
 * Renaming it for real means: create stockvero-files in Supabase, copy the
 * objects across, rewrite the stored URLs, then set SUPABASE_STORAGE_BUCKET.
 * The env var already overrides this, so no code change is needed for that.
 */
export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'solarflow-files';

/**
 * Separate PRIVATE bucket, for objects that must never be readable by URL
 * alone — currently signup identity documents (tax certificates, national ID
 * cards).
 *
 * STORAGE_BUCKET above is a public bucket: every URL it hands out is fetchable
 * with no authentication at all, which is fine for product images and logos and
 * categorically not fine for someone's ID card. Objects here are addressed by
 * path only, and every read goes through a short-lived signed URL issued to an
 * authenticated admin.
 *
 * This bucket must exist and must have Public = OFF in Supabase.
 */
export const PRIVATE_STORAGE_BUCKET =
  process.env.SUPABASE_PRIVATE_BUCKET || 'stockvero-private';

export const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

/**
 * Upload a buffer to the private bucket. Returns the object path — deliberately
 * not a URL, so a path cannot be mistaken for something directly fetchable.
 */
export const uploadPrivateFile = async (
  path: string,
  body: Buffer,
  contentType?: string,
): Promise<{ ok: boolean; error?: string }> => {
  if (!supabase) return { ok: false, error: 'Storage is not configured.' };
  const { error } = await supabase.storage
    .from(PRIVATE_STORAGE_BUCKET)
    .upload(path, body, { contentType, upsert: false });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
};

/**
 * Short-lived signed URL for a private object. Ten minutes: long enough to open
 * and read the document, short enough that a copied link is not a lasting leak.
 */
export const signPrivateFile = async (
  path: string,
  expiresInSeconds = 10 * 60,
): Promise<string | null> => {
  if (!supabase) return null;
  const { data, error } = await supabase.storage
    .from(PRIVATE_STORAGE_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) {
    console.warn('[storage] Failed to sign private file:', error?.message);
    return null;
  }
  return data.signedUrl;
};

/** Remove a private object, e.g. an abandoned pending-signup upload. */
export const deletePrivateFile = async (path: string): Promise<void> => {
  if (!supabase) return;
  const { error } = await supabase.storage.from(PRIVATE_STORAGE_BUCKET).remove([path]);
  if (error) console.warn('[storage] Failed to delete private file:', error.message);
};

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
