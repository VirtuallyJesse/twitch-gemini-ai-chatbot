const two = (n: number) => n.toString().padStart(2, '0');

export const clockHM = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;

export function fmtSecs(s: number): string {
  if (!isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function timeAgo(timestampOrMinutes: number | string | Date): string {
  let min: number;
  if (typeof timestampOrMinutes === 'number') {
    if (timestampOrMinutes > 100000000000) {
      // Millisecond epoch
      min = Math.floor((Date.now() - timestampOrMinutes) / 60000);
    } else if (timestampOrMinutes > 1000000000) {
      // Second epoch
      min = Math.floor((Date.now() - timestampOrMinutes * 1000) / 60000);
    } else {
      // Direct minute offset
      min = timestampOrMinutes;
    }
  } else if (typeof timestampOrMinutes === 'string') {
    const parsed = Date.parse(timestampOrMinutes);
    if (isNaN(parsed)) return '';
    min = Math.floor((Date.now() - parsed) / 60000);
  } else if (timestampOrMinutes instanceof Date) {
    min = Math.floor((Date.now() - timestampOrMinutes.getTime()) / 60000);
  } else {
    return '';
  }

  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (min < 1440) return `${Math.floor(min / 60)}h ago`;
  if (min < 10080) return `${Math.floor(min / 1440)}d ago`;
  return `${Math.floor(min / 10080)}w ago`;
}
