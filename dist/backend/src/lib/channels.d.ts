import { AuthRequest } from '../types/index.js';
export interface ChannelFlags {
    retailEnabled: boolean;
    wholesaleEnabled: boolean;
}
/**
 * Resolves which sales channels a product should be available on.
 *
 * A shop that only runs one channel is never asked the question, so the answer
 * has to be derived rather than sent: the single active channel is enabled and
 * the other is not. Only an org running both channels gets to choose, and if it
 * chooses nothing it gets both — the common case, and the least friction.
 */
export declare function resolveChannelFlags(req: AuthRequest, requested: {
    retailEnabled?: boolean;
    wholesaleEnabled?: boolean;
}): ChannelFlags;
/** A product nobody can sell is not a product. */
export declare function channelsAreValid(flags: ChannelFlags): boolean;
export declare const CHANNELS_REQUIRED_MESSAGE = "A product must be available on at least one sales channel.";
