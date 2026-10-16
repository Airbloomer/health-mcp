import { formatLocalDate } from "./datetime.js";
import { DEFAULT_TIME_ZONE } from "./metrics.js";

// "2026-10-15 07:00:00 -0700" or ISO. Offset-bearing timestamps keep the
// calendar date in the string. Everything else is formatted in `timeZone`.
const OFFSET_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?/;

export function localDate(value, timeZone = DEFAULT_TIME_ZONE) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(OFFSET_RE);
  if (match && match[3]) return match[1];
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
  }
  return formatLocalDate(date, timeZone || DEFAULT_TIME_ZONE);
}
