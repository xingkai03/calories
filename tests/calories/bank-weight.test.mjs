import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeFoodBankPortion, groupFoodBankPortions, nutritionForGrams, prepareFoodBankBatch, prepareFoodBankPortions, removeJournalEntry } from '../../src/lib/calories/food-bank.ts';
import { createUndoAction, undoAction, UndoConflictError } from '../../src/lib/calories/undo.ts';
import { mergeJournals } from '../../src/lib/calories/offline.ts';
import { emptyData, normalizeData } from '../../src/lib/calories/model.ts';

const rice = { id: 'rice', name: 'Rice', baseQuantity: 100, unit: 'g', state: 'Raw', protein: 7, carbs: 78, fat: 1, fiber: 1, calories: 349 };
const chicken = { id: 'chicken', name: 'Chicken', baseQuantity: 100, unit: 'g', state: 'Raw', protein: 23, carbs: 0, fat: 2, fiber: 0, calories: 110 };
const ids = () => { let next = 0; return () => `id-${++next}`; };
const date = '2026-11-01';
// 300 g raw rice + 500 g chicken cooked into 1000 g of food.
const curry = () => ({ ...emptyData(), foods: [rice, chicken], foodBank: prepareFoodBankBatch([rice, chicken], [{ foodId: 'rice', quantity: 300 }, { foodId: 'chicken', quantity: 500 }, { manual: { name: 'Sauce', protein: 0, carbs: 20, fat: 10, fiber: 0 } }], 1000, 'Chicken curry', ids()) });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test('a batch kept by weight stores its ingredients and how many grams are left', () => {
  const data = curry();
  assert.equal(data.foodBank.length, 1);
  assert.deepEqual(data.foodBank[0].weight, { total: 1000, left: 1000 });
  assert.equal(data.foodBank[0].items.length, 3);
  // 300 g rice: 21 P, 234 C, 3 F; 500 g chicken: 115 P, 10 F; sauce 20 C, 10 F → per 100 g one tenth.
  const per100 = nutritionForGrams(data.foodBank[0], 100);
  close(per100.protein, 13.6); close(per100.carbs, 25.4); close(per100.fat, 2.3);
  assert.deepEqual(normalizeData(JSON.parse(JSON.stringify(data))), data);
  assert.throws(() => prepareFoodBankBatch([rice], [{ foodId: 'rice', quantity: 100 }], 0, 'Rice', ids()), /total weight/);
  assert.throws(() => normalizeData({ ...data, foodBank: [{ ...data.foodBank[0], weight: { total: 100, left: 200 } }] }), /more is left/);
  assert.throws(() => normalizeData({ ...data, foodBank: [{ ...data.foodBank[0], weight: { total: 100, left: 0 } }] }), /weight left/);
});

test('eating takes grams off what is left, as one journal entry, until the batch is used up', () => {
  const start = curry();
  const lunch = consumeFoodBankPortion(start, 'id-1', date, 'Lunch', { grams: 250, entryId: 'e1' });
  assert.deepEqual(lunch.foodBank[0].weight, { total: 1000, left: 750 });
  assert.equal(lunch.entries.length, 1);
  const entry = lunch.entries[0];
  assert.equal(entry.foodName, 'Chicken curry');
  assert.equal(entry.foodId, 'bank:id-1');
  assert.equal(entry.quantity, 250);
  assert.equal(entry.unit, 'g');
  assert.deepEqual(entry.bankPortion, { id: 'id-1', name: 'Chicken curry' });
  close(entry.protein, 34); close(entry.calories, nutritionForGrams(start.foodBank[0], 250).calories);
  assert.throws(() => consumeFoodBankPortion(lunch, 'id-1', date, 'Dinner', { grams: 751, entryId: 'e2' }), /more than is left/);
  assert.throws(() => consumeFoodBankPortion(lunch, 'id-1', date, 'Dinner'), /how many grams/);
  const dinner = consumeFoodBankPortion(lunch, 'id-1', date, 'Dinner', { grams: 750, entryId: 'e2' });
  assert.deepEqual(dinner.foodBank, []);
  assert.deepEqual(dinner.entries.map(item => item.quantity), [250, 750]);
  // A whole portion is never eaten by the gram.
  const portions = { ...emptyData(), foods: [rice], foodBank: prepareFoodBankPortions([rice], [{ foodId: 'rice', quantity: 100 }], 1, 'Rice', ids()) };
  assert.throws(() => consumeFoodBankPortion(portions, 'id-1', date, 'Lunch', { grams: 50, entryId: 'e3' }), /eaten whole/);
});

test('batches kept by weight are never grouped together', () => {
  const one = prepareFoodBankBatch([rice], [{ foodId: 'rice', quantity: 100 }], 300, 'Rice', () => `a${Math.random()}`);
  const two = prepareFoodBankBatch([rice], [{ foodId: 'rice', quantity: 100 }], 300, 'Rice', () => `b${Math.random()}`);
  assert.equal(groupFoodBankPortions([...one, ...two]).length, 2);
});

test('removing an entry puts its grams back into the batch, or brings a used-up batch back', () => {
  const lunch = consumeFoodBankPortion(curry(), 'id-1', date, 'Lunch', { grams: 250, entryId: 'e1' });
  const back = removeJournalEntry(lunch, 'e1');
  assert.deepEqual(back, { ...curry(), days: lunch.days });
  // Grams never go above what the batch first held, e.g. after the entry was edited upward.
  const edited = { ...lunch, entries: [{ ...lunch.entries[0], quantity: 400 }] };
  assert.deepEqual(removeJournalEntry(edited, 'e1').foodBank[0].weight, { total: 1000, left: 1000 });
  // A used-up batch returns holding just the grams removed, with the same nutrition per gram.
  const all = consumeFoodBankPortion(lunch, 'id-1', date, 'Dinner', { grams: 750, entryId: 'e2' });
  const returned = removeJournalEntry(all, 'e2');
  assert.equal(returned.foodBank.length, 1);
  const batch = returned.foodBank[0];
  assert.equal(batch.id, 'id-1');
  assert.deepEqual(batch.weight, { total: 750, left: 750 });
  close(nutritionForGrams(batch, 100).protein, 13.6);
  // And it can be eaten from again, and returned into the same batch.
  const again = consumeFoodBankPortion(returned, 'id-1', date, 'Snack', { grams: 100, entryId: 'e3' });
  close(again.entries.at(-1).protein, 13.6);
  assert.deepEqual(removeJournalEntry(again, 'e3').foodBank, returned.foodBank);
});

test('Undo of eating puts the grams back, and Undo of a removal takes them out again', () => {
  const start = curry();
  const lunch = consumeFoodBankPortion(start, 'id-1', date, 'Lunch', { grams: 250, entryId: 'e1' });
  const eatReceipt = createUndoAction(start, lunch, 'consume-bank', 'id-1', () => 'u1');
  const roundTrip = JSON.parse(JSON.stringify(eatReceipt));
  assert.deepEqual(undoAction(lunch, roundTrip), normalizeData({ ...start, days: lunch.days }));
  // Undo of eating the rest brings the used-up batch back.
  const dinner = consumeFoodBankPortion(lunch, 'id-1', date, 'Dinner', { grams: 750, entryId: 'e2' });
  const rest = createUndoAction(lunch, dinner, 'consume-bank', 'id-1', () => 'u2');
  assert.deepEqual(undoAction(dinner, rest), lunch);
  // Undo refuses once the batch changed again.
  const snack = consumeFoodBankPortion(lunch, 'id-1', date, 'Snack', { grams: 50, entryId: 'e3' });
  assert.throws(() => undoAction(snack, eatReceipt), UndoConflictError);

  const removed = removeJournalEntry(lunch, 'e1');
  const removeReceipt = createUndoAction(lunch, removed, 'delete-entry', 'e1', () => 'u3');
  assert.deepEqual(undoAction(removed, JSON.parse(JSON.stringify(removeReceipt))), lunch);
  // A batch brought back by a removal goes away again on Undo.
  const removedAll = removeJournalEntry(dinner, 'e2');
  const allReceipt = createUndoAction(dinner, removedAll, 'delete-entry', 'e2', () => 'u4');
  assert.deepEqual(undoAction(removedAll, allReceipt), dinner);
  // Once the returned grams are eaten again, Undo cannot double the food.
  const reEaten = consumeFoodBankPortion(removed, 'id-1', date, 'Dinner', { grams: 100, entryId: 'e4' });
  assert.throws(() => undoAction(reEaten, removeReceipt), UndoConflictError);
});

test('eating from a batch on one device syncs to another device', () => {
  const base = curry();
  const local = consumeFoodBankPortion(base, 'id-1', date, 'Lunch', { grams: 200, entryId: 'e1' });
  const merged = mergeJournals(base, local, base);
  assert.deepEqual(merged, local);
});

test('removing every entry of a used-up batch brings all of its grams back, in any order', () => {
  const milkFood = { id: 'milk', name: 'Milk', baseQuantity: 100, unit: 'ml', state: 'As served', protein: 3.4, carbs: 5, fat: 3.6, fiber: 0, calories: 64 };
  const start = { ...emptyData(), foods: [milkFood], foodBank: prepareFoodBankBatch([milkFood], [{ foodId: 'milk', quantity: 2000 }], 2000, 'Milk', ids()) };
  const first = consumeFoodBankPortion(start, 'id-1', date, 'Breakfast', { grams: 400, entryId: 'e1' });
  const usedUp = consumeFoodBankPortion(first, 'id-1', date, 'Lunch', { grams: 1600, entryId: 'e2' });
  assert.deepEqual(usedUp.foodBank, []);
  for (const order of [['e2', 'e1'], ['e1', 'e2']]) {
    const once = removeJournalEntry(usedUp, order[0]);
    const both = removeJournalEntry(once, order[1]);
    assert.equal(both.foodBank.length, 1);
    const batch = both.foodBank[0];
    assert.deepEqual(batch.weight, { total: 2000, left: 2000 }, order.join(' then '));
    close(nutritionForGrams(batch, 2000).calories, nutritionForGrams(start.foodBank[0], 2000).calories);
    close(nutritionForGrams(batch, 100).protein, 3.4);
    // Undo of the second removal takes its grams out again.
    const receipt = createUndoAction(once, both, 'delete-entry', order[1], () => 'u1');
    assert.deepEqual(undoAction(both, JSON.parse(JSON.stringify(receipt))), once);
  }
  // A batch brought back and partly eaten again only grows by what does not fit.
  const back = removeJournalEntry(usedUp, 'e2');
  const sip = consumeFoodBankPortion(back, 'id-1', date, 'Snack', { grams: 100, entryId: 'e3' });
  const sipBack = removeJournalEntry(sip, 'e3');
  assert.deepEqual(sipBack.foodBank[0].weight, { total: 1600, left: 1600 });
  assert.deepEqual(removeJournalEntry(sipBack, 'e1').foodBank[0].weight, { total: 2000, left: 2000 });
  const partly = consumeFoodBankPortion(back, 'id-1', date, 'Snack', { grams: 100, entryId: 'e3' });
  assert.deepEqual(removeJournalEntry(partly, 'e1').foodBank[0].weight, { total: 1900, left: 1900 });
});
