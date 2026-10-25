import { addDays, type Entry, type Food, type FoodListPreferences, type Unit } from './model.ts';

const isLibraryLog = (entry: Entry) => entry.source !== 'manual' && entry.foodId !== `manual:${entry.id}`;

/** Orders the library by the chosen rule. `usedIds` holds the foods logged inside the window
 * (today and the days before it); it is null for all time, when nothing is hidden. */
export function rankFoods(foods: readonly Food[], entries: readonly Entry[], currentDay: string, { window, sort }: FoodListPreferences): { foods: Food[]; usedIds: Set<string> | null } {
  const firstDay = window ? addDays(currentDay, 1 - window) : '';
  const counts = new Map(foods.map(food => [food.id, 0]));
  const lastUsed = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const entry of entries) {
    if (entry.date > currentDay || !isLibraryLog(entry) || !counts.has(entry.foodId)) continue;
    if ((lastUsed.get(entry.foodId) ?? '') < entry.date) lastUsed.set(entry.foodId, entry.date);
    if (entry.date < firstDay) continue;
    usedIds.add(entry.foodId);
    counts.set(entry.foodId, counts.get(entry.foodId)! + 1);
  }
  const byName = (a: Food, b: Food) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const byRecent = (a: Food, b: Food) => (lastUsed.get(b.id) ?? '').localeCompare(lastUsed.get(a.id) ?? '');
  const compare = sort === 'name' ? byName
    : sort === 'recent' ? (a: Food, b: Food) => byRecent(a, b) || byName(a, b)
    : (a: Food, b: Food) => counts.get(b.id)! - counts.get(a.id)! || byRecent(a, b) || byName(a, b);
  return { foods: [...foods].sort(compare), usedIds: window ? usedIds : null };
}

export interface FoodUsage { entries: Entry[]; count: number; days: number; firstDate: string | null; lastDate: string | null; amounts: { unit: Unit; quantity: number; count: number }[]; calories: number; last7: number; last30: number }

/** Every library log of one food, newest first. Planned future meals are listed but not counted as eaten. */
export function foodUsage(entries: readonly Entry[], foodId: string, currentDay: string): FoodUsage {
  const logs = entries.filter(entry => entry.foodId === foodId && isLibraryLog(entry)).sort((a, b) => b.date.localeCompare(a.date) || a.meal.localeCompare(b.meal));
  const eaten = logs.filter(entry => entry.date <= currentDay);
  const amounts = new Map<Unit, { unit: Unit; quantity: number; count: number }>();
  for (const entry of eaten) { const total = amounts.get(entry.unit) ?? { unit: entry.unit, quantity: 0, count: 0 }; total.quantity += entry.quantity; total.count++; amounts.set(entry.unit, total); }
  const since = (days: number) => { const first = addDays(currentDay, 1 - days); return eaten.filter(entry => entry.date >= first).length; };
  return {
    entries: logs, count: eaten.length, days: new Set(eaten.map(entry => entry.date)).size,
    firstDate: eaten.at(-1)?.date ?? null, lastDate: eaten[0]?.date ?? null,
    amounts: [...amounts.values()],
    calories: eaten.reduce((sum, entry) => sum + entry.calories, 0),
    last7: since(7), last30: since(30),
  };
}

/** New entries start on the meal that fits the time of day: breakfast from 04:00, lunch from 11:00, dinner from 16:00. */
export function mealForTime(now = new Date()): 'Breakfast' | 'Lunch' | 'Dinner' {
  const hour = now.getHours();
  return hour >= 4 && hour < 11 ? 'Breakfast' : hour >= 11 && hour < 16 ? 'Lunch' : 'Dinner';
}
