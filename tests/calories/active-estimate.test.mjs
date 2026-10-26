import test from 'node:test';
import assert from 'node:assert/strict';
import { calorieLedger } from '../../src/lib/calories/budget.ts';
import { effectiveBurned } from '../../src/lib/calories/garmin.ts';
import { emptyData, manualMealEntry, normalizeData } from '../../src/lib/calories/model.ts';

const YESTERDAY = '2026-10-15', TODAY = '2026-10-16', TOMORROW = '2026-10-17';
const settings = (extra = {}) => ({ burned: 0, burnedSource: 'garmin', deficit: 500, protein: 175, ...extra });
const reading = (date, active, resting, total = active + resting) => ({ date, active, resting, total, synced_at: `${date}T12:00:00Z` });
const meal = (date, calories) => manualMealEntry({ id: date, date, meal: 'Lunch', name: 'Recorded meal', protein: calories / 4, carbs: 0, fat: 0, fiber: 0 });
const garmin = [reading(YESTERDAY, 560, 2440), reading(TODAY, 120, 900)];

test('without an estimate today keeps using Garmin active so far', () => {
  const result = effectiveBurned(TODAY, settings(), garmin, TODAY);
  assert.equal(result.burned, 120 + 2440);
  assert.equal(result.activeEstimate, undefined);
});

test('today’s active estimate replaces Garmin active so far, plus yesterday’s resting', () => {
  const result = effectiveBurned(TODAY, settings({ activeEstimate: 800 }), garmin, TODAY);
  assert.equal(result.burned, 800 + 2440);
  assert.equal(result.activeEstimate, 800);
  assert.equal(result.predicted, true);
  assert.equal(result.restingDay.date, YESTERDAY);
});

test('Garmin wins once it already counts more active calories than the estimate', () => {
  const result = effectiveBurned(TODAY, settings({ activeEstimate: 100 }), garmin, TODAY);
  assert.equal(result.burned, 120 + 2440);
});

test('the estimate works before today’s first import, using the latest full-day resting reading', () => {
  const result = effectiveBurned(TODAY, settings({ activeEstimate: 800 }), [reading('2026-10-13', 400, 2300)], TODAY);
  assert.equal(result.burned, 800 + 2300);
  assert.equal(result.restingEstimate, false);
});

test('the estimate is ignored without any completed resting reading', () => {
  const result = effectiveBurned(TODAY, settings({ activeEstimate: 800 }), [reading(TODAY, 120, 900)], TODAY);
  assert.equal(result.burned, 1020);
  assert.equal(result.activeEstimate, undefined);
});

test('once the day ends the actual Garmin reading replaces the estimate', () => {
  const result = effectiveBurned(TODAY, settings({ activeEstimate: 800 }), [...garmin.slice(0, 1), reading(TODAY, 650, 2400)], TOMORROW);
  assert.equal(result.burned, 3050);
  assert.equal(result.activeEstimate, undefined);
});

test('manual overrides ignore the estimate', () => {
  assert.equal(effectiveBurned(TODAY, settings({ burned: 2000, burnedSource: 'manual', activeEstimate: 800 }), garmin, TODAY).burned, 2000);
});

test('the ledger uses the estimate for today and the actual reading after the day ends', () => {
  const data = { ...emptyData(), entries: [meal(TODAY, 2000)], days: { [TODAY]: settings({ activeEstimate: 800 }) } };
  assert.equal(calorieLedger(data, garmin, TODAY).provisional.baseBudget, 800 + 2440 - 500);
  const settled = calorieLedger(data, [garmin[0], reading(TODAY, 650, 2400)], TOMORROW).days[TODAY];
  assert.equal(settled.baseBudget, 650 + 2400 - 500);
  assert.equal(settled.settled, true);
});

test('the estimate round-trips through backups and is validated', () => {
  const data = { ...emptyData(), days: { [TODAY]: settings({ activeEstimate: 800 }) } };
  assert.equal(normalizeData(JSON.parse(JSON.stringify(data))).days[TODAY].activeEstimate, 800);
  assert.equal('activeEstimate' in normalizeData({ ...emptyData(), days: { [TODAY]: settings() } }).days[TODAY], false);
  assert.throws(() => normalizeData({ ...data, days: { [TODAY]: settings({ activeEstimate: -1 }) } }), /active calories estimate/);
});
