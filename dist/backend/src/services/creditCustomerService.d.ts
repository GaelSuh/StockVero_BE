type Tx = any;
/** Digits only, so 6 77 12 34 56 and 677123456 are recognised as one person. */
export declare const normalizePhone: (raw: string) => string;
/**
 * Finds or creates the lightweight customer behind a retail credit sale.
 *
 * A shop extending credit over the counter should not be sent to a customer
 * registration screen mid-sale — but the debt still has to be attached to
 * somebody, or it never appears in Credit Customers and the owner has no record
 * of who owes them. getCreditCustomers skips any sale without a customer row,
 * which is exactly what used to happen to these.
 *
 * Phone is the identity: it is the one thing a shopkeeper reliably asks for, and
 * it is what makes the second sale to the same person attach to the same record
 * instead of creating a duplicate.
 */
export declare function findOrCreateCreditCustomer(tx: Tx, tenantId: string, input: {
    phone: string;
    name?: string | null;
}): Promise<{
    id: string;
    name: string;
    created: boolean;
}>;
export {};
