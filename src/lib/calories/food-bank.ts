import { canLogPieces, emptyData, energyFromMacros, macrosForFood, normalizeData, quantityFromPieces, settingsForDay, type BankItem, type BankPortion, type Entry, type Food, type Macros, type TrackerData } from './model.ts';

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

type Snapshot = Omit<BankItem, 'id' | 'foodId'> & { foodId: string | null };
function ingredientSnapshots(foods: readonly Food[], ingredients: readonly BankIngredientInput[]): Snapshot[] {
  if (!Array.isArray(foods) || !Array.isArray(ingredients) || ingredients.length < 1 || ingredients.length > 50) throw new Error('A food-bank portion must contain 1 to 50 ingredients.');
  const library = new Map(normalizeData({ ...emptyData(), foods }).foods.map(food => [food.id, food]));
  return ingredients.map(ingredient => {
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
}

function checkedIds(makeId: () => string): () => string {
  if (typeof makeId !== 'function') throw new Error('A food-bank ID generator is required.');
  const generatedIds = new Set<string>();
  return () => {
    const id = makeId();
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || generatedIds.has(id)) throw new Error('Food-bank IDs must be valid and unique.');
    generatedIds.add(id);
    return id;
  };
}

function checkedName(name: string): string {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Enter a food-bank portion name.');
  return name.trim();
}

function withIds(snapshots: readonly Snapshot[], nextId: () => string): BankItem[] {
  return snapshots.map(({ foodId, ...snapshot }) => {
    const id = nextId();
    return { id, foodId: foodId ?? `manual:${id}`, ...snapshot };
  });
}

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
  const portionName = checkedName(name);
  const snapshots = ingredientSnapshots(foods, ingredients);
  const nextId = checkedIds(makeId);
  const portions = Array.from({ length: count }, () => ({ id: nextId(), name: portionName, items: withIds(snapshots, nextId) }));
  // Apply the same numerical bounds and collision checks used for backups.
  return normalizeData({ ...emptyData(), foodBank: portions }).foodBank;
}

/** A batch kept by weight: the ingredient amounts are everything in the batch, and totalWeight is
 * what the finished food weighs in grams. Eating takes grams from it until none are left. */
export function prepareFoodBankBatch(
  foods: readonly Food[],
  ingredients: readonly BankIngredientInput[],
  totalWeight: number,
  name: string,
  makeId: () => string,
): BankPortion[] {
  if (typeof totalWeight !== 'number' || !Number.isFinite(totalWeight) || totalWeight <= 0 || totalWeight > 1e8) throw new Error('Enter the total weight of the food in grams.');
  const portionName = checkedName(name);
  const snapshots = ingredientSnapshots(foods, ingredients);
  const nextId = checkedIds(makeId);
  const batch = { id: nextId(), name: portionName, items: withIds(snapshots, nextId), weight: { total: totalWeight, left: totalWeight } };
  return normalizeData({ ...emptyData(), foodBank: [batch] }).foodBank;
}

/** The nutrition of everything a food-bank item holds: one portion, or a whole batch kept by weight. */
export function bankNutrition(items: readonly Macros[]): Macros {
  return items.reduce((total, item) => ({ calories: total.calories + item.calories, protein: total.protein + item.protein, carbs: total.carbs + item.carbs, fat: total.fat + item.fat, fiber: total.fiber + item.fiber }), { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
}

/** The nutrition in some grams of a batch kept by weight. */
export function nutritionForGrams(portion: BankPortion, grams: number): Macros {
  const total = bankNutrition(portion.items), ratio = portion.weight ? grams / portion.weight.total : 0;
  return { calories: total.calories * ratio, protein: total.protein * ratio, carbs: total.carbs * ratio, fat: total.fat * ratio, fiber: total.fiber * ratio };
}

/** Grams of a batch too few to count (1 mg): eating may round up by this much, and a batch with no more left is used up and leaves the bank. */
const USED_UP = 0.001;

/** An entry eaten by weight from a food-bank batch: one entry for the dish, in grams. */
export function isBankWeightEntry(entry: Pick<Entry, 'foodId' | 'bankPortion'>): boolean {
  return entry.bankPortion !== undefined && entry.foodId === `bank:${entry.bankPortion.id}`;
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

export interface BankAmount { grams: number; entryId: string }

/** Move one stored snapshot into the journal; its item IDs prevent duplicate logging.
 * A batch kept by weight needs an amount instead: those grams are logged as one entry with a new ID,
 * and the batch keeps what is left (it leaves the bank once nothing is). */
export function consumeFoodBankPortion(data: TrackerData, portionId: string, date: string, meal: string, amount?: BankAmount): TrackerData {
  const current = normalizeData(data);
  const portion = current.foodBank.find(item => item.id === portionId);
  if (!portion) throw new Error('This food-bank portion is no longer available.');
  if (typeof meal !== 'string' || !meal.trim() || meal.length > 200) throw new Error('Enter a meal name.');
  // Resolve before appending: a previously untouched date starts with Garmin settings.
  const daySettings = { ...settingsForDay(current, date) };
  if (portion.weight) {
    const grams = amount?.grams;
    if (typeof grams !== 'number' || !Number.isFinite(grams) || grams <= 0) throw new Error('Enter how many grams you ate.');
    if (grams > portion.weight.left + USED_UP) throw new Error('That is more than is left in the food bank.');
    const eaten = Math.min(grams, portion.weight.left), left = portion.weight.left - eaten;
    const entry: Entry = { id: amount!.entryId, date, meal: meal.trim(), foodId: `bank:${portion.id}`, foodName: portion.name, quantity: eaten, unit: 'g', state: 'As served', ...nutritionForGrams(portion, eaten), bankPortion: { id: portion.id, name: portion.name } };
    return normalizeData({
      ...current,
      foodBank: left <= USED_UP ? current.foodBank.filter(item => item.id !== portionId) : current.foodBank.map(item => item.id === portionId ? { ...item, weight: { total: portion.weight!.total, left } } : item),
      entries: [...current.entries, entry],
      days: { ...current.days, [date]: daySettings },
    });
  }
  if (amount !== undefined) throw new Error('A prepared portion is eaten whole.');
  return normalizeData({
    ...current,
    foodBank: current.foodBank.filter(item => item.id !== portionId),
    entries: [...current.entries, ...portion.items.map(item => ({ ...item, date, meal: meal.trim(), bankPortion: { id: portion.id, name: portion.name } }))],
    days: { ...current.days, [date]: daySettings },
  });
}

/** The food-bank ingredient an entry eaten from the bank goes back as, with the same ID. */
export function bankItemFromEntry({ date: _date, meal: _meal, source: _source, bankPortion: _origin, ...item }: Entry): BankItem {
  return item;
}

/** Removes a journal entry. One eaten from the food bank goes back into its portion, so a portion
 * whose every ingredient is removed is whole again and rejoins its group of identical portions. */
export function removeJournalEntry(data: TrackerData, entryId: string): TrackerData {
  const current = normalizeData(data);
  const entry = current.entries.find(item => item.id === entryId);
  if (!entry) throw new Error('This journal entry is no longer available.');
  const entries = current.entries.filter(item => item.id !== entryId);
  const origin = entry.bankPortion;
  if (!origin) return { ...current, entries };
  if (isBankWeightEntry(entry)) {
    // Grams eaten from a batch go back into it, up to what it first held. A batch that was used up
    // comes back holding just those grams, with the nutrition they were logged with.
    const batch = current.foodBank.find(portion => portion.id === origin.id);
    const foodBank = batch?.weight
      ? current.foodBank.map(portion => portion === batch ? { ...portion, weight: { total: batch.weight!.total, left: Math.min(batch.weight!.total, batch.weight!.left + entry.quantity) } } : portion)
      : [...current.foodBank, { id: origin.id, name: origin.name, items: [bankItemFromEntry(entry)], weight: { total: entry.quantity, left: entry.quantity } }];
    return normalizeData({ ...current, entries, foodBank });
  }
  const item = bankItemFromEntry(entry);
  const foodBank = current.foodBank.some(portion => portion.id === origin.id)
    ? current.foodBank.map(portion => portion.id === origin.id ? { ...portion, items: [...portion.items, item] } : portion)
    : [...current.foodBank, { id: origin.id, name: origin.name, items: [item] }];
  return normalizeData({ ...current, entries, foodBank });
}

export interface BankGroup { name: string; portions: BankPortion[] }

/** Portions with the same name and the same ingredients and amounts, ignoring IDs and ingredient order
 * (a portion returned from the journal gets its ingredients back in the order they were removed).
 * A manual estimate's foodId embeds its own item ID, so it compares as 'manual'. */
function portionKey(portion: BankPortion): string {
  return JSON.stringify([portion.name, portion.items.map(({ id, foodId, foodName, quantity, unit, state, pieces, calories, protein, carbs, fat, fiber }) =>
    JSON.stringify([foodId === `manual:${id}` ? 'manual' : foodId, foodName, quantity, unit, state, pieces ?? null, calories, protein, carbs, fat, fiber])).sort()]);
}

/** Groups identical portions in first-prepared order (a batch kept by weight stays on its own); each group lists its oldest portion first, which is the one eaten or removed next. */
export function groupFoodBankPortions(portions: readonly BankPortion[]): BankGroup[] {
  const groups = new Map<string, BankGroup>();
  for (const portion of portions) {
    // A batch kept by weight is its own card.
    const key = portion.weight ? `weight:${portion.id}` : portionKey(portion);
    const group = groups.get(key);
    if (group) group.portions.push(portion);
    else groups.set(key, { name: portion.name, portions: [portion] });
  }
  return [...groups.values()];
}
