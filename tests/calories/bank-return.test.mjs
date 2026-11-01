import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeFoodBankPortion, groupFoodBankPortions, prepareFoodBankPortions, removeJournalEntry } from '../../src/lib/calories/food-bank.ts';
import { createUndoAction, undoAction, UndoConflictError } from '../../src/lib/calories/undo.ts';
import { mergeJournals } from '../../src/lib/calories/offline.ts';
import { emptyData, normalizeData } from '../../src/lib/calories/model.ts';

const rice = { id: 'rice', name: 'Rice', baseQuantity: 100, unit: 'g', state: 'Cooked', protein: 3, carbs: 28, fat: 1, fiber: 2, calories: 133 };
const egg = { id: 'egg', name: 'Eggs', baseQuantity: 2, unit: 'piece', state: 'Raw', protein: 12, carbs: 1, fat: 10, fiber: 0, calories: 142 };
const ids = () => { let next = 0; return () => `id-${++next}`; };
const bank = (count = 3) => ({ ...emptyData(), foods: [rice, egg], foodBank: prepareFoodBankPortions([rice, egg], [{ foodId: 'rice', quantity: 150 }, { foodId: 'egg', quantity: 1 }], count, 'Rice and egg', ids()) });
const date = '2026-11-01';

test('eaten portions remember where they came from, and survive a backup round trip', () => {
  const start = bank();
  const eaten = consumeFoodBankPortion(start, start.foodBank[0].id, date, 'Lunch');
  assert.deepEqual(eaten.entries.map(entry => entry.bankPortion), [{ id: 'id-1', name: 'Rice and egg' }, { id: 'id-1', name: 'Rice and egg' }]);
  assert.deepEqual(normalizeData(JSON.parse(JSON.stringify(eaten))), eaten);
  assert.throws(() => normalizeData({ ...eaten, entries: [{ ...eaten.entries[0], bankPortion: { id: '', name: 'x' } }] }), /Invalid/);
  assert.throws(() => normalizeData({ ...start, foodBank: [{ ...start.foodBank[0], items: [{ ...start.foodBank[0].items[0], bankPortion: { id: 'a', name: 'b' } }] }] }), /metadata/);
});

test('removing every ingredient of an eaten portion puts it back whole, rejoining its group', () => {
  const start = bank();
  const eaten = consumeFoodBankPortion(start, start.foodBank[0].id, date, 'Lunch');
  assert.equal(groupFoodBankPortions(eaten.foodBank)[0].portions.length, 2);
  // Remove the egg first: ingredient order does not stop the portion from regrouping.
  const half = removeJournalEntry(eaten, eaten.entries[1].id);
  assert.equal(half.entries.length, 1);
  assert.deepEqual(half.foodBank.at(-1), { id: 'id-1', name: 'Rice and egg', items: [start.foodBank[0].items[1]] });
  const back = removeJournalEntry(half, half.entries[0].id);
  assert.deepEqual(back.entries, []);
  assert.equal(back.foodBank.length, 3);
  const groups = groupFoodBankPortions(back.foodBank);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].portions.length, 3);
  // It can be eaten again with the same ingredient IDs.
  const again = consumeFoodBankPortion(back, 'id-1', date, 'Dinner');
  assert.deepEqual(again.entries.map(entry => entry.id).sort(), start.foodBank[0].items.map(item => item.id).sort());
});

test('entries not from the food bank are simply removed', () => {
  const data = { ...emptyData(), entries: [{ id: 'plain', date, meal: 'Lunch', foodId: 'rice', foodName: 'Rice', quantity: 100, unit: 'g', state: 'Cooked', protein: 3, carbs: 28, fat: 1, fiber: 2, calories: 133 }] };
  assert.deepEqual(removeJournalEntry(data, 'plain'), { ...normalizeData(data), entries: [] });
  assert.throws(() => removeJournalEntry(data, 'missing'), /no longer available/);
});

test('an edited amount goes back as eaten, as its own portion', () => {
  const start = bank(2);
  const eaten = consumeFoodBankPortion(start, start.foodBank[0].id, date, 'Lunch');
  const edited = { ...eaten, entries: eaten.entries.map((entry, index) => index === 0 ? { ...entry, quantity: 75, protein: 2.25, carbs: 21, fat: 0.75, fiber: 1.5, calories: 99.75 } : entry) };
  const back = removeJournalEntry(removeJournalEntry(edited, 'id-2'), 'id-3');
  assert.equal(back.foodBank.find(portion => portion.id === 'id-1').items.find(item => item.id === 'id-2').quantity, 75);
  assert.equal(groupFoodBankPortions(back.foodBank).length, 2);
});

test('Undo takes a returned ingredient back out of the bank and restores the entry', () => {
  const start = bank(2);
  const eaten = consumeFoodBankPortion(start, start.foodBank[0].id, date, 'Lunch');
  const removed = removeJournalEntry(eaten, 'id-2');
  const receipt = createUndoAction(eaten, removed, 'delete-entry', 'id-2', () => 'undo');
  assert.deepEqual(undoAction(removed, receipt), eaten);
  const both = removeJournalEntry(removed, 'id-3');
  const second = createUndoAction(removed, both, 'delete-entry', 'id-3', () => 'undo-2');
  assert.deepEqual(undoAction(both, second), removed);
  // Once the returned portion is eaten again, Undo of the removal cannot double the food.
  const reEaten = consumeFoodBankPortion(removed, 'id-1', date, 'Dinner');
  assert.throws(() => undoAction(reEaten, receipt), UndoConflictError);
  // A plain-delete receipt cannot be built for a bank entry: the bank must change too.
  assert.throws(() => createUndoAction(eaten, { ...eaten, entries: eaten.entries.filter(entry => entry.id !== 'id-2') }, 'delete-entry', 'id-2'));
});

test('a portion returned on one device syncs with the other device unchanged', () => {
  const start = bank(2);
  const base = consumeFoodBankPortion(start, start.foodBank[0].id, date, 'Lunch');
  const local = removeJournalEntry(removeJournalEntry(base, 'id-2'), 'id-3');
  const remote = consumeFoodBankPortion(base, 'id-4', date, 'Dinner');
  const merged = mergeJournals(base, local, remote);
  assert.deepEqual(merged.foodBank.map(portion => portion.id), ['id-1']);
  assert.deepEqual(merged.entries.map(entry => entry.id).sort(), ['id-5', 'id-6']);
});
