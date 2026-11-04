export const TIME_ZONE = 'Europe/Paris';

export function dayAt(timestamp = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp));
}

// Real elapsed seconds, split at local midnight (including DST changes).
export function splitInterval(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const result = [];
  let cursor = start;
  while (cursor < end) {
    const day = dayAt(cursor);
    let boundary = end;
    if (dayAt(end - 1) !== day) {
      let lo = cursor, hi = end;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (dayAt(mid) === day) lo = mid;
        else hi = mid;
      }
      boundary = hi;
    }
    const seconds = Math.floor(boundary / 1000) - Math.floor(cursor / 1000);
    if (seconds > 0) result.push({ day, seconds, start: cursor, end: boundary });
    cursor = boundary;
  }
  return result;
}
