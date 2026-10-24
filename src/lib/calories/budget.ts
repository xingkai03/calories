import { addDays, todayISO, type TrackerData } from './model.ts';
import { effectiveBurned, latestCompletedGarminDay, type GarminDay } from './garmin.ts';

function finite(value: number, label: string, nonNegative = false): number {
  if (!Number.isFinite(value) || (nonNegative && value < 0)) throw new Error(`Invalid ${label}.`);
  return value;
}

/** Most a deficit target may plan per day (used by the Trends planner). */
export const MAX_DAILY_DEFICIT = 1000;
/** Each logged day's difference from its budget is paid back in this many equal parts. */
export const CARRY_SPREAD_DAYS = 7;

/** A day's food budget: base budget plus the carry spread in from earlier days, never below 0. */
export function adjustedBudget(burned: number, deficit: number, carryIn = 0) {
  finite(burned, 'calories burned', true);
  finite(deficit, 'deficit target', true);
  finite(carryIn, 'carried calorie balance');
  const baseBudget = Math.max(0, burned - deficit);
  const rawBudget = finite(baseBudget + carryIn, 'adjusted calorie budget');
  const budget = Math.max(0, rawBudget);
  const deferredDebt = finite(budget - rawBudget, 'deferred calorie debt');
  return { baseBudget, carryIn, rawBudget, budget, deferredDebt };
}

export interface BalanceDay extends ReturnType<typeof adjustedBudget> {
  date: string;
  eaten: number;
  /** rawBudget − eaten: what this day adds to the next 7 days (+ under budget, − over). */
  difference: number;
  /** Carry still to be applied to later days after this day. */
  balance: number;
  available: boolean;
  settled: boolean;
}
export interface CalorieLedger { days: Record<string, BalanceDay>; completed: BalanceDay[]; provisional?: BalanceDay }

/** Each day's difference is spread evenly over the next 7 days.
 * Unlogged days and planned future meals add nothing; today's difference only previews later days.
 * Derive everything from recorded intake, each day's targets and the latest burned readings,
 * so edits and Garmin corrections propagate without storing or counting carry twice. */
export function calorieLedger(data: TrackerData, garminDays: readonly GarminDay[], currentDay = todayISO()): CalorieLedger {
  const eaten = new Map<string, number>();
  for (const entry of data.entries) eaten.set(entry.date, finite((eaten.get(entry.date) ?? 0) + finite(entry.calories, 'logged calories', true), 'daily logged calories'));
  const imported = new Map(garminDays.map(day => [day.date, day]));
  const latestResting = latestCompletedGarminDay(garminDays, currentDay);
  const days: Record<string, BalanceDay> = {};
  const completed: BalanceDay[] = [];
  let provisional: BalanceDay | undefined;
  const ledger: CalorieLedger = { days, completed };
  for (const date of [...eaten.keys()].sort()) {
    const settings = data.days[date] ?? data.defaults;
    const readings = [imported.get(date), imported.get(addDays(date, -1)), latestResting].filter((day): day is GarminDay => day !== undefined);
    const reading = effectiveBurned(date, settings, readings, currentDay);
    const amounts = adjustedBudget(reading.burned, settings.deficit, carryBefore(date, ledger));
    // Measure against the unclamped allowance, so a zero-floored budget never forgives debt.
    const difference = finite(amounts.rawBudget - eaten.get(date)!, 'daily calorie difference');
    const available = !reading.unavailable;
    const row: BalanceDay = { date, ...amounts, eaten: eaten.get(date)!, difference, balance: finite(outstandingAfter(date, ledger, difference), 'running calorie balance'), available, settled: date < currentDay && available };
    days[date] = row;
    if (row.settled) completed.push(row);
    else if (date === currentDay && available) { provisional = row; ledger.provisional = row; }
  }
  return { days, completed, ...(provisional ? { provisional } : {}) };
}

/** Completed logged days, and today once its burn is known, spread into later days. */
function contributing(date: string, ledger: CalorieLedger): BalanceDay | undefined {
  const row = ledger.days[date];
  return row && (row.settled || row === ledger.provisional) ? row : undefined;
}

/** The carry a day receives: one seventh of each of the previous 7 days' differences. */
export function carryBefore(date: string, ledger: CalorieLedger): number {
  let total = 0;
  for (let k = 1; k <= CARRY_SPREAD_DAYS; k++) total += contributing(addDays(date, -k), ledger)?.difference ?? 0;
  return total / CARRY_SPREAD_DAYS;
}

/** Carry still owed to (or by) days after `date`, counting `ownDifference` for the day itself. */
export function outstandingAfter(date: string, ledger: CalorieLedger, ownDifference = 0): number {
  let total = ownDifference;
  for (let k = 1; k < CARRY_SPREAD_DAYS; k++) total += (contributing(addDays(date, -k), ledger)?.difference ?? 0) * (CARRY_SPREAD_DAYS - k) / CARRY_SPREAD_DAYS;
  return total;
}
