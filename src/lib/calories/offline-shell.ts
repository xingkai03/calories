type Browser = Pick<Window, 'navigator' | 'location' | 'isSecureContext'> & Partial<Pick<Window, 'dispatchEvent'>> & { document?: Pick<Document, 'addEventListener' | 'visibilityState'> };

/** Fired on window with the waiting worker as `detail` once a new build is installed. */
export const CALORIES_UPDATE_EVENT = 'calories-update-ready';
/** The waiting worker activates only when the page asks; old windows keep one coherent build until then. */
export const CALORIES_SKIP_WAITING = 'calories-skip-waiting';

/** Production-only, narrowly scoped registration; online use survives cache failures. */
export async function registerCaloriesOfflineShell(production: boolean, browser?: Browser): Promise<ServiceWorkerRegistration | undefined> {
  if (!production) return;
  const environment = browser ?? window;
  if (!environment.isSecureContext || !environment.location.pathname.startsWith('/calories/') || !('serviceWorker' in environment.navigator)) return;
  try {
    const registration = await environment.navigator.serviceWorker.register('/calories/sw.js', { scope: '/calories/', updateViaCache: 'none' });
    watchForUpdates(registration, environment);
    return registration;
  } catch {
    // Storage restrictions or a failed precache must not interrupt the online app.
    return;
  }
}

function watchForUpdates(registration: ServiceWorkerRegistration, environment: Browser) {
  if (typeof registration?.addEventListener !== 'function') return;
  const announce = () => {
    // A first install has no controller; only a replacement build needs the reload prompt.
    if (registration.waiting && environment.navigator.serviceWorker.controller) environment.dispatchEvent?.(new CustomEvent(CALORIES_UPDATE_EVENT, { detail: registration.waiting }));
  };
  announce();
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => { if (installing.state === 'installed') announce(); });
  });
  // An installed app can stay open for days; check for a new build whenever it comes back into view.
  const document = environment.document ?? (typeof window !== 'undefined' ? window.document : undefined);
  document?.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') registration.update().catch(() => {}); });
}

/** Activate the waiting build, then reload once the new worker controls this page. */
export function applyCaloriesUpdate(waiting: ServiceWorker, browser: Pick<Window, 'navigator' | 'location'> = window) {
  browser.navigator.serviceWorker.addEventListener('controllerchange', () => browser.location.reload(), { once: true });
  waiting.postMessage({ type: CALORIES_SKIP_WAITING });
}
