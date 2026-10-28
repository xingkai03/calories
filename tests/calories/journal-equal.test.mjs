import test from 'node:test';
import assert from 'node:assert/strict';
import { journalEqual } from '../../src/lib/calories/offline.ts';
import { addDays, isCalendarDate, normalizeData } from '../../src/lib/calories/model.ts';

test('journal equality ignores key order and the order of ID records, but not real edits', () => {
  const a = { id: 'a', name: 'Rice', calories: 117 }, b = { id: 'b', name: 'Oats', calories: 380 };
  assert.equal(journalEqual({ foods: [a, b], version: 2 }, { version: 2, foods: [{ ...b }, { calories: 117, name: 'Rice', id: 'a' }] }), true);
  assert.equal(journalEqual({ foods: [a, b] }, { foods: [a, { ...b, calories: 381 }] }), false);
  assert.equal(journalEqual({ foods: [a, b] }, { foods: [a] }), false);
  // Plain lists keep their order; missing and undefined fields differ, as in the stored JSON comparison.
  assert.equal(journalEqual([1, 2], [2, 1]), false);
  assert.equal(journalEqual({ x: undefined }, {}), false);
  assert.equal(journalEqual({ x: undefined }, { x: undefined }), true);
  assert.equal(journalEqual(undefined, undefined), true);
  assert.equal(journalEqual(undefined, null), false);
  assert.equal(journalEqual([], {}), false);
  assert.equal(journalEqual('1', 1), false);
  // Records sharing an ID keep their relative order.
  assert.equal(journalEqual([{ id: 'x', v: 1 }, { id: 'x', v: 2 }], [{ id: 'x', v: 2 }, { id: 'x', v: 1 }]), false);
  assert.equal(journalEqual([{ id: 'x', v: 1 }, { id: 'y' }, { id: 'x', v: 2 }], [{ id: 'y' }, { id: 'x', v: 1 }, { id: 'x', v: 2 }]), true);
});

test('calendar dates are checked without date parsing, including leap years', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-12-31', '0000-01-01', '9999-12-31']) assert.equal(isCalendarDate(date), true, date);
  for (const date of ['2026-02-29', '1900-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-01', '2026-01-01T00:00']) assert.equal(isCalendarDate(date), false, date);
  assert.throws(() => normalizeData({ version: 2, foods: [], entries: [], foodBank: [], days: { '2026-02-30': { burned: 0, deficit: 0, protein: 0 } }, defaults: { burned: 0, deficit: 0, protein: 0 } }), /Invalid date/);
});

test('addDays crosses months, years and leap days', () => {
  assert.equal(addDays('2026-10-28', 4), '2026-11-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2025-02-28', 1), '2025-03-01');
  assert.equal(addDays('2026-10-28', -365), '2025-10-28');
  assert.equal(addDays('0001-01-01', -1), '0000-12-31');
  assert.equal(addDays('2026-03-29', 0), '2026-03-29');
});
