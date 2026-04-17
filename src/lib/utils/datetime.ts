const MOSCOW_TIMEZONE = "Europe/Moscow";

function getFormatter(options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TIMEZONE,
    ...options
  });
}

export function formatDisplayDate(value: string | Date): string {
  return getFormatter({
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(value));
}

export function formatDisplayTime(value: string | Date): string {
  return getFormatter({
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

export function displayDateToUnix(date: string): number {
  const [day, month, year] = date.split(".");
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  return Math.floor(parsed.getTime() / 1000);
}
