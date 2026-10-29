import { canLogPieces, emptyData, energyFromMacros, macrosForFood, normalizeData, quantityFromPieces, settingsForDay, type BankPortion, type Food, type TrackerData } from './model.ts';

function positiveQuantity(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e8) throw new Error('Enter a finite positive ingredient quantity.');
  return value;
}

function nonNegative(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e8) throw new Error(`Enter a finite, non-negative ${label} estimate.`);
  return value;
}

/** A manual estimate gives one portion's nutrient totals directly, like a manual journal entry. */
export interface ManualIngredient { manual: { name: string; protein: number; carbs: number; fat: number; fiber: number } }
export type BankIngredientInput = { foodId: string; quantity?: number; pieces?: number } | ManualIngredient;

/** Ingredient quantities describe one portion; batching makes independent snapshots.
 * An ingredient given in `pieces` uses its food's piece weight, like a journal entry logged by the piece.
 * A manual ingredient is stored as 1 'As served' piece with foodId `manual:<item id>`, so eating it logs a manual estimate. */
export function prepareFoodBankPortions(
  foods: readonly Food[],
  ingredients: readonly BankIngredientInput[],
  count: number,
  name: string,
  makeId: () => string,
): BankPortion[] {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Prepare between 1 and 100 portions.');
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Enter a food-bank portion name.');
  if (!Array.isArray(foods) || !Array.isArray(ingredients) || ingredients.length < 1 || ingredients.length > 50) throw new Error('A food-bank portion must contain 1 to 50 ingredients.');
  if (typeof makeId !== 'function') throw new Error('A food-bank ID generator is required.');
  const library = new Map(normalizeData({ ...emptyData(), foods }).foods.map(food => [food.id, food]));
  const snapshots = ingredients.map(ingredient => {
    if (!ingredient || typeof ingredient !== 'object' || Array.isArray(ingredient)) throw new Error('Invalid food-bank ingredient.');
    if ('manual' in ingredient) {
      if (!ingredient.manual || typeof ingredient.manual !== 'object') throw new Error('Invalid food-bank ingredient.');
      const { name: estimateName, ...values } = ingredient.manual;
      if (typeof estimateName !== 'string' || !estimateName.trim() || estimateName.length > 160) throw new Error('Give each estimated ingredient a name.');
      const nutrients = { protein: nonNegative(values.protein, 'protein'), carbs: nonNegative(values.carbs, 'carbohydrate'), fat: nonNegative(values.fat, 'fat'), fiber: nonNegative(values.fiber, 'fibre') };
      return { foodId: null, foodName: estimateName.trim(), quantity: 1, unit: 'piece' as const, state: 'As served' as const, ...nutrients, calories: energyFromMacros(nutrients) };
    }
    const food = library.get(ingredient.foodId);
    if (!food) throw new Error('Choose an existing food for each ingredient.');
    if (ingredient.pieces !== undefined && !canLogPieces(food)) throw new Error(`${food.name} has no piece weight. Enter its amount in ${food.unit}.`);
    const pieces = ingredient.pieces === undefined ? undefined : positiveQuantity(ingredient.pieces);
    const quantity = positiveQuantity(pieces === undefined ? ingredient.quantity as number : quantityFromPieces(food, pieces));
    const nutrients = macrosForFood(food, quantity);
    return { foodId: food.id, foodName: food.name, quantity, unit: food.unit, state: food.state, ...(pieces !== undefined ? { pieces } : {}), ...nutrients, calories: energyFromMacros(nutrients) };
  });
  const generatedIds = new Set<string>();
  const nextId = () => {
    const id = makeId();
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || generatedIds.has(id)) throw new Error('Food-bank IDs must be valid and unique.');
    generatedIds.add(id);
    return id;
  };
  const portions = Array.from({ length: count }, () => ({
    id: nextId(), name: name.trim(), items: snapshots.map(({ foodId, ...snapshot }) => {
      const id = nextId();
      return { id, foodId: foodId ?? `manual:${id}`, ...snapshot };
    }),
  }));
  // Apply the same numerical bounds and collision checks used for backups.
  return normalizeData({ ...emptyData(), foodBank: portions }).foodBank;
}

/** Retrying a recovered preparation accepts its identical saved IDs once. */
export function addPreparedPortions(data: TrackerData, portions: readonly BankPortion[]): TrackerData {
  const current = normalizeData(data);
  const incoming = normalizeData({ ...emptyData(), foodBank: portions }).foodBank;
  const existing = new Map(current.foodBank.map(portion => [portion.id, portion]));
  const logged = new Set(current.entries.map(entry => entry.id));
  const added: BankPortion[] = [];
  for (const portion of incoming) {
    const previous = existing.get(portion.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(portion)) throw new Error('This preparation has already been saved with different amounts. Discard its recovered draft before preparing a new batch.');
    } else {
      if (portion.items.some(item => logged.has(item.id))) throw new Error('This preparation has already been logged. Discard its recovered draft to prepare a new batch.');
      added.push(portion);
    }
  }
  return normalizeData({ ...current, foodBank: [...current.foodBank, ...added] });
}

/** Move one stored snapshot into the journal; its item IDs prevent duplicate logging. */
export function consumeFoodBankPortion(data: TrackerData, portionId: string, date: string, meal: string): TrackerData {
  const current = normalizeData(data);
  const portion = current.foodBank.find(item => item.id === portionId);
  if (!portion) throw new Error('This food-bank portion is no longer available.');
  if (typeof meal !== 'string' || !meal.trim() || meal.length > 200) throw new Error('Enter a meal name.');
  // Resolve before appending: a previously untouched date starts with Garmin settings.
  const daySettings = { ...settingsForDay(current, date) };
  return normalizeData({
    ...current,
    foodBank: current.foodBank.filter(item => item.id !== portionId),
    entries: [...current.entries, ...portion.items.map(item => ({ ...item, date, meal: meal.trim() }))],
    days: { ...current.days, [date]: daySettings },
  });
}

export interface BankGroup { name: string; portions: BankPortion[] }

/** Portions with the same name and the same ingredients and amounts, ignoring IDs. A manual estimate's foodId embeds its own item ID, so it compares as 'manual'. */
function portionKey(portion: BankPortion): string {
  return JSON.stringify([portion.name, portion.items.map(({ id, foodId, foodName, quantity, unit, state, pieces, calories, protein, carbs, fat, fiber }) =>
    [foodId === `manual:${id}` ? 'manual' : foodId, foodName, quantity, unit, state, pieces ?? null, calories, protein, carbs, fat, fiber])]);
}

/** Groups identical portions in first-prepared order; each group lists its oldest portion first, which is the one eaten or removed next. */
export function groupFoodBankPortions(portions: readonly BankPortion[]): BankGroup[] {
  const groups = new Map<string, BankGroup>();
  for (const portion of portions) {
    const key = portionKey(portion);
    const group = groups.get(key);
    if (group) group.portions.push(portion);
    else groups.set(key, { name: portion.name, portions: [portion] });
  }
  return [...groups.values()];
}
