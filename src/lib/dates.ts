const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function diffInDays(start: Date, end: Date) {
  return Math.ceil((end.getTime() - start.getTime()) / DAY_MS);
}

export function nowUtc() {
  return new Date();
}
