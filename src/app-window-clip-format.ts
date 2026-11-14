const millisecondsPerDay = 86_400_000;
const secondsPerMinute = 60;
const secondsPadLength = 2;
const bytesPerKilobyte = 1000;
const bytesPerMegabyte = 1_000_000;
const bytesPerGigabyte = 1_000_000_000;
const dayFormatter = new Intl.DateTimeFormat([], { day: "numeric", month: "long", weekday: "long" });
const yearDayFormatter = new Intl.DateTimeFormat([], { day: "numeric", month: "long", year: "numeric" });
const shortDayFormatter = new Intl.DateTimeFormat([], { day: "numeric", month: "short" });
const shortYearDayFormatter = new Intl.DateTimeFormat([], { day: "numeric", month: "short", year: "numeric" });
const timeFormatter = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });

export function clipDayLabel(date: Date): string {
  return relativeDayLabel(date) ?? (isThisYear(date) ? dayFormatter.format(date) : yearDayFormatter.format(date));
}

export function clipShortDateTimeLabel(date: Date): string {
  const day = relativeDayLabel(date) ?? (isThisYear(date) ? shortDayFormatter.format(date) : shortYearDayFormatter.format(date));
  return `${day}, ${clipTimeLabel(date)}`;
}

export function clipTimeLabel(date: Date): string {
  return timeFormatter.format(date);
}

export function formatClipDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(1, Math.round(durationSeconds));
  const minutes = Math.floor(totalSeconds / secondsPerMinute);
  const seconds = totalSeconds % secondsPerMinute;
  return `${String(minutes)}:${String(seconds).padStart(secondsPadLength, "0")}`;
}

export function formatClipBytes(byteCount: number): string {
  if (byteCount >= bytesPerGigabyte) {
    return `${(byteCount / bytesPerGigabyte).toFixed(1)} GB`;
  }

  if (byteCount >= bytesPerMegabyte) {
    return `${String(Math.round(byteCount / bytesPerMegabyte))} MB`;
  }

  return `${String(Math.max(1, Math.round(byteCount / bytesPerKilobyte)))} KB`;
}

function relativeDayLabel(date: Date): string | null {
  const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(date)) / millisecondsPerDay);
  if (daysAgo === 0) {
    return "Today";
  }

  return daysAgo === 1 ? "Yesterday" : null;
}

function isThisYear(date: Date): boolean {
  return date.getFullYear() === new Date().getFullYear();
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
