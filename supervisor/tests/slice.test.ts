import { describe, expect, test } from "bun:test";
import {
  admit,
  budgetFromEnvironment,
  capacity,
  countsAgainstBudget,
  reservationFromEnvironment,
  SliceExhaustedError,
} from "../src/slice";

const GiB = 1024 ** 3;

describe("slice admission", () => {
  test("admits while the budget holds, refuses the computer that would exceed it", () => {
    const budget = { cpus: 4, memoryBytes: 8 * GiB };
    const one = { cpus: 1, memoryBytes: 2 * GiB };
    expect(() => admit(budget, [], one)).not.toThrow();
    expect(() => admit(budget, [one, one, one], one)).not.toThrow();
    expect(() => admit(budget, [one, one, one, one], one)).toThrow(
      SliceExhaustedError,
    );
  });

  test("names the dimension that refused", () => {
    expect(() =>
      admit({ cpus: 2 }, [{ cpus: 2, memoryBytes: 0 }], {
        cpus: 1,
        memoryBytes: 2 * GiB,
      }),
    ).toThrow(/cpus/);
    expect(() =>
      admit({ memoryBytes: 2 * GiB }, [{ cpus: 0, memoryBytes: 2 * GiB }], {
        cpus: 1,
        memoryBytes: GiB,
      }),
    ).toThrow(/memory/);
  });

  test("an unlimited dimension never refuses", () => {
    const many = Array.from({ length: 100 }, () => ({
      cpus: 4,
      memoryBytes: 16 * GiB,
    }));
    expect(() =>
      admit({}, many, { cpus: 4, memoryBytes: 16 * GiB }),
    ).not.toThrow();
  });

  test("fractional cores do not refuse on floating-point noise", () => {
    const budget = { cpus: 0.3 };
    const tenth = { cpus: 0.1, memoryBytes: 0 };
    expect(() => admit(budget, [tenth, tenth], tenth)).not.toThrow();
  });

  test("a stopped computer holds nothing", () => {
    expect(countsAgainstBudget("running")).toBe(true);
    expect(countsAgainstBudget("restarting")).toBe(true);
    expect(countsAgainstBudget("exited")).toBe(false);
    expect(countsAgainstBudget("dead")).toBe(false);
  });
});

describe("capacity report", () => {
  test("reports used, available, and null for unlimited", () => {
    const report = capacity({ cpus: 4 }, [
      { cpus: 1, memoryBytes: 2 * GiB },
      { cpus: 1, memoryBytes: 2 * GiB },
    ]);
    expect(report.used).toEqual({ cpus: 2, memoryBytes: 4 * GiB });
    expect(report.available.cpus).toBe(2);
    expect(report.available.memoryBytes).toBeNull();
    expect(report.computers).toBe(2);
  });

  test("available never goes negative for pre-slice computers", () => {
    const report = capacity({ cpus: 1 }, [{ cpus: 4, memoryBytes: 0 }]);
    expect(report.available.cpus).toBe(0);
  });
});

describe("environment parsing", () => {
  test("absent budget is unlimited; malformed refuses to boot", () => {
    expect(budgetFromEnvironment({})).toEqual({});
    expect(budgetFromEnvironment({ SLICE_CPUS: "4" })).toEqual({ cpus: 4 });
    expect(() => budgetFromEnvironment({ SLICE_CPUS: "many" })).toThrow(
      /SLICE_CPUS/,
    );
    expect(() => budgetFromEnvironment({ SLICE_MEMORY_BYTES: "-1" })).toThrow(
      /SLICE_MEMORY_BYTES/,
    );
  });

  test("per-computer reservation defaults to the documented minimums", () => {
    expect(reservationFromEnvironment({})).toEqual({
      cpus: 1,
      memoryBytes: 2 * GiB,
    });
    expect(
      reservationFromEnvironment({
        COMPUTER_CPUS: "0.5",
        COMPUTER_MEMORY_BYTES: String(GiB),
      }),
    ).toEqual({ cpus: 0.5, memoryBytes: GiB });
  });
});
