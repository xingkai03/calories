import { emptyData, normalizeData, type BankPortion, type DaySettings, type Entry, type Food, type TrackerData } from './model.ts';
import { bankItemFromEntry, consumeFoodBankPortion, isBankWeightEntry, removeJournalEntry } from './food-bank.ts';
import { journalEqual } from './offline.ts';

export type UndoKind = 'delete-entry' | 'delete-food' | 'delete-bank' | 'consume-bank';
interface UndoBase { version: 1; id: string; recordId: string; index: number }
export type UndoAction =
  /** batch is the food-bank batch an entry eaten by weight went back into, as it was before (null if it was used up). */
  | (UndoBase & { kind: 'delete-entry'; record: Entry; batch?: BankPortion | null })
  | (UndoBase & { kind: 'delete-food'; record: Food })
  | (UndoBase & { kind: 'delete-bank'; record: BankPortion })
  | (UndoBase & { kind: 'consume-bank'; record: BankPortion; entries: Entry[]; date: string; createdDay?: DaySettings });

export class UndoConflictError extends Error {
  constructor() {
    super('This action can no longer be undone safely because the affected records changed. Your current journal has been kept.');
    this.name = 'UndoConflictError';
  }
}
const invalid = () => new Error('This change does not contain a valid Undo action.');
function validId(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= 200; }
function identity(): string { return globalThis.crypto?.randomUUID?.() ?? `undo-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function insert<T>(rows: readonly T[], record: T, index: number): T[] {
  const result = [...rows]; result.splice(Math.min(index, result.length), 0, record); return result;
}

/** Capture only the inverse's records. Unrelated journal data never enters a receipt. */
export function createUndoAction(beforeRaw: TrackerData, afterRaw: TrackerData, kind: UndoKind, recordId: string, makeId: () => string = identity): UndoAction {
  const before = normalizeData(beforeRaw), after = normalizeData(afterRaw);
  if (!validId(recordId) || typeof makeId !== 'function') throw invalid();
  const id = makeId();
  if (!validId(id)) throw invalid();
  const base: UndoBase = { version: 1, id, recordId, index: 0 };
  let receipt: UndoAction, expected: TrackerData;
  if (kind === 'delete-entry') {
    const index = before.entries.findIndex(entry => entry.id === recordId), record = before.entries[index];
    if (!record) throw invalid();
    const batch = isBankWeightEntry(record) ? before.foodBank.find(portion => portion.id === record.bankPortion!.id) ?? null : undefined;
    receipt = { ...base, kind, index, record, ...(batch !== undefined ? { batch } : {}) };
    expected = removeJournalEntry(before, recordId);
  } else if (kind === 'delete-food') {
    const index = before.foods.findIndex(food => food.id === recordId), record = before.foods[index];
    if (!record) throw invalid();
    receipt = { ...base, kind, index, record };
    expected = { ...before, foods: before.foods.filter(food => food.id !== recordId) };
  } else if (kind === 'delete-bank' || kind === 'consume-bank') {
    const index = before.foodBank.findIndex(portion => portion.id === recordId), record = before.foodBank[index];
    if (!record) throw invalid();
    if (kind === 'delete-bank') {
      receipt = { ...base, kind, index, record };
      expected = { ...before, foodBank: before.foodBank.filter(portion => portion.id !== recordId) };
    } else {
      const itemIds = new Set(record.items.map(item => item.id)), beforeIds = new Set(before.entries.map(entry => entry.id));
      // A batch kept by weight logs one new entry; a portion logs its own ingredient IDs.
      const entries = record.weight ? after.entries.filter(entry => !beforeIds.has(entry.id) && entry.bankPortion?.id === recordId) : after.entries.filter(entry => itemIds.has(entry.id));
      if (entries.length !== (record.weight ? 1 : record.items.length)) throw invalid();
      const { date, meal } = entries[0];
      expected = consumeFoodBankPortion(before, recordId, date, meal, amountOf(record, entries));
      receipt = { ...base, kind, index, record, entries, date, ...(!Object.hasOwn(before.days, date) ? { createdDay: expected.days[date] } : {}) };
    }
  } else throw invalid();
  if (!journalEqual(expected, after)) throw invalid();
  return receipt;
}

const amountOf = (record: BankPortion, entries: readonly Entry[]) => record.weight ? { grams: entries[0].quantity, entryId: entries[0].id } : undefined;

function normalizeReceipt(raw: UndoAction): UndoAction {
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !validId(raw.id) || !validId(raw.recordId) || !Number.isInteger(raw.index) || raw.index < 0 || raw.index > 100000) throw invalid();
  const base: UndoBase = { version: 1, id: raw.id, recordId: raw.recordId, index: raw.index };
  let receipt: UndoAction;
  if (raw.kind === 'delete-entry') {
    const record = normalizeData({ ...emptyData(), entries: [raw.record] }).entries[0];
    if (raw.batch !== undefined && (!isBankWeightEntry(record) || (raw.batch !== null && raw.batch.id !== record.bankPortion!.id))) throw invalid();
    const batch = raw.batch === undefined || raw.batch === null ? raw.batch : normalizeData({ ...emptyData(), foodBank: [raw.batch] }).foodBank[0];
    receipt = { ...base, kind: raw.kind, record, ...(batch !== undefined ? { batch } : {}) };
  } else if (raw.kind === 'delete-food') {
    receipt = { ...base, kind: raw.kind, record: normalizeData({ ...emptyData(), foods: [raw.record] }).foods[0] };
  } else if (raw.kind === 'delete-bank' || raw.kind === 'consume-bank') {
    const record = normalizeData({ ...emptyData(), foodBank: [raw.record] }).foodBank[0];
    if (raw.kind === 'delete-bank') receipt = { ...base, kind: raw.kind, record };
    else {
      const normalized = normalizeData({ ...emptyData(), entries: raw.entries, days: raw.createdDay === undefined ? {} : { [raw.date]: raw.createdDay } });
      if (normalized.entries.length !== (record.weight ? 1 : record.items.length) || !normalized.entries.length || normalized.entries[0].date !== raw.date) throw invalid();
      const expected = consumeFoodBankPortion({ ...emptyData(), foodBank: [record] }, record.id, raw.date, normalized.entries[0].meal, amountOf(record, normalized.entries));
      if (!journalEqual(expected.entries, normalized.entries)) throw invalid();
      receipt = { ...base, kind: raw.kind, record, entries: normalized.entries, date: raw.date, ...(raw.createdDay !== undefined ? { createdDay: normalized.days[raw.date] } : {}) };
    }
  } else throw invalid();
  if (receipt.record.id !== receipt.recordId) throw invalid();
  return receipt;
}

/** Reverse only unchanged affected records; normalize a fresh result so failures are atomic. */
export function undoAction(currentRaw: TrackerData, rawReceipt: UndoAction): TrackerData {
  const current = normalizeData(currentRaw), receipt = normalizeReceipt(rawReceipt);
  if (receipt.kind === 'delete-entry') {
    const existing = current.entries.find(entry => entry.id === receipt.recordId);
    if (existing) { if (journalEqual(existing, receipt.record)) return current; throw new UndoConflictError(); }
    if (receipt.batch !== undefined) {
      // The grams went back into their batch. Undo puts the batch back as it was, if it is still as the removal left it.
      const batchId = receipt.record.bankPortion!.id;
      const returned = removeJournalEntry({ ...emptyData(), entries: [receipt.record], foodBank: receipt.batch ? [receipt.batch] : [] }, receipt.recordId).foodBank[0];
      const now = current.foodBank.find(portion => portion.id === batchId);
      if (!journalEqual(now, returned)) throw new UndoConflictError();
      const foodBank = receipt.batch ? current.foodBank.map(portion => portion === now ? receipt.batch! : portion) : current.foodBank.filter(portion => portion !== now);
      return normalizeData({ ...current, foodBank, entries: insert(current.entries, receipt.record, receipt.index) });
    }
    const holder = current.foodBank.find(portion => portion.items.some(item => item.id === receipt.recordId));
    let foodBank = current.foodBank;
    if (holder) {
      // Removing an entry eaten from the bank put it back there; Undo takes it out again if it is still unchanged.
      const returned = holder.items.find(item => item.id === receipt.recordId);
      if (holder.id !== receipt.record.bankPortion?.id || !journalEqual(returned, bankItemFromEntry(receipt.record))) throw new UndoConflictError();
      const items = holder.items.filter(item => item.id !== receipt.recordId);
      foodBank = items.length ? current.foodBank.map(portion => portion === holder ? { ...portion, items } : portion) : current.foodBank.filter(portion => portion !== holder);
    }
    return normalizeData({ ...current, foodBank, entries: insert(current.entries, receipt.record, receipt.index) });
  }
  if (receipt.kind === 'delete-food') {
    const existing = current.foods.find(food => food.id === receipt.recordId);
    if (existing) { if (journalEqual(existing, receipt.record)) return current; throw new UndoConflictError(); }
    return normalizeData({ ...current, foods: insert(current.foods, receipt.record, receipt.index) });
  }
  const existing = current.foodBank.find(portion => portion.id === receipt.recordId);
  if (receipt.kind === 'consume-bank' && receipt.record.weight) {
    // Eating some of a batch left the rest in the bank (or used it up). Undo puts the grams back, if nothing else changed.
    const entry = receipt.entries[0];
    const logged = current.entries.find(item => item.id === entry.id);
    if (!logged && journalEqual(existing, receipt.record)) return current;
    const left = consumeFoodBankPortion({ ...emptyData(), foodBank: [receipt.record] }, receipt.record.id, receipt.date, entry.meal, amountOf(receipt.record, receipt.entries)).foodBank[0];
    if (!journalEqual(logged, entry) || !journalEqual(existing, left)) throw new UndoConflictError();
    const foodBank = existing ? current.foodBank.map(portion => portion === existing ? receipt.record : portion) : insert(current.foodBank, receipt.record, receipt.index);
    return normalizeData({ ...current, entries: current.entries.filter(item => item.id !== entry.id), foodBank });
  }
  if (existing) { if (journalEqual(existing, receipt.record)) return current; throw new UndoConflictError(); }
  const ids = new Set(receipt.record.items.map(item => item.id));
  if (current.foodBank.some(portion => portion.items.some(item => ids.has(item.id)))) throw new UndoConflictError();
  if (receipt.kind === 'delete-bank') {
    if (current.entries.some(entry => ids.has(entry.id))) throw new UndoConflictError();
    return normalizeData({ ...current, foodBank: insert(current.foodBank, receipt.record, receipt.index) });
  }
  const entriesById = new Map(current.entries.map(entry => [entry.id, entry]));
  if (receipt.entries.some(entry => !journalEqual(entriesById.get(entry.id), entry))) throw new UndoConflictError();
  const entries = current.entries.filter(entry => !ids.has(entry.id));
  // A remote meal on this date may not have arrived yet. Keeping its frozen targets
  // avoids reverting that meal to legacy defaults during a later three-way merge.
  return normalizeData({ ...current, entries, foodBank: insert(current.foodBank, receipt.record, receipt.index) });
}
