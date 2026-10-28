export const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function getStoredTimeZone() {
  try {
    return localStorage.getItem('skylineTimeZone') || 'system';
  } catch {
    return 'system';
  }
}

export function getAppTimeZone() {
  const stored = getStoredTimeZone();
  if (stored === 'system') return Intl.DateTimeFormat().resolvedOptions().timeZone || SYSTEM_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: stored });
    return stored;
  } catch {
    return SYSTEM_TIME_ZONE;
  }
}

// API timestamps are UTC instants. Some older records may arrive as ISO strings
// without an explicit timezone; treat those as UTC rather than interpreting them
// as the viewer's local wall-clock time.
function parseAppDate(value: string | number | Date) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) {
    return new Date(value + 'Z');
  }
  return new Date(value);
}

export function formatAppTime(value: string | number | Date, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    ...options,
    timeZone: getAppTimeZone(),
  }).format(parseAppDate(value));
}

export function formatAppDate(value: string | number | Date, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...options,
    timeZone: getAppTimeZone(),
  }).format(parseAppDate(value));
}

export function formatAppDateTime(value: string | number | Date, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options,
    timeZone: getAppTimeZone(),
  }).format(parseAppDate(value));
}

export function formatTimeZoneOffset(date = new Date(), timeZone = getAppTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  return parts.find((part) => part.type === 'timeZoneName')?.value || 'UTC';
}
