/**
 * Converts a wall-clock time in an IANA time zone (as typed into a datetime-local input,
 * "2026-10-20T23:59") to the UTC instant. Handles DST by correcting with the zone's
 * actual offset at the result.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) throw new RangeError(`Invalid local date-time: ${local}`);
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  const s = m[6] ? Number(m[6]) : 0;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asUtc - offsetMs(new Date(asUtc), timeZone);
  guess = asUtc - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** The zone's UTC offset in ms at `instant` (positive east of Greenwich). */
export function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The inverse, for pre-filling datetime-local inputs: "YYYY-MM-DDTHH:mm" in the zone. */
export function utcToZonedLocal(instant: Date, timeZone: string): string {
  const local = new Date(instant.getTime() + offsetMs(instant, timeZone));
  return local.toISOString().slice(0, 16);
}

export function formatInZone(instant: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(instant));
}
