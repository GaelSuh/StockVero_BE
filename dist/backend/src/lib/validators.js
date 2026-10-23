/**
 * Shared validation rules.
 *
 * Kept central so signup, onboarding, and any future edits enforce the same
 * shape rather than each drifting independently.
 */
/** Expected length of the local (no-prefix) part, keyed by country dial code. */
const LOCAL_LENGTH = {
    '+237': 9, // Cameroon
    '+234': 10, // Nigeria
    '+233': 9, // Ghana
    '+254': 9, // Kenya
    '+225': 10, // Côte d'Ivoire
    '+221': 9, // Senegal
    '+223': 8, // Mali
    '+226': 8, // Burkina Faso
    '+228': 8, // Togo
    '+241': 7, // Gabon
    '+242': 9, // Congo (Republic)
    '+243': 9, // Congo (DRC)
    '+256': 9, // Uganda
    '+255': 9, // Tanzania
    '+27': 9, // South Africa
    '+1': 10, // US / Canada
    '+44': 10, // UK
    '+33': 9, // France
    '+244': 9, // Angola
    '+229': 8, // Benin
    '+250': 9, // Rwanda
    '+251': 9, // Ethiopia
    '+263': 9, // Zimbabwe
    '+260': 9, // Zambia
    '+265': 9, // Malawi
    '+258': 9, // Mozambique
    '+91': 10, // India
    '+971': 9, // UAE
    '+966': 9, // Saudi Arabia
    '+55': 11, // Brazil
    '+52': 10, // Mexico
    '+61': 9, // Australia
    '+86': 11, // China
    '+81': 10, // Japan
    '+49': 11, // Germany
    '+39': 10, // Italy
    '+34': 9, // Spain
    '+351': 9, // Portugal
    '+41': 9, // Switzerland
    '+31': 9, // Netherlands
};
/** Longest local length, used as a sanity bound for unknown countries. */
const MAX_LOCAL_LENGTH = Math.max(...Object.values(LOCAL_LENGTH));
/** Resolve a country name/code to a dial code, e.g. "Cameroon" → "+237". */
export function countryToDialCode(country) {
    const name = (country ?? '').trim().toLowerCase();
    const byName = {
        cameroon: '+237',
        nigeria: '+234',
        ghana: '+233',
        kenya: '+254',
        "côte d'ivoire": '+225',
        senegal: '+221',
        mali: '+223',
        'burkina faso': '+226',
        togo: '+228',
        gabon: '+241',
        'congo (republic of the)': '+242',
        'congo (drc)': '+243',
        uganda: '+256',
        tanzania: '+255',
        'south africa': '+27',
        'united states': '+1',
        canada: '+1',
        'united kingdom': '+44',
        france: '+33',
        angola: '+244',
        benin: '+229',
        rwanda: '+250',
        ethiopia: '+251',
        zimbabwe: '+263',
        zambia: '+260',
        malawi: '+265',
        mozambique: '+258',
        india: '+91',
        'united arab emirates': '+971',
        'saudi arabia': '+966',
        brazil: '+55',
        mexico: '+52',
        australia: '+61',
        china: '+86',
        japan: '+81',
        germany: '+49',
        italy: '+39',
        spain: '+34',
        portugal: '+351',
        switzerland: '+41',
        netherlands: '+31',
    };
    const dial = byName[name] ?? null;
    if (dial)
        return dial;
    return LOCAL_LENGTH[name] ? `+${name}` : null;
}
/**
 * Validates a phone number for a given country. When no country is provided it
 * falls back to the original Cameroon-only rule so existing callers keep working.
 */
export function isValidPhone(value, country) {
    const trimmed = (value ?? '').trim();
    if (!trimmed)
        return false;
    const reduced = (s) => s.replace(/[^\d]/g, '');
    const digits = reduced(trimmed);
    const dial = country ? countryToDialCode(country) : '+237';
    if (!dial || LOCAL_LENGTH[dial] == null) {
        // Unknown country: accept a plausible E.164 range.
        return digits.length >= 6 && digits.length <= 15;
    }
    const localLen = LOCAL_LENGTH[dial];
    const prefix = dial.replace(/\D/g, '');
    const local = digits.startsWith(prefix) ? digits.slice(prefix.length) : digits;
    if (local.length === localLen)
        return true;
    // Tolerate a leading 0 that some countries dial locally, e.g. 06XXXXXXXX.
    if (local.length === localLen + 1 && local.startsWith('0'))
        return true;
    return false;
}
/**
 * Cameroon-only number check. Kept for back-compat; new code should prefer
 * `isValidPhone(value, country)`.
 */
export function isValidCameroonPhone(value) {
    return isValidPhone(value, 'Cameroon');
}
export function checkPasswordStrength(password) {
    const length = password.length >= 8;
    const uppercase = /[A-Z]/.test(password);
    const lowercase = /[a-z]/.test(password);
    const number = /\d/.test(password);
    const symbol = /[^A-Za-z0-9]/.test(password);
    // Length and a symbol are non-negotiable; the remainder are encouraged.
    const strong = length && symbol;
    return { length, uppercase, lowercase, number, symbol, strong };
}
export function passwordStrengthMessage(password) {
    const s = checkPasswordStrength(password);
    if (!s.length)
        return 'Password must be at least 8 characters long.';
    if (!s.symbol)
        return 'Password must include at least one symbol (e.g. @, #, $, !).';
    return null;
}
