import { describe, expect, test } from "bun:test";
import { isValidCron, matches } from "../src/triggers/cron";

/** The cron matcher: fields, steps, ranges, lists, and the day-of-month/day-of-week union. */

function at(minute: number, hour: number, day: number, month: number): Date {
  // month is 1-based here; day chosen so weekday is deterministic per test.
  return new Date(2026, month - 1, day, hour, minute, 0, 0);
}

describe("cron matcher", () => {
  test("every minute", () => {
    expect(matches("* * * * *", at(13, 9, 15, 6))).toBe(true);
  });

  test("specific minute and hour", () => {
    expect(matches("0 7 * * *", at(0, 7, 1, 1))).toBe(true);
    expect(matches("0 7 * * *", at(1, 7, 1, 1))).toBe(false);
    expect(matches("0 7 * * *", at(0, 8, 1, 1))).toBe(false);
  });

  test("steps and ranges", () => {
    expect(matches("*/15 * * * *", at(30, 3, 1, 1))).toBe(true);
    expect(matches("*/15 * * * *", at(20, 3, 1, 1))).toBe(false);
    expect(matches("0 9-17 * * *", at(0, 12, 1, 1))).toBe(true);
    expect(matches("0 9-17 * * *", at(0, 18, 1, 1))).toBe(false);
    expect(matches("0 9-17/4 * * *", at(0, 13, 1, 1))).toBe(true);
    expect(matches("0 9-17/4 * * *", at(0, 12, 1, 1))).toBe(false);
  });

  test("weekday restriction", () => {
    // 2026-06-15 is a Monday.
    expect(matches("0 7 * * 1-5", at(0, 7, 15, 6))).toBe(true);
    // 2026-06-14 is a Sunday.
    expect(matches("0 7 * * 1-5", at(0, 7, 14, 6))).toBe(false);
  });

  test("day-of-month OR day-of-week when both are restricted (standard cron)", () => {
    // 2026-06-14 is a Sunday (dow 0) and the 14th. Expression: the 1st OR Sundays.
    expect(matches("0 0 1 * 0", at(0, 0, 14, 6))).toBe(true);
    // 2026-06-16 is a Tuesday, and not the 1st.
    expect(matches("0 0 1 * 0", at(0, 0, 16, 6))).toBe(false);
  });

  test("validation", () => {
    expect(isValidCron("0 7 * * 1-5")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("* * * *")).toBe(false); // four fields
    expect(isValidCron("61 * * * *")).toBe(false); // out of range
    expect(isValidCron("a * * * *")).toBe(false);
    expect(isValidCron("5-1 * * * *")).toBe(false); // inverted range
  });
});
