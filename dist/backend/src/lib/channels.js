/**
 * Resolves which sales channels a product should be available on.
 *
 * A shop that only runs one channel is never asked the question, so the answer
 * has to be derived rather than sent: the single active channel is enabled and
 * the other is not. Only an org running both channels gets to choose, and if it
 * chooses nothing it gets both — the common case, and the least friction.
 */
export function resolveChannelFlags(req, requested) {
    const modules = req.activeModules ?? [];
    const hasRetail = modules.includes('retail_sales');
    const hasWholesale = modules.includes('wholesale_sales');
    // Single-channel org: the choice is not the caller's to make. Ignoring the
    // request here also stops a stale client enabling a channel the org cannot use.
    if (hasRetail && !hasWholesale)
        return { retailEnabled: true, wholesaleEnabled: false };
    if (hasWholesale && !hasRetail)
        return { retailEnabled: false, wholesaleEnabled: true };
    // Neither module active (inventory-only org): leave both on so the product is
    // ready the moment a sales module is switched on.
    if (!hasRetail && !hasWholesale)
        return { retailEnabled: true, wholesaleEnabled: true };
    return {
        retailEnabled: requested.retailEnabled ?? true,
        wholesaleEnabled: requested.wholesaleEnabled ?? true,
    };
}
/** A product nobody can sell is not a product. */
export function channelsAreValid(flags) {
    return flags.retailEnabled || flags.wholesaleEnabled;
}
export const CHANNELS_REQUIRED_MESSAGE = 'A product must be available on at least one sales channel.';
