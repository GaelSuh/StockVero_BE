/**
 * Resolves the display name of whoever performed an action, from the database
 * rather than from the request or the token.
 *
 * Sales were storing whatever the client sent (or a token field that is not
 * always populated), which produced empty "Sold by" values that cannot be
 * recovered later. Looking the person up is the only reliable source.
 */
export declare function resolvePersonName(id: string, type: 'OWNER' | 'EMPLOYEE'): Promise<string>;
/**
 * Fills in a name that was never recorded, for rows written before the name was
 * resolved properly. Returns the stored value untouched when it has one.
 */
export declare function backfillPersonName(stored: string | null | undefined, id: string, type: 'OWNER' | 'EMPLOYEE'): Promise<string>;
