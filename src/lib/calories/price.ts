import { canLogPieces, foodInState, hasRawState, type Food, type FoodPrice } from './model.ts';
import { DAILY_PROTEIN_GRAMS } from './nutrition.ts';

/** The protein amounts the cost ranking can be shown for: 100 g, or a full day's protein target. */
export const PROTEIN_BASES = [100, DAILY_PROTEIN_GRAMS] as const;

/** The state a price is for: the raw state of a cooked food, otherwise the food itself. */
export function pricedState(food: Food): Food { return hasRawState(food) ? foodInState(food, 'Raw') : food; }

/** How much of the food (in its own unit) the price buys, or null when the food has no usable price. */
export function priceQuantity(food: Pick<Food, 'unit' | 'pieceWeight' | 'price'>): number | null {
  const price = food.price;
  if (!price) return null;
  if (!price.pieces) return price.quantity;
  return canLogPieces(food) ? price.quantity * food.pieceWeight! : null;
}

/** Kronor for the amount of the food that holds the given grams of protein. Null without a price or without protein. */
export function proteinCost(cooked: Food, proteinGrams: number): number | null {
  const food = pricedState(cooked);
  const quantity = priceQuantity(food);
  if (quantity === null || !(food.protein > 0)) return null;
  const kronorPerUnit = food.price!.kronor / quantity;
  const unitsForProtein = proteinGrams * food.baseQuantity / food.protein;
  return kronorPerUnit * unitsForProtein;
}

export interface ProteinCostRanking { ranked: { food: Food; cost: number }[]; noPrice: Food[]; noProtein: Food[] }

/** Priced foods with protein, cheapest protein first. Foods without a price, or with a price but no protein, are listed apart. */
export function rankByProteinCost(foods: readonly Food[], proteinGrams = 100): ProteinCostRanking {
  const ranked: ProteinCostRanking['ranked'] = [], noPrice: Food[] = [], noProtein: Food[] = [];
  for (const food of foods) {
    if (priceQuantity(pricedState(food)) === null) { noPrice.push(food); continue; }
    const cost = proteinCost(food, proteinGrams);
    if (cost === null) noProtein.push(food); else ranked.push({ food, cost });
  }
  ranked.sort((a, b) => a.cost - b.cost || a.food.name.localeCompare(b.food.name) || a.food.id.localeCompare(b.food.id));
  return { ranked, noPrice, noProtein };
}

export type { FoodPrice };
