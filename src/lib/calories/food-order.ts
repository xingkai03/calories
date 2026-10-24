import { addDays, type Entry, type Food } from './model.ts';

/** Each library log counts once, across today and the previous 13 calendar days. */
export function sortFoodsByRecentUse(foods: readonly Food[], entries: readonly Entry[], currentDay: string): Food[] {
  const firstDay = addDays(currentDay, -13);
  const counts = new Map(foods.map(food => [food.id, 0]));
  for (const entry of entries) {
    if (entry.date < firstDay || entry.date > currentDay || entry.source === 'manual' || entry.foodId === `manual:${entry.id}`) continue;
    const count = counts.get(entry.foodId);
    if (count !== undefined) counts.set(entry.foodId, count + 1);
  }
  return [...foods].sort((a, b) =>
    counts.get(b.id)! - counts.get(a.id)! || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export const RECENT_FOOD_DAYS = 7;

/** Library foods logged across today and the previous six calendar days. */
export function recentFoodIds(entries: readonly Entry[], currentDay: string, days = RECENT_FOOD_DAYS): Set<string> {
  const firstDay = addDays(currentDay, 1 - days);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.date < firstDay || entry.date > currentDay || entry.source === 'manual' || entry.foodId === `manual:${entry.id}`) continue;
    ids.add(entry.foodId);
  }
  return ids;
}

/** New entries start on the meal that fits the time of day: breakfast from 04:00, lunch from 11:00, dinner from 16:00. */
export function mealForTime(now = new Date()): 'Breakfast' | 'Lunch' | 'Dinner' {
  const hour = now.getHours();
  return hour >= 4 && hour < 11 ? 'Breakfast' : hour >= 11 && hour < 16 ? 'Lunch' : 'Dinner';
}
