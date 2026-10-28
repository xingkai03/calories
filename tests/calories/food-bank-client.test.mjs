import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../../src/lib/calories/client.ts';
import { emptyData, energyFromMacros, manualMealEntry } from '../../src/lib/calories/model.ts';
import { prepareFoodBankPortions } from '../../src/lib/calories/food-bank.ts';

const URL = 'https://food-bank-client-test.supabase.co';
const KEY = 'sb_publishable_food_bank_test_key';
const OWNER = 'd5640279-d78c-4537-a5d8-a31c3b0be53e';
const NOW = Date.UTC(2026, 9, 15, 12);
const json = value => Response.json(value);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function fixture() {
  const data = emptyData();
  data.defaults = { burned: 3200, deficit: 500, protein: 175, burnedSource: 'manual' };
  data.foods = [
    { id: 'rice', name: 'Cooked rice', baseQuantity: 100, unit: 'g', state: 'Cooked', protein: 2.5, carbs: 28, fat: 0.3, fiber: 0.4 },
    { id: 'eggs', name: 'Egg', baseQuantity: 1, unit: 'piece', state: 'As served', protein: 6.3, carbs: 0.4, fat: 5.3, fiber: 0 },
  ].map(food => ({ ...food, calories: energyFromMacros(food) }));
  const historical = manualMealEntry({
    id: 'existing-meal', date: '2026-10-14', meal: 'Dinner', name: 'Existing dinner',
    protein: 20, carbs: 40, fat: 10, fiber: 5,
  });
  historical.calories = 331.125;
  data.entries = [historical];
  data.days['2026-10-14'] = { burned: 3000, deficit: 450, protein: 175, burnedSource: 'manual' };
  let id = 0;
  data.foodBank = prepareFoodBankPortions(data.foods, [
    { foodId: 'rice', quantity: 150 }, { foodId: 'eggs', quantity: 2 },
  ], 2, 'Rice and eggs', () => `stored-portion-id-${++id}`);
  return data;
}

/** Models the single-row conditional PATCH: one revision match updates the whole document. */
function server(initialData, { loseNextWriteResponse = false } = {}) {
  const state = { data: structuredClone(initialData), revision: 7, calls: [], writes: [] };
  const fetch = async (address, init = {}) => {
    const url = new globalThis.URL(address);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ url, method, body });
    assert.equal(url.origin, URL);
    assert.equal(headers.get('apikey'), KEY);
    if (url.pathname === '/auth/v1/token') {
      assert.equal(url.searchParams.get('grant_type'), 'password');
      return json({ access_token: 'access-bank-test', refresh_token: 'refresh-bank-test', expires_in: 3600, user: { id: OWNER, email: 'owner@example.test' } });
    }
    assert.equal(headers.get('authorization'), 'Bearer access-bank-test');
    if (url.pathname === '/rest/v1/rpc/calories_access_allowed') {
      assert.equal(method, 'POST');
      return json(true);
    }
    assert.equal(url.pathname, '/rest/v1/calories_state');
    assert.equal(url.searchParams.get('user_id'), `eq.${OWNER}`);
    if (method === 'GET') return json([{ data: structuredClone(state.data), revision: state.revision }]);
    assert.equal(method, 'PATCH');
    assert.equal(headers.get('prefer'), 'return=representation');
    assert.deepEqual(Object.keys(body), ['data'], 'the browser writes one whole data document, not revisions or separate bank/entry updates');
    const expected = url.searchParams.get('revision');
    assert.match(expected, /^eq\.\d+$/);
    if (expected !== `eq.${state.revision}`) return json([]);
    const before = structuredClone(state.data);
    state.data = structuredClone(body.data);
    state.revision++;
    state.writes.push({ before, after: structuredClone(state.data), revision: state.revision });
    if (loseNextWriteResponse) {
      loseNextWriteResponse = false;
      throw new Error('The server committed the write but the response was lost.');
    }
    return json([{ revision: state.revision }]);
  };
  const client = () => createClient({
    url: URL, key: KEY, fetch, now: () => NOW,
    localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage(),
  });
  return { state, client };
}

async function signedIn(cloud) {
  const client = cloud.client();
  await client.signIn('owner@example.test', 'test-password', false);
  return client;
}

test('loading a legacy v1 journal migrates it in memory without writing or losing recorded snapshots', async () => {
  const original = fixture();
  const { foodBank: _bank, ...withoutBank } = original;
  const legacy = { ...withoutBank, version: 1 };
  const cloud = server(legacy);
  const client = await signedIn(cloud);
  const opened = await client.openJournal();
  const loaded = opened.data;
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.foodBank, []);
  for (const field of ['foods', 'entries', 'days', 'defaults']) assert.deepEqual(loaded[field], legacy[field]);
  assert.equal(loaded.entries[0].calories, 331.125, 'historical energy is not recalculated during the format migration');
  assert.equal(cloud.state.data.version, 1, 'loading alone does not rewrite the server document');
  assert.equal(cloud.state.revision, 7);
  assert.equal(cloud.state.writes.length, 0);

  await client.stageJournal({ ...loaded, foodBank: structuredClone(original.foodBank) }, opened.localVersion);
  assert.equal((await client.syncJournal()).pending, false);
  assert.equal(cloud.state.data.version, 2);
  assert.deepEqual(cloud.state.data.foodBank, original.foodBank);
  assert.deepEqual(cloud.state.data.entries, legacy.entries);
  assert.equal(cloud.state.revision, 8);
  assert.equal(cloud.state.writes.length, 1);
});

test('a v2 bank survives whole-document saving and loading on another device', async () => {
  const initial = fixture();
  const cloud = server(initial);
  const first = await signedIn(cloud);
  const opened = await first.openJournal();
  const edited = structuredClone(opened.data);
  edited.foodBank[0].name = 'Lunch for tomorrow';
  await first.stageJournal(edited, opened.localVersion);
  const saved = await first.syncJournal();
  assert.equal(saved.pending, false);
  const second = await signedIn(cloud);
  const restored = (await second.openJournal()).data;
  assert.deepEqual(restored, saved.data);
  assert.equal(restored.foodBank[0].name, 'Lunch for tomorrow');
  assert.deepEqual(restored.entries, initial.entries, 'preparing and saving food does not count it as eaten');
  assert.equal(restored.foodBank[0].items.length, 2);
  assert.equal(restored.foodBank[0].items[0].unit, 'g');
  assert.equal(restored.foodBank[0].items[1].unit, 'piece');
});

test('an unknown-format journal is never opened or overwritten', async () => {
  const cloud = server({ ...fixture(), version: 3 });
  const client = await signedIn(cloud);
  await assert.rejects(client.openJournal(), /supported Calories backup/);
  await assert.rejects(client.stageJournal(emptyData()), /Open your journal/);
  assert.equal(cloud.state.writes.length, 0);
  assert.equal(cloud.state.data.version, 3);
});
