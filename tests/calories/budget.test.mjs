import test from 'node:test';
import assert from 'node:assert/strict';
import { CARRY_SPREAD_DAYS, MAX_DAILY_DEFICIT, adjustedBudget, calorieLedger, carryBefore, outstandingAfter } from '../../src/lib/calories/budget.ts';
import { emptyData, manualMealEntry } from '../../src/lib/calories/model.ts';
import { effectiveBurned } from '../../src/lib/calories/garmin.ts';

const today = '2026-10-12';
const settings = (burned = 3200, deficit = 500, burnedSource = 'manual') => ({
  burned, deficit, protein: 175,
  ...(burnedSource ? { burnedSource } : {}),
});
const meal = (date, calories, id = `meal-${date}`) => manualMealEntry({
  id, date, meal: 'Dinner', name: 'Recorded meal',
  protein: calories / 4, carbs: 0, fat: 0, fiber: 0,
});
const dataWith = (entries, defaults = settings()) => ({ ...emptyData(), entries, defaults });
const reading = (date, active, resting, total = active + resting) => ({
  date, active, resting, total, synced_at: `${date}T20:00:00Z`,
});
const threeDays = () => dataWith([
  meal('2026-10-11', 2600),
  meal('2026-10-09', 2400),
  meal('2026-10-10', 2900),
]);

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message ?? ''} expected ${expected}, got ${actual}`);
const closeAll = (actual, expected, message) => { assert.equal(actual.length, expected.length, message); actual.forEach((value, index) => close(value, expected[index], message)); };
const range = (first, count) => Array.from({ length: count }, (_, index) => {
  const date = new Date(`${first}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + index); return date.toISOString().slice(0, 10);
});
/** Logs each day so that it eats exactly its own budget plus `over[i]` (positive = over budget). */
function eatAgainstBudget(dates, over, defaults, currentDay) {
  const entries = [];
  dates.forEach((date, index) => {
    const ledger = calorieLedger(dataWith(entries, defaults), [], currentDay);
    const budget = adjustedBudget(defaults.burned, defaults.deficit, carryBefore(date, ledger)).budget;
    entries.push(meal(date, budget + (over[index] ?? 0)));
  });
  return calorieLedger(dataWith(entries, defaults), [], currentDay);
}
const kai = settings(2500, 660); // base budget 1840

test('a day budget is base budget plus carry, never below zero', () => {
  assert.equal(CARRY_SPREAD_DAYS, 7);
  assert.equal(MAX_DAILY_DEFICIT, 1000, 'still the Trends planner cap');
  assert.deepEqual(adjustedBudget(3200, 500, 300), { baseBudget: 2700, carryIn: 300, rawBudget: 3000, budget: 3000, deferredDebt: 0 });
  assert.deepEqual(adjustedBudget(1000, 500, -900), { baseBudget: 500, carryIn: -900, rawBudget: -400, budget: 0, deferredDebt: 400 });
  assert.deepEqual(adjustedBudget(100, 500, 0), { baseBudget: 0, carryIn: 0, rawBudget: 0, budget: 0, deferredDebt: 0 });
  assert.deepEqual(adjustedBudget(0, 0), { baseBudget: 0, carryIn: 0, rawBudget: 0, budget: 0, deferredDebt: 0 });
  assert.deepEqual(adjustedBudget(3200, 500, 1200), { baseBudget: 2700, carryIn: 1200, rawBudget: 3900, budget: 3900, deferredDebt: 0 });
});

test('one big day is paid back in seven equal parts, then the budget returns to base', () => {
  const dates = range('2026-10-01', 10);
  const ledger = eatAgainstBudget(dates, [1500], kai, '2026-10-20');
  const rows = dates.map(date => ledger.days[date]);
  closeAll(rows.map(row => row.budget), [1840, ...Array(7).fill(1840 - 1500 / 7), 1840, 1840]);
  closeAll(rows.map(row => row.difference), [-1500, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'eating exactly the budget adds no new carry');
  closeAll(rows.map(row => row.balance), [-1500, -1500 * 6 / 7, -1500 * 5 / 7, -1500 * 4 / 7, -1500 * 3 / 7, -1500 * 2 / 7, -1500 / 7, 0, 0, 0]);
});

test('under-eating spreads the credit over the next seven days', () => {
  const dates = range('2026-10-01', 9);
  const ledger = eatAgainstBudget(dates, [-340], kai, '2026-10-20');
  closeAll(dates.map(date => ledger.days[date].budget), [1840, ...Array(7).fill(1840 + 340 / 7), 1840]);
  const sick = eatAgainstBudget(dates, [-1200], kai, '2026-10-20');
  close(sick.days['2026-10-02'].budget, 1840 + 1200 / 7, 'a large credit raises each day by a seventh, not all at once');
});

test('overlapping differences add up and each one ends after its own seven days', () => {
  // Saturday 800 over, Sunday 600 over its own (already reduced) budget.
  const dates = range('2026-10-03', 10);
  const ledger = eatAgainstBudget(dates, [800, 600], kai, '2026-10-20');
  const budgets = dates.map(date => ledger.days[date].budget);
  close(budgets[1], 1840 - 800 / 7, 'Sunday');
  for (const index of [2, 3, 4, 5, 6, 7]) close(budgets[index], 1840 - 200, 'Monday to the next Saturday');
  close(budgets[8], 1840 - 600 / 7, 'next Sunday: only Sunday is still being repaid');
  close(budgets[9], 1840, 'next Monday');
});

test('a day only receives carry from the previous seven calendar days', () => {
  const ledger = calorieLedger(dataWith([meal('2026-10-01', 1700)]), [], today);
  close(ledger.days['2026-10-01'].difference, 1000);
  for (const date of range('2026-10-02', 7)) close(carryBefore(date, ledger), 1000 / 7, date);
  assert.equal(carryBefore('2026-10-09', ledger), 0);
  assert.equal(carryBefore('2026-09-30', ledger), 0);
  assert.equal(carryBefore(today, calorieLedger(emptyData(), [], today)), 0);
});

test('three completed days spread their differences once', () => {
  const ledger = calorieLedger(threeDays(), [], today);
  assert.deepEqual(ledger.completed.map(day => day.date), ['2026-10-09', '2026-10-10', '2026-10-11']);
  closeAll(ledger.completed.map(day => day.carryIn), [0, 300 / 7, (300 - 1100 / 7) / 7]);
  closeAll(ledger.completed.map(day => day.difference), [300, -1100 / 7, 2700 + (300 - 1100 / 7) / 7 - 2600]);
  closeAll(ledger.completed.map(day => day.balance), [300, 100, 200], 'unpaid differences still to come');
  close(carryBefore(today, ledger), ledger.completed.reduce((sum, day) => sum + day.difference, 0) / 7);
  assert.ok(ledger.completed.every(day => day.settled));
});

test('every meal snapshot contributes to its day, independent of entry order', () => {
  const data = dataWith([
    meal('2026-10-10', 1800, 'late'),
    meal('2026-10-09', 1000, 'first'),
    meal('2026-10-10', 1200, 'early'),
    meal('2026-10-09', 1400, 'second'),
  ]);
  const ledger = calorieLedger(data, [], today);
  assert.equal(ledger.days['2026-10-09'].eaten, 2400);
  assert.equal(ledger.days['2026-10-10'].eaten, 3000);
});

test('gaps, settings-only days and Garmin-only dates do not create carry', () => {
  const data = dataWith([meal('2026-10-09', 2400), meal('2026-10-11', 2800)]);
  data.days['2026-10-10'] = settings(8000, 0);
  const ledger = calorieLedger(data, [reading('2026-10-08', 2000, 2500), reading('2026-10-10', 5000, 2500)], today);
  assert.deepEqual(Object.keys(ledger.days).sort(), ['2026-10-09', '2026-10-11']);
  close(ledger.days['2026-10-11'].carryIn, 300 / 7);
  close(carryBefore('2026-10-10', ledger), 300 / 7);
  close(carryBefore(today, ledger), (300 + 2700 + 300 / 7 - 2800) / 7);
});

test('today’s difference previews later days, but planned future meals never carry', () => {
  const data = dataWith([meal('2026-10-11', 2700), meal(today, 2000), meal('2026-10-14', 1000)]);
  const ledger = calorieLedger(data, [], today);
  assert.equal(ledger.days[today].carryIn, 0);
  assert.equal(ledger.days[today].difference, 700);
  assert.equal(ledger.days[today].settled, false);
  assert.equal(ledger.provisional, ledger.days[today]);
  close(ledger.days['2026-10-14'].carryIn, 100);
  assert.equal(ledger.days['2026-10-14'].settled, false);
  close(carryBefore('2026-10-15', ledger), 100, 'the planned 10-14 meal adds nothing');
  assert.equal(carryBefore('2026-10-20', ledger), 0);
  assert.equal(ledger.completed.length, 1);
});

test('each completed day applies its own saved deficit and burn target', () => {
  const data = dataWith([meal('2026-10-09', 2000), meal('2026-10-10', 2000), meal('2026-10-11', 2000)]);
  data.days['2026-10-09'] = settings(3000, 600);
  data.days['2026-10-10'] = settings(2500, 300);
  data.days['2026-10-11'] = settings(2000, 700);
  const ledger = calorieLedger(data, [], today);
  assert.deepEqual(ledger.completed.map(day => day.baseBudget), [2400, 2200, 1300]);
  closeAll(ledger.completed.map(day => day.difference), [400, 2200 + 400 / 7 - 2000, 1300 + (400 + 200 + 400 / 7) / 7 - 2000]);
});

test('Garmin actual totals settle past days and explicit manual burn overrides still win', () => {
  const data = dataWith([meal('2026-10-09', 2000), meal('2026-10-10', 2000)], settings(3200, 500, 'garmin'));
  data.days['2026-10-10'] = settings(2800, 500, 'manual');
  const ledger = calorieLedger(data, [reading('2026-10-09', 400, 1800), reading('2026-10-10', 900, 1900, 4000)], today);
  assert.equal(ledger.days['2026-10-09'].baseBudget, 1700);
  assert.equal(ledger.days['2026-10-09'].difference, -300);
  assert.equal(ledger.days['2026-10-10'].baseBudget, 2300, 'manual 2800, not Garmin 4000, controls this day');
});

test('today’s Garmin prediction previews later days, then settles the recorded final total', () => {
  const journal = dataWith([meal('2026-10-12', 2500), meal('2026-10-13', 2200)], settings(3200, 500, 'garmin'));
  const yesterday = reading('2026-10-12', 781, 2338, 3119);
  const partialToday = reading('2026-10-13', 10, 23, 33);
  const provisional = calorieLedger(journal, [yesterday, partialToday], '2026-10-13');
  assert.equal(provisional.days['2026-10-12'].difference, 119);
  assert.equal(provisional.days['2026-10-13'].baseBudget, 1848, '10 active plus 2338 yesterday resting minus deficit');
  close(provisional.days['2026-10-13'].rawBudget, 1848 + 17);
  assert.equal(provisional.days['2026-10-13'].settled, false);
  close(carryBefore('2026-10-14', provisional), (119 + 1865 - 2200) / 7);

  const finalToday = reading('2026-10-13', 962, 2488, 3450);
  const settled = calorieLedger(journal, [yesterday, finalToday], '2026-10-14');
  assert.equal(settled.days['2026-10-13'].baseBudget, 2950, 'completed day uses recorded total 3450');
  close(settled.days['2026-10-13'].difference, 2967 - 2200);
  close(carryBefore('2026-10-14', settled), (119 + 767) / 7);
});

test('debt survives a zero-floored budget instead of being forgiven', () => {
  const data = dataWith([meal('2026-10-09', 1500), meal('2026-10-10', 0)], settings(300, 200));
  const ledger = calorieLedger(data, [], today);
  assert.equal(ledger.days['2026-10-09'].difference, -1400);
  const floored = ledger.days['2026-10-10'];
  close(floored.rawBudget, -100);
  assert.equal(floored.budget, 0);
  close(floored.deferredDebt, 100);
  close(floored.difference, -100, 'the unpaid part of the day is spread again');
  close(floored.balance, -1400 * 6 / 7 - 100);
});

test('a logged zero-calorie meal remains a logged day while an empty journal contributes nothing', () => {
  const data = dataWith([meal('2026-10-09', 1000), meal('2026-10-10', 0)], settings(800, 500));
  const ledger = calorieLedger(data, [], today);
  assert.equal(ledger.days['2026-10-09'].difference, -700);
  close(ledger.days['2026-10-10'].difference, 200);
  assert.equal(ledger.completed.length, 2);
  assert.deepEqual(calorieLedger(emptyData(), [reading('2026-10-09', 500, 2000)], today).completed, []);
});

test('editing or deleting past meals recomputes the carry instead of adding another adjustment', () => {
  const data = threeDays();
  const before = carryBefore(today, calorieLedger(data, [], today));
  data.entries = data.entries.map(entry => entry.date === '2026-10-10' ? meal(entry.date, 3100, entry.id) : entry);
  const edited = calorieLedger(data, [], today);
  close(edited.days['2026-10-10'].difference, 2700 + 300 / 7 - 3100);
  assert.ok(carryBefore(today, edited) < before);
  data.entries = data.entries.filter(entry => entry.date !== '2026-10-10');
  const deletedDay = calorieLedger(data, [], today);
  assert.equal(deletedDay.days['2026-10-10'], undefined);
  close(carryBefore(today, deletedDay), (300 + (2700 + 300 / 7 - 2600)) / 7);
});

test('target edits and delayed Garmin corrections recompute the same ledger', () => {
  const data = threeDays();
  data.days['2026-10-09'] = settings(3200, 600);
  assert.equal(calorieLedger(data, [], today).days['2026-10-09'].difference, 200);
  data.days['2026-10-09'] = settings(3200, 500, 'garmin');
  const corrected = calorieLedger(data, [reading('2026-10-09', 800, 2200)], today);
  assert.equal(corrected.days['2026-10-09'].difference, 100);
  assert.deepEqual(corrected, calorieLedger(data, [reading('2026-10-09', 800, 2200)], today));
});

test('ledger derivation leaves the journal and Garmin snapshots unchanged', () => {
  const data = threeDays();
  const garmin = [reading('2026-10-09', 800, 2200), reading(today, 20, 40)];
  const beforeData = structuredClone(data);
  const beforeGarmin = structuredClone(garmin);
  const freeze = value => {
    for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item);
    return Object.freeze(value);
  };
  freeze(data);
  freeze(garmin);
  const first = calorieLedger(data, garmin, today);
  const second = calorieLedger(data, garmin, today);
  assert.deepEqual(first, second);
  assert.deepEqual(data, beforeData);
  assert.deepEqual(garmin, beforeGarmin);
});

test('nonfinite helper inputs are rejected while finite negative carry remains valid', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => adjustedBudget(value, 500, 0));
    assert.throws(() => adjustedBudget(3200, value, 0));
    assert.throws(() => adjustedBudget(3200, 500, value));
  }
  assert.equal(adjustedBudget(3200, 500, -300).budget, 2400);
});

test('invalid base targets and numeric coercion are rejected, including finite-input overflow', () => {
  for (const value of [-1, '3200', null, undefined, true]) {
    assert.throws(() => adjustedBudget(value, 500, 0));
    assert.throws(() => adjustedBudget(3200, value, 0));
  }
  for (const value of ['300', null, true]) assert.throws(() => adjustedBudget(3200, 500, value));
  assert.throws(() => adjustedBudget(Number.MAX_VALUE, 0, Number.MAX_VALUE));
});

test('missing automatic days carry budgets derived from the global completed resting donor', () => {
  const data = dataWith([
    meal('2026-10-09', 1000), meal('2026-10-11', 1600), meal(today, 1000),
  ], settings(3200, 500, 'garmin'));
  const imports = [
    reading('2026-10-06', 600, 1800),
    reading('2026-10-15', 500, 4000),
    reading('2026-10-10', 500, 2200),
    reading(today, 100, 20),
  ];
  const ledger = calorieLedger(data, imports, today);
  assert.equal(ledger.days['2026-10-09'].baseBudget, 1700, 'global donor works even without an exact previous-day record');
  assert.equal(ledger.days['2026-10-09'].difference, 700);
  assert.equal(ledger.days['2026-10-11'].baseBudget, 1700);
  close(ledger.days['2026-10-11'].difference, 200);
  close(ledger.days['2026-10-11'].balance, 200 + 700 * 5 / 7);
  close(carryBefore(today, ledger), 900 / 7);
  assert.equal(ledger.days[today].baseBudget, 0, 'an actual partial today remains actual when exact yesterday is absent');
  close(ledger.days[today].balance, (900 / 7 - 1000) + 200 * 6 / 7 + 700 * 4 / 7);
  assert.equal(ledger.days[today].settled, false);
  for (const [date, row] of Object.entries(ledger.days)) {
    const effective = effectiveBurned(date, data.days[date] ?? data.defaults, imports, today);
    assert.equal(row.baseBudget, adjustedBudget(effective.burned, data.defaults.deficit).baseBudget,
      `ledger and the full-history UI resolver agree for ${date}`);
  }
  assert.equal(ledger.days['2026-10-10'], undefined, 'the donor date has no logged food and earns no credit');
});

test('unknown automatic burn creates neither credit nor debt before completed Garmin data exists', () => {
  const data = dataWith([meal('2026-10-09', 1000), meal('2026-10-11', 500)], settings(3200, 500, 'garmin'));
  const imports = [reading(today, 100, 20), reading('2026-10-15', 400, 2000)];
  const ledger = calorieLedger(data, imports, today);
  assert.deepEqual(ledger.completed, []);
  assert.equal(carryBefore(today, ledger), 0);
  assert.equal(ledger.days['2026-10-11'].carryIn, 0, 'unknown prior intake is not carried into another row');
  assert.equal(ledger.days['2026-10-11'].balance, -500);
  for (const row of Object.values(ledger.days)) {
    assert.equal(row.baseBudget, 0);
    assert.equal(row.available, false);
    assert.equal(row.settled, false);
  }
});

test('a zero resting fallback remains valid in the ledger and keeps its debt', () => {
  const data = dataWith([meal('2026-10-09', 1000)], settings(3200, 500, 'garmin'));
  const imports = [reading('2026-10-08', 700, 2000), reading('2026-10-10', 600, 0)];
  const ledger = calorieLedger(data, imports, today);
  assert.equal(ledger.days['2026-10-09'].baseBudget, 0);
  assert.equal(ledger.days['2026-10-09'].available, true);
  assert.equal(ledger.days['2026-10-09'].settled, true);
  assert.equal(ledger.days['2026-10-09'].difference, -1000);
  close(carryBefore(today, ledger), -1000 / 7);
});

test('later Garmin imports settle formerly unknown days exactly once on recomputation', () => {
  const data = dataWith([meal('2026-10-09', 1000), meal('2026-10-11', 500)], settings(3200, 500, 'garmin'));
  const waiting = calorieLedger(data, [], today);
  assert.deepEqual(waiting.completed, []);
  assert.equal(carryBefore(today, waiting), 0);
  const imports = [reading('2026-10-11', 500, 1900), reading('2026-10-09', 300, 1700)];
  const loaded = calorieLedger(data, imports, today);
  assert.deepEqual(loaded.completed.map(row => row.date), ['2026-10-09', '2026-10-11']);
  closeAll(loaded.completed.map(row => row.difference), [500, 1900 + 500 / 7 - 500]);
  assert.ok(loaded.completed.every(row => row.available && row.settled));
  close(carryBefore(today, loaded), (500 + 1400 + 500 / 7) / 7);
  assert.deepEqual(calorieLedger(data, imports, today), loaded, 'the waiting placeholders never become extra adjustment entries');
});

test('explicit manual zero and an imported Garmin zero are available completed burn amounts', () => {
  for (const source of ['manual', 'garmin']) {
    const data = dataWith([meal('2026-10-09', 250)], settings(0, 500, source));
    const imports = source === 'garmin' ? [reading('2026-10-09', 0, 0)] : [];
    const ledger = calorieLedger(data, imports, today);
    const row = ledger.days['2026-10-09'];
    assert.equal(row.baseBudget, 0);
    assert.equal(row.available, true);
    assert.equal(row.settled, true);
    assert.equal(row.balance, -250);
    assert.equal(ledger.completed.length, 1);
    close(carryBefore(today, ledger), -250 / 7);
  }
});

test('the difference spread over seven days is conserved exactly', () => {
  const dates = range('2026-10-01', 20);
  const over = [900, -300, 0, 450, -1200, 0, 0, 300];
  const ledger = eatAgainstBudget(dates, over, kai, '2026-10-30');
  const rows = dates.map(date => ledger.days[date]);
  const totalDifference = rows.reduce((sum, row) => sum + row.difference, 0);
  const totalCarry = rows.reduce((sum, row) => sum + row.carryIn, 0);
  close(totalCarry, totalDifference, 'every kcal over or under comes back once, no more, no less');
  close(rows.at(-1).balance, 0);
  close(outstandingAfter('2026-10-08', ledger, rows[7].difference), rows[7].balance);
});
