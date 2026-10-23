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
export declare const STORAGE_BUCKET: string;
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
export declare const PRIVATE_STORAGE_BUCKET: string;
export declare const supabase: import("@supabase/supabase-js").SupabaseClient<any, "public", "public", any, any> | null;
/**
 * Upload a buffer to the private bucket. Returns the object path — deliberately
 * not a URL, so a path cannot be mistaken for something directly fetchable.
 */
export declare const uploadPrivateFile: (path: string, body: Buffer, contentType?: string) => Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * Short-lived signed URL for a private object. Ten minutes: long enough to open
 * and read the document, short enough that a copied link is not a lasting leak.
 */
export declare const signPrivateFile: (path: string, expiresInSeconds?: number) => Promise<string | null>;
/** Remove a private object, e.g. an abandoned pending-signup upload. */
export declare const deletePrivateFile: (path: string) => Promise<void>;
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
