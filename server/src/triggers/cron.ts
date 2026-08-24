/**
 * A five-field cron matcher: minute, hour, day-of-month, month, day-of-week.
 *
 * `matches(expr, date)` answers "should a schedule fire in this minute" — the scheduler wakes once
 * a minute and asks, so there is no next-run arithmetic to get wrong across DST. Supported per
 * field: `*`, numbers, ranges (1-5), lists (1,3,5), and steps (*\/15, 2-10/2). Day-of-month and
 * day-of-week combine as standard cron does: when both are restricted, either matching fires.
 */

const BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const bounds = BOUNDS[index];
    return bounds !== undefined && parseField(field, bounds) !== null;
  });
}

export function matches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  const parsed = fields.map((field, index) => {
    const bounds = BOUNDS[index];
    return bounds ? parseField(field, bounds) : null;
  });
  if (parsed.some((set) => set === null)) return false;
  const sets = parsed as Set<number>[];

  const [minute, hour, dayOfMonth, month, dayOfWeek] = sets;
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return false;
  if (
    !minute.has(values[0] as number) ||
    !hour.has(values[1] as number) ||
    !month.has(values[3] as number)
  ) {
    return false;
  }
  // Standard cron: if both day fields are restricted, either may match; if one is `*`, the
  // other decides alone.
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";
  const domMatch = dayOfMonth.has(values[2] as number);
  const dowMatch = dayOfWeek.has(values[4] as number);
  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  if (domRestricted) return domMatch;
  if (dowRestricted) return dowMatch;
  return true;
}

function parseField(
  field: string,
  [low, high]: [number, number],
): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number;
    let to: number;
    if (rangePart === "*" || rangePart === "") {
      from = low;
      to = high;
    } else if (rangePart?.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (
        a === undefined ||
        b === undefined ||
        !Number.isInteger(a) ||
        !Number.isInteger(b)
      ) {
        return null;
      }
      from = a;
      to = b;
    } else {
      const value = Number(rangePart);
      if (!Number.isInteger(value)) return null;
      from = value;
      to = stepPart === undefined ? value : high;
    }
    if (from < low || to > high || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}
