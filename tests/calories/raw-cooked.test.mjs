import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, foodInState, hasRawState, macrosForFood, normalizeData } from '../../src/lib/calories/model.ts';
import { prepareFoodBankPortions } from '../../src/lib/calories/food-bank.ts';
import { proteinCost, rankByProteinCost } from '../../src/lib/calories/price.ts';
import { mergeJournals } from '../../src/lib/calories/offline.ts';

// Cooked chicken: 30 g protein per 100 g; 100 g raw cooks to 75 g.
const chicken = { id: 'chicken', name: 'Chicken', baseQuantity: 100, unit: 'g', state: 'Cooked', cookedRatio: 0.75, pieceWeight: 150, protein: 30, carbs: 0, fat: 4, fiber: 0, calories: 156 };
const journal = foods => ({ ...emptyData(), foods });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test('a cooked food saved before raw states existed gets a raw state at ratio 1, and only cooked foods have one', () => {
  const { cookedRatio: _ratio, ...legacy } = chicken;
  const loaded = normalizeData(journal([legacy, { ...legacy, id: 'apple', state: 'Raw' }]));
  assert.equal(loaded.foods[0].cookedRatio, 1);
  assert.equal('cookedRatio' in loaded.foods[1], false);
  assert.deepEqual(normalizeData(loaded), loaded, 'the migration is stable');
  assert.equal(normalizeData(journal([chicken])).foods[0].cookedRatio, 0.75);
  assert.throws(() => normalizeData(journal([{ ...chicken, state: 'Raw' }])), /only a cooked food/);
  assert.throws(() => normalizeData(journal([{ ...chicken, cookedRatio: 0 }])), /cooked\/raw weight ratio/);
  assert.equal(hasRawState(chicken), true);
  assert.equal(hasRawState({ state: 'As served' }), false);
});

test('the raw state holds the nutrition of the raw weight that cooks into the cooked amount', () => {
  const raw = foodInState(chicken, 'Raw');
  assert.equal(raw.state, 'Raw');
  assert.equal(raw.id, chicken.id, 'both states are one food');
  assert.equal('cookedRatio' in raw, false);
  close(raw.protein, 22.5);
  close(raw.calories, 117);
  assert.equal(raw.pieceWeight, 200, 'a 150 g cooked piece weighed 200 g raw');
  // 200 g raw and 150 g cooked are the same portion.
  close(macrosForFood(raw, 200).protein, macrosForFood(chicken, 150).protein);
  assert.equal(foodInState(chicken, 'Cooked'), chicken);
  assert.throws(() => foodInState({ ...chicken, state: 'As served' }, 'Raw'), /no raw state/);
});

test('the price of a cooked food is for its raw state', () => {
  // 90 kr per 1000 g raw, 22.5 g protein per 100 g raw → 100 g protein = 444.4 g raw = 40 kr.
  const priced = { ...chicken, price: { kronor: 90, quantity: 1000 } };
  close(proteinCost(priced, 100), 40);
  // At ratio 1 the raw state matches the cooked one, as before raw states existed.
  close(proteinCost({ ...priced, cookedRatio: 1 }, 100), 30);
  // Priced per piece: 4 pieces = 800 g raw for 90 kr.
  close(proteinCost({ ...priced, price: { kronor: 90, quantity: 4, pieces: true } }, 100), 50);
  const quark = { id: 'quark', name: 'Quark', baseQuantity: 100, unit: 'g', state: 'As served', protein: 10, carbs: 0, fat: 0, fiber: 0, calories: 40, price: { kronor: 35, quantity: 1000 } };
  assert.deepEqual(rankByProteinCost([priced, quark]).ranked.map(row => [row.food.id, Math.round(row.cost)]), [['quark', 35], ['chicken', 40]]);
});

test('a food bank ingredient can go in by its raw weight', () => {
  let id = 0;
  const [portion] = prepareFoodBankPortions([chicken], [{ foodId: 'chicken', quantity: 200, state: 'Raw' }], 1, 'Chicken', () => `id-${++id}`);
  const item = portion.items[0];
  assert.equal(item.state, 'Raw');
  assert.equal(item.foodId, 'chicken');
  assert.equal(item.quantity, 200);
  close(item.protein, 45);
  const [byPiece] = prepareFoodBankPortions([chicken], [{ foodId: 'chicken', pieces: 1, state: 'Raw' }], 1, 'Chicken', () => `id-${++id}`);
  assert.equal(byPiece.items[0].quantity, 200);
  const [cooked] = prepareFoodBankPortions([chicken], [{ foodId: 'chicken', quantity: 150 }], 1, 'Chicken', () => `id-${++id}`);
  assert.equal(cooked.items[0].state, 'Cooked');
  close(cooked.items[0].protein, 45);
  assert.throws(() => prepareFoodBankPortions([{ ...chicken, state: 'As served', cookedRatio: undefined }], [{ foodId: 'chicken', quantity: 1, state: 'Raw' }], 1, 'x', () => `id-${++id}`), /no raw state/);
});

test('a ratio edited on one device merges with an edit to the same journal elsewhere', () => {
  const { cookedRatio: _ratio, ...legacy } = chicken;
  const base = journal([legacy]);
  const local = journal([{ ...chicken, cookedRatio: 0.7 }]);
  const remote = { ...journal([legacy]), entries: [{ id: 'e1', date: '2026-11-04', meal: 'Lunch', foodId: 'chicken', foodName: 'Chicken', quantity: 200, unit: 'g', state: 'Raw', protein: 45, carbs: 0, fat: 6, fiber: 0, calories: 234 }] };
  const merged = mergeJournals(base, local, remote);
  assert.equal(merged.foods[0].cookedRatio, 0.7);
  assert.equal(merged.entries[0].state, 'Raw');
});
