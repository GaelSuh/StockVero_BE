const DAY_MS = 24 * 60 * 60 * 1000;
export function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}
export function diffInDays(start, end) {
    return Math.ceil((end.getTime() - start.getTime()) / DAY_MS);
}
export function nowUtc() {
    return new Date();
}
