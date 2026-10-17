import { addDays, dayTotals, settingsForDay, todayISO, type Entry, type TrackerData } from './model.ts';
import { effectiveBurned, type GarminDay } from './garmin.ts';
import { MAX_DAILY_DEFICIT } from './budget.ts';
import { macroTargets } from './nutrition.ts';

/** Common rule of thumb for body-fat energy; an estimate, not a measurement. */
export const KCAL_PER_KG = 7700;

export interface TrendDay {
  date: string;
  /** True when at least one entry exists. Unlogged days never count as 0 kcal eaten. */
  logged: boolean;
  eaten: number;
  protein: number;
  /** Null while no burned reading exists (Garmin hasn't reported). */
  burned: number | null;
  /** burned − eaten; positive is a deficit. Null unless logged and burned are known. */
  deficit: number | null;
}

export interface TrendSummary {
  loggedDays: number;
  measuredDays: number;
  avgEaten: number | null;
  avgProtein: number | null;
  avgBurned: number | null;
  avgDeficit: number | null;
  totalDeficit: number;
  /** Positive = estimated loss. Based only on days with both intake and burn known. */
  estimatedKg: number | null;
  kgPerWeek: number | null;
}

/** The last `span` days ending at `currentDay`, oldest first. Today is excluded until it ends. */
export function trendDays(data: TrackerData, garminDays: readonly GarminDay[], span: number, currentDay = todayISO()): TrendDay[] {
  const byDate = new Map<string, Entry[]>();
  for (const entry of data.entries) { const list = byDate.get(entry.date); if (list) list.push(entry); else byDate.set(entry.date, [entry]); }
  const days: TrendDay[] = [];
  for (let offset = span; offset >= 1; offset--) {
    const date = addDays(currentDay, -offset);
    const entries = byDate.get(date) ?? [];
    const logged = entries.length > 0;
    const totals = dayTotals(entries);
    const reading = effectiveBurned(date, settingsForDay(data, date, logged), garminDays, currentDay);
    const burned = reading.unavailable ? null : reading.burned;
    days.push({ date, logged, eaten: totals.calories, protein: totals.protein, burned, deficit: logged && burned !== null ? burned - totals.calories : null });
  }
  return days;
}

export function summarizeTrend(days: readonly TrendDay[]): TrendSummary {
  const logged = days.filter(day => day.logged);
  const measured = days.filter(day => day.deficit !== null);
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const totalDeficit = measured.reduce((sum, day) => sum + (day.deficit ?? 0), 0);
  const avgDeficit = mean(measured.map(day => day.deficit ?? 0));
  return {
    loggedDays: logged.length,
    measuredDays: measured.length,
    avgEaten: mean(logged.map(day => day.eaten)),
    avgProtein: mean(logged.map(day => day.protein)),
    avgBurned: mean(measured.map(day => day.burned ?? 0)),
    avgDeficit,
    totalDeficit,
    estimatedKg: measured.length ? totalDeficit / KCAL_PER_KG : null,
    kgPerWeek: avgDeficit === null ? null : avgDeficit * 7 / KCAL_PER_KG,
  };
}

export interface DietPlan {
  /** Deficit actually planned after the daily safety cap. */
  deficit: number;
  capped: boolean;
  budget: number;
  kgPerWeek: number;
  macros: ReturnType<typeof macroTargets>;
}

/** A plan for losing `kgPerWeek` from a typical daily burn, honouring the app's deficit cap. */
export function planForRate(avgBurned: number, kgPerWeek: number): DietPlan {
  if (!Number.isFinite(avgBurned) || avgBurned < 0) throw new Error('Invalid calories burned.');
  if (!Number.isFinite(kgPerWeek) || kgPerWeek < 0) throw new Error('Invalid weekly rate.');
  const wanted = kgPerWeek * KCAL_PER_KG / 7;
  const deficit = Math.min(wanted, MAX_DAILY_DEFICIT, avgBurned);
  const budget = Math.max(0, avgBurned - deficit);
  return { deficit, capped: wanted > deficit, budget, kgPerWeek: deficit * 7 / KCAL_PER_KG, macros: macroTargets(budget) };
}
