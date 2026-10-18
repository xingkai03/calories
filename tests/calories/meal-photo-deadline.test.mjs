import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../../src/lib/calories/client.ts';
import { MEAL_PHOTO_REQUEST_TIMEOUT_MS, withMealPhotoDeadline } from '../../src/lib/calories/meal-photo-deadline.ts';

const photo = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS4kAAAAASUVORK5CYII=' };
const input = { photo, description: 'One plate of chicken and rice' };
const draft = { name: 'Chicken and rice', protein: 45, carbs: 65, fat: 18, fiber: 5, notes: [] };
const timeoutError = error => error instanceof Error && /timed out|too long/i.test(error.message);

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

function harness(handle) {
  const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  };
  const calls = [];
  const clock = { now: Date.UTC(2026, 9, 18) };
  const auth = () => Response.json({ access_token: 'owner-token', refresh_token: 'owner-refresh', expires_in: 3600, user: { id: 'owner', email: 'owner@example.test' } });
  const client = createClient({
    url: 'https://example.supabase.co', key: 'sb_publishable_deadline_test_key',
    localStorage: storage(), sessionStorage: storage(), now: () => clock.now,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.includes('grant_type=password')) return auth();
      return handle(url, init);
    },
  });
  return { client, calls, clock, auth };
}

test('a meal upload that ignores abort still rejects at the complete-operation deadline without retrying', async t => {
  const started = deferred();
  let uploadSignal;
  const h = harness((_url, init) => {
    uploadSignal = init.signal;
    started.resolve();
    return new Promise(() => {});
  });
  await h.client.signIn('owner@example.test', 'password', false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = h.client.estimateMealPhoto(input);
  const rejected = assert.rejects(pending, timeoutError);
  await started.promise;
  t.mock.timers.tick(MEAL_PHOTO_REQUEST_TIMEOUT_MS);
  await rejected;
  assert.equal(uploadSignal.aborted, true);
  assert.equal(h.calls.length, 2, 'a timed-out paid request must not be uploaded again automatically');
});

for (const status of [200, 502]) {
  test(`the meal deadline includes a stalled ${status === 200 ? 'success' : 'error'} response body after headers arrive`, async t => {
    const bodyStarted = deferred();
    let uploadSignal;
    const h = harness((_url, init) => {
      uploadSignal = init.signal;
      return { status, ok: status === 200, json: () => { bodyStarted.resolve(); return new Promise(() => {}); } };
    });
    await h.client.signIn('owner@example.test', 'password', false);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejected = assert.rejects(h.client.estimateMealPhoto(input), timeoutError);
    await bodyStarted.promise;
    t.mock.timers.tick(MEAL_PHOTO_REQUEST_TIMEOUT_MS);
    await rejected;
    assert.equal(uploadSignal.aborted, true);
    assert.equal(h.calls.length, 2);
  });
}

test('cancelling during a stalled response body settles the estimate immediately', async t => {
  const bodyStarted = deferred();
  let uploadSignal;
  const h = harness((_url, init) => {
    uploadSignal = init.signal;
    return { status: 200, ok: true, json: () => { bodyStarted.resolve(); return new Promise(() => {}); } };
  });
  await h.client.signIn('owner@example.test', 'password', false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const rejected = assert.rejects(h.client.estimateMealPhoto(input, controller.signal), error => error.name === 'AbortError');
  await bodyStarted.promise;
  controller.abort();
  await rejected;
  assert.equal(uploadSignal.aborted, true);
  t.mock.timers.tick(MEAL_PHOTO_REQUEST_TIMEOUT_MS);
  assert.equal(h.calls.length, 2);
});

test('a late body cannot revive a timed-out estimate, and an explicit retry can succeed', async t => {
  const bodyStarted = deferred();
  const lateBody = deferred();
  let uploads = 0;
  const h = harness(() => {
    if (++uploads === 1) return { status: 200, ok: true, json: () => { bodyStarted.resolve(); return lateBody.promise; } };
    return Response.json(draft);
  });
  await h.client.signIn('owner@example.test', 'password', false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = h.client.estimateMealPhoto(input);
  let fulfilled = false;
  pending.then(() => { fulfilled = true; }, () => {});
  const rejected = assert.rejects(pending, timeoutError);
  await bodyStarted.promise;
  t.mock.timers.tick(MEAL_PHOTO_REQUEST_TIMEOUT_MS);
  await rejected;
  lateBody.resolve({ ...draft, name: 'Stale estimate' });
  assert.deepEqual(await h.client.estimateMealPhoto(input), draft);
  assert.equal(fulfilled, false, 'the old estimate stays rejected after its delayed body completes');
  assert.equal(uploads, 2, 'only the explicit retry initiates another upload');
});

for (const authState of ['expired token', '401 response']) {
  test(`a deadline while refreshing after ${authState} cannot start a later meal upload`, async t => {
    const refreshStarted = deferred();
    const refreshResponse = deferred();
    let uploads = 0, resuming = false;
    let h;
    h = harness((url) => {
      if (url.includes('grant_type=refresh_token')) {
        refreshStarted.resolve();
        return refreshResponse.promise;
      }
      uploads++;
      return resuming ? Response.json(draft) : Response.json({ error: 'Expired caller token' }, { status: 401 });
    });
    await h.client.signIn('owner@example.test', 'password', false);
    if (authState === 'expired token') h.clock.now += 3600 * 1000;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejected = assert.rejects(h.client.estimateMealPhoto(input), timeoutError);
    await refreshStarted.promise;
    t.mock.timers.tick(MEAL_PHOTO_REQUEST_TIMEOUT_MS);
    await rejected;
    resuming = true;
    refreshResponse.resolve(h.auth());
    // The same client's refresh promise must settle before the next explicit call.
    // That call also proves the timed-out operation cannot enqueue a hidden upload.
    assert.deepEqual(await h.client.estimateMealPhoto(input), draft);
    assert.equal(uploads, authState === 'expired token' ? 1 : 2, 'only the explicit retry can upload after the shared refresh completes');
  });
}

test('successful completion removes the deadline and external abort listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let addCount = 0, removeCount = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { if (args[0] === 'abort') addCount++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { if (args[0] === 'abort') removeCount++; return remove(...args); };
  let operationSignal;
  assert.equal(await withMealPhotoDeadline(async signal => { operationSignal = signal; return 'complete'; }, controller.signal), 'complete');
  assert.equal(addCount, removeCount);
  assert.ok(addCount > 0, 'the external caller cancellation is connected while running');
  controller.abort();
  t.mock.timers.tick(MEAL_PHOTO_REQUEST_TIMEOUT_MS);
  assert.equal(operationSignal.aborted, false, 'finished work has no live cancellation listener or deadline');
});
