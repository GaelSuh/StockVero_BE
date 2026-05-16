export declare const STORAGE_BUCKET: string;
export declare const supabase: import("@supabase/supabase-js").SupabaseClient<any, "public", "public", any, any> | null;
/**
 * Delete a single stored file by its URL. Convenience wrapper around deleteStorageFiles.
 */
export declare const deleteStoredFile: (url?: string | null) => Promise<void>;
/**
 * Extract the storage object key from a Supabase public URL.
 * Returns null if the URL is not a Supabase public URL for our bucket.
 */
export declare const extractStorageKey: (url: string) => string | null;
/**
 * Delete one or more files from Supabase storage by their public URLs.
 * Silently ignores local/non-Supabase URLs.
 */
export declare const deleteStorageFiles: (urls: string[]) => Promise<void>;
/**
 * Convert a Supabase public URL to a short-lived signed URL (1-hour TTL).
 * Returns the original URL unchanged if it's not a Supabase URL or signing fails.
 * Returns null if the input is null/undefined.
 */
export declare const resolveSignedUrl: (url?: string | null) => Promise<string | null>;
