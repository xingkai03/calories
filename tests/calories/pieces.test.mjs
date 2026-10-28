import test from 'node:test';
import assert from 'node:assert/strict';
import { canLogPieces, emptyData, macrosForFood, normalizeData, quantityFromPieces } from '../../src/lib/calories/model.ts';

// Label gives nutrition per 100 g; one slice weighs 19 g.
const cheese = { id: 'cheese', name: 'Cheese slices', baseQuantity: 100, unit: 'g', state: 'As served', pieceWeight: 19, carbs: 0, protein: 27, fat: 26, fiber: 0, calories: 342 };

test('pieces convert to the food’s weight and scale from the per-100 g values', () => {
  assert.equal(canLogPieces(cheese), true);
  assert.equal(quantityFromPieces(cheese, 2), 38);
  const two = macrosForFood(cheese, quantityFromPieces(cheese, 2));
  assert.ok(Math.abs(two.protein - 10.26) < 1e-9);
  assert.ok(Math.abs(two.calories - macrosForFood(cheese, 38).calories) < 1e-9);
});

test('only gram or millilitre foods with a piece weight can be logged by the piece', () => {
  assert.equal(canLogPieces({ unit: 'g' }), false);
  assert.equal(canLogPieces({ unit: 'ml', pieceWeight: 330 }), true);
  assert.equal(canLogPieces({ unit: 'piece', pieceWeight: 19 }), false);
});

test('piece weights and piece counts survive a backup round trip; older data stays unchanged', () => {
  const entry = { id: 'e1', date: '2026-10-28', meal: 'Breakfast', foodId: cheese.id, foodName: cheese.name, quantity: 38, unit: 'g', state: 'As served', pieces: 2, ...macrosForFood(cheese, 38) };
  const data = normalizeData({ ...emptyData(), foods: [cheese], entries: [entry] });
  assert.equal(data.foods[0].pieceWeight, 19);
  assert.equal(data.entries[0].pieces, 2);
  const { pieceWeight, ...plain } = cheese;
  const old = normalizeData({ ...emptyData(), foods: [plain], entries: [{ ...entry, pieces: undefined }] });
  assert.equal('pieceWeight' in old.foods[0], false);
  assert.equal('pieces' in old.entries[0], false);
});

test('invalid piece data is rejected', () => {
  assert.throws(() => normalizeData({ ...emptyData(), foods: [{ ...cheese, pieceWeight: 0 }] }), /piece weight/);
  assert.throws(() => normalizeData({ ...emptyData(), foods: [{ ...cheese, unit: 'piece', baseQuantity: 1 }] }), /piece weight/);
  const entry = { id: 'e1', date: '2026-10-28', meal: 'Lunch', foodId: 'x', foodName: 'X', quantity: 2, unit: 'piece', state: 'Raw', pieces: 2, carbs: 0, protein: 0, fat: 0, fiber: 0, calories: 0 };
  assert.throws(() => normalizeData({ ...emptyData(), entries: [entry] }), /piece count/);
});
