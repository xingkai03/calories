import test from 'node:test';
import assert from 'node:assert/strict';
import { foodUsage, mealForTime, rankFoods } from '../../src/lib/calories/food-order.ts';

const FOURTEEN_DAYS = { window: 14, sort: 'frequent' };

const food = (id, name, overrides = {}) => ({
  id, name, baseQuantity: 100, unit: 'g', state: 'Cooked',
  protein: 6, carbs: 12, fat: 1, fiber: 5, calories: 81,
  ...overrides,
});
const entry = (id, foodId, date, overrides = {}) => ({
  id, foodId, date, meal: 'Lunch', foodName: `Recorded ${foodId}`,
  quantity: 100, unit: 'g', state: 'Cooked',
  protein: 6, carbs: 12, fat: 1, fiber: 5, calories: 81,
  ...overrides,
});
const ids = values => values.map(value => value.id);

test('the 14-date window includes today and 13 days ago, excluding older and future logs', () => {
  const foods = [food('older', 'Alpha'), food('future', 'Beta'), food('middle', 'Middle'), food('edges', 'Zulu')];
  const entries = [
    entry('first-edge', 'edges', '2026-10-01'),
    entry('last-edge', 'edges', '2026-10-14'),
    entry('middle', 'middle', '2026-10-07'),
    ...[1, 2, 3].map(id => entry(`old-${id}`, 'older', '2026-09-30')),
    ...[1, 2, 3].map(id => entry(`future-${id}`, 'future', '2026-10-15')),
  ];
  assert.deepEqual(ids(rankFoods(foods, entries, '2026-10-14', FOURTEEN_DAYS).foods), ['edges', 'middle', 'older', 'future']);
});

test('frequency counts individual entries, including repeated foods in one meal, rather than portion size or energy', () => {
  const foods = [food('large', 'Apple'), food('repeated', 'Zucchini')];
  const entries = [
    entry('large-portion', 'large', '2026-10-14', { quantity: 10000, calories: 100000 }),
    entry('first-bite', 'repeated', '2026-10-14', { quantity: 0.1, calories: 0.081 }),
    entry('second-bite', 'repeated', '2026-10-14', { quantity: 1, calories: 0.81 }),
  ];
  assert.deepEqual(ids(rankFoods(foods, entries, '2026-10-14', FOURTEEN_DAYS).foods), ['repeated', 'large']);
});

test('food IDs survive renamed foods and old snapshots; deleted food logs never become library choices', () => {
  const renamed = food('original-id', 'Zulu renamed food', { protein: 20, calories: 137 });
  const sameOldName = food('different-id', 'Old food name');
  const foods = [sameOldName, renamed];
  const entries = [
    entry('old-snapshot-1', renamed.id, '2026-10-13', { foodName: 'Old food name', protein: 1, calories: 61 }),
    entry('old-snapshot-2', renamed.id, '2026-10-14', { foodName: 'Old food name', protein: 2, calories: 65 }),
    ...[1, 2, 3].map(id => entry(`deleted-${id}`, 'deleted-id', '2026-10-14', { foodName: renamed.name })),
  ];
  assert.deepEqual(rankFoods(foods, entries, '2026-10-14', FOURTEEN_DAYS).foods, [renamed, sameOldName]);
});

test('manual source flags and canonical legacy manual IDs are excluded without excluding unrelated ID prefixes', () => {
  const foods = [
    food('regular', 'Alpha'),
    food('unused', 'Beta'),
    food('manual:unrelated', 'Xylophone'),
    food('manual:legacy-entry', 'Yam'),
    food('flagged', 'Zucchini'),
  ];
  const entries = [
    entry('regular-entry', 'regular', '2026-10-14'),
    entry('prefix-1', 'manual:unrelated', '2026-10-14'),
    entry('prefix-2', 'manual:unrelated', '2026-10-13'),
    // The source flag is absent in a legacy manual snapshot; its canonical ID still identifies it.
    entry('legacy-entry', 'manual:legacy-entry', '2026-10-14'),
    ...[1, 2, 3, 4].map(id => entry(`manual-${id}`, 'flagged', '2026-10-14', { source: 'manual' })),
  ];
  assert.deepEqual(ids(rankFoods(foods, entries, '2026-10-14', FOURTEEN_DAYS).foods), [
    'manual:unrelated', 'regular', 'unused', 'manual:legacy-entry', 'flagged',
  ]);
});

test('equal frequencies sort alphabetically, then by ID for duplicate names, independently of input order', () => {
  const foods = [food('rice-z', 'Rice'), food('pear', 'Pear'), food('rice-a', 'Rice'), food('apple', 'Apple')];
  const expected = ['apple', 'pear', 'rice-a', 'rice-z'];
  assert.deepEqual(ids(rankFoods(foods, [], '2026-10-14', FOURTEEN_DAYS).foods), expected, 'unused foods also receive stable alphabetical ordering');
  const entries = foods.flatMap(item => [
    entry(`${item.id}-1`, item.id, '2026-10-12'),
    entry(`${item.id}-2`, item.id, '2026-10-14'),
  ]);
  assert.deepEqual(ids(rankFoods(foods, entries, '2026-10-14', FOURTEEN_DAYS).foods), expected);
  assert.deepEqual(ids(rankFoods([...foods].reverse(), [...entries].reverse(), '2026-10-14', FOURTEEN_DAYS).foods), expected);
});

test('sorting leaves the supplied arrays, library records and recorded nutrient snapshots unchanged', () => {
  const foods = [food('apple', 'Apple'), food('peas', 'Peas')];
  const entries = [entry('peas-old-values', 'peas', '2026-10-14', { foodName: 'Original peas', protein: 2, calories: 65 })];
  const beforeFoods = structuredClone(foods);
  const beforeEntries = structuredClone(entries);
  for (const item of [...foods, ...entries]) Object.freeze(item);
  Object.freeze(foods);
  Object.freeze(entries);

  assert.deepEqual(rankFoods(foods, entries, '2026-10-14', FOURTEEN_DAYS).foods, [foods[1], foods[0]]);
  assert.deepEqual(foods, beforeFoods);
  assert.deepEqual(entries, beforeEntries);
  assert.deepEqual(rankFoods([], entries, '2026-10-14', FOURTEEN_DAYS).foods, []);
});

test('a new calendar-day anchor expires the old boundary and admits the newly current day across a year boundary', () => {
  const foods = [food('new-day', 'Apple'), food('recent', 'Banana'), food('old-boundary', 'Zucchini')];
  const entries = [
    ...[1, 2, 3].map(id => entry(`old-${id}`, 'old-boundary', '2025-12-21')),
    entry('recent', 'recent', '2026-01-03'),
    ...[1, 2].map(id => entry(`next-${id}`, 'new-day', '2026-01-04')),
  ];
  assert.deepEqual(ids(rankFoods(foods, entries, '2026-01-03', FOURTEEN_DAYS).foods), ['old-boundary', 'recent', 'new-day']);
  assert.deepEqual(ids(rankFoods(foods, entries, '2026-01-04', FOURTEEN_DAYS).foods), ['new-day', 'recent', 'old-boundary']);
});

test('calendar-window boundaries remain inclusive across leap day and the Stockholm daylight-saving change', () => {
  const foods = [food('outside', 'Apple'), food('inside', 'Zulu')];
  for (const [currentDay, firstDay, outsideDay] of [
    ['2024-03-01', '2024-02-17', '2024-02-16'],
    ['2026-10-26', '2026-10-13', '2026-10-12'],
  ]) {
    const entries = [
      entry('included', 'inside', firstDay),
      entry('excluded-1', 'outside', outsideDay),
      entry('excluded-2', 'outside', outsideDay),
    ];
    assert.deepEqual(ids(rankFoods(foods, entries, currentDay, FOURTEEN_DAYS).foods), ['inside', 'outside'], currentDay);
  }
});

test('a 7-day window covers today and the six days before, ignoring manual, older and future logs', () => {
  const foods = ['week-edge', 'today', 'too-old', 'future', 'flagged'].map(id => food(id, id));
  const entries = [
    entry('edge', 'week-edge', '2026-10-08'),
    entry('today', 'today', '2026-10-14'),
    entry('old', 'too-old', '2026-10-07'),
    entry('future', 'future', '2026-10-15'),
    entry('manual', 'manual:manual', '2026-10-14'),
    entry('manual-source', 'flagged', '2026-10-14', { source: 'manual' }),
  ];
  assert.deepEqual([...rankFoods(foods, entries, '2026-10-14', { window: 7, sort: 'frequent' }).usedIds].sort(), ['today', 'week-edge']);
  assert.equal(rankFoods(foods, entries, '2026-10-14', { window: 0, sort: 'frequent' }).usedIds, null, 'all time hides nothing');
});

test('foods can be ranked by frequency, most recent use or name', () => {
  const foods = [food('often', 'Oats'), food('latest', 'Lentils'), food('never', 'Apple'), food('old', 'Zucchini')];
  const entries = [
    ...[1, 2, 3].map(id => entry(`often-${id}`, 'often', '2026-10-10')),
    entry('latest', 'latest', '2026-10-14'),
    ...[1, 2, 3, 4].map(id => entry(`old-${id}`, 'old', '2026-08-01')),
  ];
  const rank = (window, sort) => ids(rankFoods(foods, entries, '2026-10-14', { window, sort }).foods);
  assert.deepEqual(rank(7, 'frequent'), ['often', 'latest', 'old', 'never'], 'ties fall back to the most recent use');
  assert.deepEqual(rank(0, 'frequent'), ['old', 'often', 'latest', 'never']);
  assert.deepEqual(rank(7, 'recent'), ['latest', 'often', 'old', 'never']);
  assert.deepEqual(rank(7, 'name'), ['never', 'latest', 'often', 'old']);
});

test('food usage lists every library log newest first and totals what was eaten', () => {
  const entries = [
    entry('a', 'rice', '2026-10-01', { quantity: 150, calories: 200 }),
    entry('b', 'rice', '2026-10-12', { quantity: 100, calories: 130, meal: 'Dinner' }),
    entry('c', 'rice', '2026-10-12', { quantity: 50, calories: 65, meal: 'Breakfast' }),
    entry('d', 'rice', '2026-10-13', { quantity: 1, unit: 'piece', calories: 90 }),
    entry('planned', 'rice', '2026-10-20', { quantity: 80, calories: 100 }),
    entry('manual', 'rice', '2026-10-13', { source: 'manual' }),
    entry('other', 'oats', '2026-10-13'),
  ];
  const usage = foodUsage(entries, 'rice', '2026-10-14');
  assert.deepEqual(usage.entries.map(item => item.id), ['planned', 'd', 'c', 'b', 'a']);
  assert.equal(usage.count, 4);
  assert.equal(usage.days, 3);
  assert.equal(usage.firstDate, '2026-10-01');
  assert.equal(usage.lastDate, '2026-10-13');
  assert.deepEqual(usage.amounts, [{ unit: 'piece', quantity: 1, count: 1 }, { unit: 'g', quantity: 300, count: 3 }], 'units in order of most recent use');
  assert.equal(usage.calories, 485);
  assert.equal(usage.last7, 3);
  assert.equal(usage.last30, 4);
  assert.deepEqual(foodUsage(entries, 'missing', '2026-10-14'), { entries: [], count: 0, days: 0, firstDate: null, lastDate: null, amounts: [], calories: 0, last7: 0, last30: 0 });
});

test('the default meal follows the local time of day', () => {
  const at = hour => mealForTime(new Date(2026, 9, 14, hour, 30));
  assert.deepEqual([0, 3, 4, 10, 11, 15, 16, 21, 23].map(at), ['Dinner', 'Dinner', 'Breakfast', 'Breakfast', 'Lunch', 'Lunch', 'Dinner', 'Dinner', 'Dinner']);
});
