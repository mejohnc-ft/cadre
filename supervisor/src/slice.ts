/**
 * The slice: how much of this machine its owner has dedicated to agents.
 *
 * A budget of cores and memory, enforced at admission. Every computer carries a reservation —
 * what it may use, written onto the container as labels and as hard limits — and a new computer is
 * admitted only while the sum of running reservations stays inside the budget. When it does not,
 * the answer is a refusal with a Retry-After, never a quiet queue jump: the caller decides whether
 * to wait, and the machine's owner decides the budget.
 *
 * Pure functions over explicit inputs. The supervisor's HTTP layer supplies what is running; this
 * file never talks to Docker, which is what makes the arithmetic testable and the same for every
 * backend the contract grows.
 */

/** What the owner dedicated. A missing dimension is unlimited — a deployment choice, not a default. */
export type SliceBudget = {
  cpus?: number;
  memoryBytes?: number;
};

/** What one computer holds while it runs. */
export type Reservation = {
  cpus: number;
  memoryBytes: number;
};

export class SliceExhaustedError extends Error {
  readonly retryAfterSeconds: number;
  constructor(dimension: "cpus" | "memory", budget: string, wanted: string) {
    super(
      `The slice is full: admitting this computer needs ${wanted} ${dimension} and the slice holds ${budget}. Stop a computer or grow the slice.`,
    );
    this.name = "SliceExhaustedError";
    this.retryAfterSeconds = 30;
  }
}

/** Reservation states that count against the budget. A stopped computer holds nothing. */
const COUNTED_STATES = new Set(["running", "created", "restarting", "paused"]);

export function countsAgainstBudget(status: string): boolean {
  return COUNTED_STATES.has(status);
}

export function usedBy(reservations: readonly Reservation[]): Reservation {
  return reservations.reduce(
    (sum, reservation) => ({
      cpus: sum.cpus + reservation.cpus,
      memoryBytes: sum.memoryBytes + reservation.memoryBytes,
    }),
    { cpus: 0, memoryBytes: 0 },
  );
}

/**
 * May one more computer with this reservation start?
 *
 * Throws {@link SliceExhaustedError} naming the dimension that refused. Both dimensions are
 * checked so the error names the first that fails; an unlimited dimension never refuses.
 */
export function admit(
  budget: SliceBudget,
  running: readonly Reservation[],
  requested: Reservation,
): void {
  const used = usedBy(running);
  if (
    budget.cpus !== undefined &&
    used.cpus + requested.cpus > budget.cpus + EPSILON
  ) {
    throw new SliceExhaustedError(
      "cpus",
      `${budget.cpus - used.cpus} of ${budget.cpus} free`,
      String(requested.cpus),
    );
  }
  if (
    budget.memoryBytes !== undefined &&
    used.memoryBytes + requested.memoryBytes > budget.memoryBytes
  ) {
    throw new SliceExhaustedError(
      "memory",
      `${budget.memoryBytes - used.memoryBytes} of ${budget.memoryBytes} bytes free`,
      `${requested.memoryBytes} bytes`,
    );
  }
}

/** Floating-point cores: 0.1 + 0.2 must not refuse a 0.3 budget. */
const EPSILON = 1e-9;

export type Capacity = {
  budget: SliceBudget;
  used: Reservation;
  available: {
    cpus: number | null;
    memoryBytes: number | null;
  };
  computers: number;
};

export function capacity(
  budget: SliceBudget,
  running: readonly Reservation[],
): Capacity {
  const used = usedBy(running);
  return {
    budget,
    used,
    available: {
      cpus:
        budget.cpus === undefined ? null : Math.max(0, budget.cpus - used.cpus),
      memoryBytes:
        budget.memoryBytes === undefined
          ? null
          : Math.max(0, budget.memoryBytes - used.memoryBytes),
    },
    computers: running.length,
  };
}

/** Parse a dimension from the environment; absent or invalid is unlimited, loudly for invalid. */
export function budgetFromEnvironment(
  environment: Record<string, string | undefined>,
): SliceBudget {
  const parse = (name: string): number | undefined => {
    const raw = environment[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number, not "${raw}".`);
    }
    return value;
  };
  return {
    ...(parse("SLICE_CPUS") !== undefined ? { cpus: parse("SLICE_CPUS") } : {}),
    ...(parse("SLICE_MEMORY_BYTES") !== undefined
      ? { memoryBytes: parse("SLICE_MEMORY_BYTES") }
      : {}),
  };
}

/**
 * What one computer reserves, from the environment. Defaults are the deployment doc's minimums:
 * one core and 2 GiB — the floor at which a computer's browser does not meet the OOM killer.
 */
export function reservationFromEnvironment(
  environment: Record<string, string | undefined>,
): Reservation {
  const cpus = Number(environment.COMPUTER_CPUS?.trim() || "1");
  const memoryBytes = Number(
    environment.COMPUTER_MEMORY_BYTES?.trim() || String(2 * 1024 ** 3),
  );
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error(`COMPUTER_CPUS must be a positive number.`);
  }
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) {
    throw new Error(
      `COMPUTER_MEMORY_BYTES must be a positive number of bytes.`,
    );
  }
  return { cpus, memoryBytes };
}
