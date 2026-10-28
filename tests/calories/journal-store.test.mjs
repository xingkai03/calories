import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createClient } from '../../src/lib/calories/client.ts';
import { emptyData, manualMealEntry } from '../../src/lib/calories/model.ts';
import { indexedJournalStore, storageJournalStore } from '../../src/lib/calories/journal-store.ts';
import { journalCacheKey } from '../../src/lib/calories/offline.ts';

const url = 'https://store-example.supabase.co', key = 'sb_publishable_store_test_example_key';
const owner = 'd5640279-d78c-4537-a5d8-a31c3b0be53e';
class MemoryStorage {
  values = new Map();
  failOn = null;
  getItem(name) { return this.values.get(name) ?? null; }
  setItem(name, value) { if (name === this.failOn) throw new Error('quota'); this.values.set(name, String(value)); }
  removeItem(name) { this.values.delete(name); }
}
const meal = id => manualMealEntry({ id, date: '2026-10-16', meal: 'Lunch', name: `Meal ${id}`, protein: 20, carbs: 30, fat: 5, fiber: 2 });
const reading = (date, synced_at, active = 400) => ({ date, active, resting: 2000, total: active + 2000, synced_at });

function cloud(initial = emptyData()) {
  const state = { data: structuredClone(initial), revision: 1, calls: [], garminDays: [reading('2026-10-14', '2026-10-15T10:00:00Z'), reading('2026-10-15', '2026-10-16T10:00:00Z')] };
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (address, init = {}) => {
    const endpoint = new URL(address), method = init.method ?? 'GET';
    state.calls.push({ path: endpoint.pathname, method, search: endpoint.searchParams });
    if (endpoint.pathname === '/auth/v1/token') return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: owner, email: 'owner@example.com' } });
    if (endpoint.pathname === '/rest/v1/rpc/calories_access_allowed') return json(true);
    if (endpoint.pathname === '/rest/v1/calories_garmin_days') {
      const since = endpoint.searchParams.get('synced_at');
      return json(since ? state.garminDays.filter(day => day.synced_at >= since.slice(4)) : state.garminDays);
    }
    if (endpoint.pathname === '/rest/v1/calories_garmin_status') return json([{ state: 'connected', last_attempt_at: null, last_sync_at: null, last_error_code: null }]);
    if (method === 'GET') return json([endpoint.searchParams.get('select') === 'revision' ? { revision: state.revision } : { data: state.data, revision: state.revision }]);
    if (endpoint.searchParams.get('revision') !== `eq.${state.revision}`) return json([]);
    state.data = JSON.parse(init.body).data; state.revision++;
    return json([{ revision: state.revision }]);
  };
  return { state, fetch };
}
function device(server, store, localStorage = new MemoryStorage()) {
  return createClient({ url, key, localStorage, sessionStorage: new MemoryStorage(), journalStore: store, fetch: server.fetch, now: () => Date.UTC(2026, 9, 16, 12) });
}
const journalReads = server => server.state.calls.filter(call => call.path === '/rest/v1/calories_state' && call.method === 'GET' && call.search.get('select') !== 'revision').length;

test('a Web Storage store leaves the first key intact and the rest missing when a write fails', async () => {
  const storage = new MemoryStorage(), store = storageJournalStore(storage);
  await store.set([['journal', { v: 1 }], ['journal#version', 'v1']]);
  storage.failOn = 'journal';
  await assert.rejects(store.set([['journal', { v: 2 }], ['journal#version', 'v2']]), /quota/);
  assert.deepEqual(await store.get('journal'), { v: 1 });
  assert.equal(await store.get('journal#version'), undefined);
  storage.failOn = 'journal#version';
  await assert.rejects(store.set([['journal', { v: 3 }], ['journal#version', 'v3']]), /quota/);
  assert.deepEqual(await store.get('journal'), { v: 3 });
  assert.equal(await store.get('journal#version'), undefined);
});

test('IndexedDB reads an older localStorage copy until its next write moves it', async () => {
  const legacy = new MemoryStorage();
  legacy.setItem('journal', JSON.stringify({ v: 'legacy' }));
  const store = indexedJournalStore(new IDBFactory(), legacy);
  assert.deepEqual(await store.get('journal'), { v: 'legacy' });
  await store.set([['journal', { v: 'indexed' }], ['journal#version', 'v1']]);
  assert.equal(legacy.getItem('journal'), null, 'the moved copy frees localStorage space');
  assert.deepEqual(await store.get('journal'), { v: 'indexed' });
  await store.remove(['journal', 'journal#version']);
  assert.equal(await store.get('journal'), undefined);
});

test('IndexedDB that refuses to open falls back to localStorage', async () => {
  const legacy = new MemoryStorage();
  const refusing = { open() { throw new Error('private window'); } };
  const store = indexedJournalStore(refusing, legacy);
  await store.set([['journal', { v: 1 }]]);
  assert.deepEqual(JSON.parse(legacy.getItem('journal')), { v: 1 });
  assert.deepEqual(await store.get('journal'), { v: 1 });
});

test('the journal lives in IndexedDB, and another tab sees each newer version', async () => {
  const server = cloud(), factory = new IDBFactory(), localStorage = new MemoryStorage();
  const tab = device(server, indexedJournalStore(factory, localStorage), localStorage);
  await tab.signIn('owner@example.com', 'password', true);
  const opened = await tab.openJournal();
  await tab.stageJournal({ ...opened.data, entries: [meal('one')] }, opened.localVersion);
  assert.equal(localStorage.getItem(journalCacheKey(url, owner)), null, 'the large journal stays out of localStorage');
  const other = device(server, indexedJournalStore(factory, localStorage), localStorage);
  assert.deepEqual((await other.getJournalSnapshot()).data.entries, [meal('one')]);
  const seen = await other.getJournalSnapshot();
  await other.stageJournal({ ...seen.data, entries: [...seen.data.entries, meal('two')] }, seen.localVersion);
  assert.deepEqual((await tab.getJournalSnapshot()).data.entries.map(entry => entry.id), ['one', 'two']);
  assert.equal((await tab.syncJournal()).pending, false);
  assert.deepEqual(server.state.data.entries.map(entry => entry.id), ['one', 'two']);
});

test('saves write first, and a sync with nothing pending checks only the revision', async () => {
  const server = cloud();
  const client = device(server, storageJournalStore(new MemoryStorage()));
  await client.signIn('owner@example.com', 'password', true);
  const opened = await client.openJournal();
  assert.equal(journalReads(server), 1);
  await client.stageJournal({ ...opened.data, entries: [meal('one')] }, opened.localVersion);
  const saved = await client.syncJournal();
  assert.equal(saved.pending, false);
  assert.equal(journalReads(server), 1, 'the save did not download the journal first');
  assert.equal(server.state.revision, 2);
  const refreshed = await client.syncJournal();
  assert.equal(journalReads(server), 1, 'an unchanged journal is not downloaded again');
  assert.equal(refreshed.localVersion, saved.localVersion, 'an unchanged copy is not rewritten');
  // Another device saves: the revision check notices and downloads the newer journal.
  server.state.data = { ...server.state.data, entries: [...server.state.data.entries, meal('remote')] }; server.state.revision++;
  assert.deepEqual((await client.syncJournal()).data.entries.map(entry => entry.id), ['one', 'remote']);
  assert.equal(journalReads(server), 2);
});

test('a write-first save that another device beat reads, merges and saves both changes', async () => {
  const server = cloud();
  const client = device(server, storageJournalStore(new MemoryStorage()));
  await client.signIn('owner@example.com', 'password', true);
  const opened = await client.openJournal();
  server.state.data = { ...server.state.data, entries: [meal('remote')] }; server.state.revision++;
  await client.stageJournal({ ...opened.data, entries: [meal('local')] }, opened.localVersion);
  const synced = await client.syncJournal();
  assert.equal(synced.pending, false);
  assert.deepEqual(new Set(server.state.data.entries.map(entry => entry.id)), new Set(['local', 'remote']));
  assert.equal(server.state.revision, 3);
});

test('background Garmin checks fetch only newly imported days and merge them', async () => {
  const server = cloud();
  const client = device(server, storageJournalStore(new MemoryStorage()));
  await client.signIn('owner@example.com', 'password', true);
  await client.openJournal();
  assert.equal((await client.loadGarmin()).days.length, 2);
  server.state.garminDays = [server.state.garminDays[0], reading('2026-10-15', '2026-10-16T11:00:00Z', 900), reading('2026-10-16', '2026-10-16T11:00:00Z', 100)];
  const latest = await client.loadGarmin({ changedOnly: true });
  const request = server.state.calls.filter(call => call.path === '/rest/v1/calories_garmin_days').at(-1);
  assert.equal(request.search.get('synced_at'), 'gte.2026-10-16T10:00:00Z');
  assert.deepEqual(latest.days.map(day => [day.date, day.active]).sort(), [['2026-10-14', 400], ['2026-10-15', 900], ['2026-10-16', 100]]);
});
