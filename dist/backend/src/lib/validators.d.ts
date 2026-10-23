/**
 * Shared validation rules.
 *
 * Kept central so signup, onboarding, and any future edits enforce the same
 * shape rather than each drifting independently.
 */
/** Resolve a country name/code to a dial code, e.g. "Cameroon" → "+237". */
export declare function countryToDialCode(country: string): string | null;
/**
 * Validates a phone number for a given country. When no country is provided it
 * falls back to the original Cameroon-only rule so existing callers keep working.
 */
export declare function isValidPhone(value: string, country?: string): boolean;
/**
 * Cameroon-only number check. Kept for back-compat; new code should prefer
 * `isValidPhone(value, country)`.
 */
export declare function isValidCameroonPhone(value: string): boolean;
/**
 * Password strength rules.
 * A "strong" password is at least 8 characters and contains an uppercase
 * letter, a lowercase letter, a digit, and a symbol. Length and symbol are
 * required; the rest are strongly encouraged.
 */
export interface PasswordStrength {
    length: boolean;
    uppercase: boolean;
    lowercase: boolean;
    number: boolean;
    symbol: boolean;
    strong: boolean;
}
export declare function checkPasswordStrength(password: string): PasswordStrength;
export declare function passwordStrengthMessage(password: string): string | null;
