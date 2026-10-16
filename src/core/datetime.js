/** One cached Intl.DateTimeFormat per (locale, timeZone, options). */

const cache = new Map();

function optionsKey(options) {
  const keys = Object.keys(options).sort();
  return keys.map((key) => `${key}=${options[key]}`).join("&");
}

/**
 * @param {string} locale
 * @param {string} timeZone
 * @param {Intl.DateTimeFormatOptions} options
 */
export function cachedDateTimeFormat(locale, timeZone, options) {
  const key = `${locale}\0${timeZone}\0${optionsKey(options)}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const format = new Intl.DateTimeFormat(locale, { ...options, timeZone });
  cache.set(key, format);
  return format;
}

const LOCAL_DATE_OPTIONS = { year: "numeric", month: "2-digit", day: "2-digit" };

/** `YYYY-MM-DD` for an instant in `timeZone`. */
export function formatLocalDate(date, timeZone) {
  const parts = cachedDateTimeFormat("en-CA", timeZone, LOCAL_DATE_OPTIONS).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const WALL_OPTIONS = {
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

/** Wall-clock parts of an instant in `timeZone`. */
export function wallClockParts(date, timeZone) {
  const parts = cachedDateTimeFormat("en-US", timeZone, WALL_OPTIONS).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` at `utcMs`, in milliseconds (local − UTC). */
export function zoneOffsetMs(utcMs, timeZone) {
  const wall = wallClockParts(new Date(utcMs), timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - utcMs;
}

/** Throws once per invalid zone, when the formatter is first built. */
export function assertTimeZone(timeZone) {
  cachedDateTimeFormat("en-US", timeZone, { hour: "2-digit" });
}

export function resetDateTimeFormatCache() {
  cache.clear();
}
