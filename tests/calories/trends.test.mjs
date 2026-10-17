import test from 'node:test';
import assert from 'node:assert/strict';
import { KCAL_PER_KG, planForRate, summarizeTrend, trendDays } from '../../src/lib/calories/trends.ts';
import { emptyData, manualMealEntry } from '../../src/lib/calories/model.ts';

const today = '2026-10-12';
const meal = (date, calories) => manualMealEntry({ id: `m-${date}`, date, meal: 'Dinner', name: 'Meal', protein: calories / 4, carbs: 0, fat: 0, fiber: 0 });
const data = entries => ({ ...emptyData(), entries, defaults: { burned: 3000, deficit: 500, protein: 175, burnedSource: 'manual' } });

test('trend window ends yesterday, oldest first, and unlogged days are not zero-calorie days', () => {
  const days = trendDays(data([meal('2026-10-11', 2500), meal('2026-10-09', 2000)]), [], 4, today);
  assert.deepEqual(days.map(d => d.date), ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.deepEqual(days.map(d => d.logged), [false, true, false, true]);
  assert.equal(days[0].deficit, null);
  assert.equal(days[3].deficit, 500);
});

test('summary averages only logged or measured days and converts deficit to kilograms', () => {
  const s = summarizeTrend(trendDays(data([meal('2026-10-11', 2500), meal('2026-10-10', 2000)]), [], 7, today));
  assert.equal(s.loggedDays, 2);
  assert.equal(s.avgEaten, 2250);
  assert.equal(s.avgDeficit, 750);
  assert.equal(s.totalDeficit, 1500);
  assert.equal(s.estimatedKg, 1500 / KCAL_PER_KG);
  assert.ok(Math.abs(s.kgPerWeek - 750 * 7 / KCAL_PER_KG) < 1e-12);
});

test('an empty window summarises to nulls instead of NaN', () => {
  const s = summarizeTrend(trendDays(emptyData(), [], 7, today));
  assert.equal(s.loggedDays, 0);
  assert.equal(s.avgEaten, null);
  assert.equal(s.kgPerWeek, null);
});

test('diet plan converts a weekly rate to a budget and caps the deficit', () => {
  const p = planForRate(3000, 0.5);
  assert.equal(p.capped, false);
  assert.ok(Math.abs(p.deficit - 550) < 1e-9);
  assert.ok(Math.abs(p.budget - 2450) < 1e-9);
  const fast = planForRate(3000, 2);
  assert.equal(fast.capped, true);
  assert.equal(fast.deficit, 1000);
  assert.equal(fast.budget, 2000);
  assert.throws(() => planForRate(Number.NaN, 0.5));
});
