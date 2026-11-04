import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, normalizeData } from '../../src/lib/calories/model.ts';
import { priceQuantity, proteinCost, rankByProteinCost } from '../../src/lib/calories/price.ts';
import { mergeJournals } from '../../src/lib/calories/offline.ts';

const food = (id, extra) => ({ id, name: id, baseQuantity: 100, unit: 'g', state: 'As served', carbs: 0, protein: 20, fat: 0, fiber: 0, calories: 80, ...extra });
// 32 kr for 500 g, 20 g protein per 100 g → 100 g protein is 500 g of food → 32 kr.
const quark = food('Quark', { price: { kronor: 32, quantity: 500 } });
// 6 eggs for 30 kr, 60 g each, 12.5 g protein per 100 g → 100 g protein = 800 g = 13.33 eggs = 66.67 kr.
const eggs = food('Eggs', { protein: 12.5, pieceWeight: 60, price: { kronor: 30, quantity: 6, pieces: true } });
// A food counted in pieces: 4 bars for 40 kr, 10 g protein per bar → 100 g protein = 10 bars = 100 kr.
const bars = food('Bars', { baseQuantity: 1, unit: 'piece', protein: 10, price: { kronor: 40, quantity: 4 } });

test('protein cost scales the price by how much food holds the protein', () => {
  assert.equal(proteinCost(quark, 100), 32);
  assert.equal(proteinCost(quark, 175), 56);
  assert.equal(priceQuantity(eggs), 360);
  assert.ok(Math.abs(proteinCost(eggs, 100) - 200 / 3) < 1e-9);
  assert.equal(proteinCost(bars, 100), 100);
  assert.equal(proteinCost(food('Plain'), 100), null);
  assert.equal(proteinCost(food('Oil', { protein: 0, price: { kronor: 50, quantity: 1000 } }), 100), null);
});

test('the ranking lists cheapest protein first and keeps unpriced and protein-free foods apart', () => {
  const oil = food('Oil', { protein: 0, price: { kronor: 50, quantity: 1000 } });
  const { ranked, noPrice, noProtein } = rankByProteinCost([bars, eggs, food('Plain'), quark, oil], 175);
  assert.deepEqual(ranked.map(row => row.food.id), ['Quark', 'Eggs', 'Bars']);
  assert.equal(ranked[0].cost, 56);
  assert.deepEqual(noPrice.map(f => f.id), ['Plain']);
  assert.deepEqual(noProtein.map(f => f.id), ['Oil']);
});

test('prices are kept in the synced journal and validated; foods without one stay unchanged', () => {
  const data = normalizeData({ ...emptyData(), foods: [quark, eggs, bars, food('Plain')] });
  assert.deepEqual(data.foods[0].price, { kronor: 32, quantity: 500 });
  assert.deepEqual(data.foods[1].price, { kronor: 30, quantity: 6, pieces: true });
  assert.equal('price' in data.foods[3], false);
  assert.throws(() => normalizeData({ ...emptyData(), foods: [food('X', { price: { kronor: 10, quantity: 2, pieces: true } })] }), /piece weight/);
  assert.throws(() => normalizeData({ ...emptyData(), foods: [food('X', { price: { kronor: -1, quantity: 2 } })] }), /price/);
  assert.throws(() => normalizeData({ ...emptyData(), foods: [food('X', { price: { kronor: 1, quantity: 0 } })] }), /price quantity/);
});

test('a price added on one device merges with other changes', () => {
  const base = normalizeData({ ...emptyData(), foods: [food('Quark')] });
  const local = normalizeData({ ...base, foods: [quark] });
  const remote = normalizeData({ ...base, foods: [food('Quark'), food('Tofu')] });
  const merged = mergeJournals(base, local, remote);
  assert.deepEqual(merged.foods.find(f => f.id === 'Quark').price, { kronor: 32, quantity: 500 });
  assert.ok(merged.foods.some(f => f.id === 'Tofu'));
});
