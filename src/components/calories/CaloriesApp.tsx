import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { addDays, dayTotals, emptyData, normalizeData, settingsForDay, todayISO, type Entry, type Food, type TrackerData, type BankPortion } from '../../lib/calories/model';
import { createClient, isRecoverableNetworkError, type JournalSnapshot } from '../../lib/calories/client';
import { effectiveBurned, emptyGarminSnapshot, type GarminSnapshot } from '../../lib/calories/garmin';
import { DAILY_PROTEIN_GRAMS, macroTargets, nutrientProgress } from '../../lib/calories/nutrition';
import { adjustedBudget, calorieLedger, carryBefore, outstandingAfter, CARRY_SPREAD_DAYS } from '../../lib/calories/budget';
import { RECENT_FOOD_DAYS, recentFoodIds, sortFoodsByRecentUse } from '../../lib/calories/food-order';
import { FoodBankView, FoodBankEditor, FoodBankConsume } from './FoodBank';
import { addPreparedPortions, consumeFoodBankPortion } from '../../lib/calories/food-bank';
import { FormDraftProvider, useFormDrafts, clearFormDrafts } from './FormDrafts';
import type { FormDraftSummary } from '../../lib/calories/form-drafts';
import { assertCurrentRecord } from '../../lib/calories/draft-conflicts';
import { createUndoAction, undoAction, type UndoAction, type UndoKind } from '../../lib/calories/undo';
import UndoNotice from './UndoNotice';
import { applyCaloriesUpdate, CALORIES_UPDATE_EVENT } from '../../lib/calories/offline-shell';
import { Icon, number, signedNumber, readableDate, errorMessage, syncTime, burnedLabel, burnedFormula, burnedSyncTime, staleImport, garminStatusLabel, downloadFile, unitLabel } from './ui';
import './calories.css';
import './offline.css';

const loadModals = () => import('./CaloriesModals');
const EntryEditor = lazy(() => loadModals().then(m => ({ default: m.EntryEditor })));
const FoodEditor = lazy(() => loadModals().then(m => ({ default: m.FoodEditor })));
const TargetsEditor = lazy(() => loadModals().then(m => ({ default: m.TargetsEditor })));
const GarminConnection = lazy(() => loadModals().then(m => ({ default: m.GarminConnection })));
const TransferDialog = lazy(() => loadModals().then(m => ({ default: m.TransferDialog })));
const TrendsView = lazy(() => import('./TrendsView'));
const NO_ENTRIES: Entry[] = [];

type View = 'journal' | 'foods' | 'bank' | 'history' | 'trends';
const VIEWS: readonly View[] = ['journal', 'foods', 'bank', 'history', 'trends'];
const HISTORY_PAGE = 60;

/** View and date live in the URL, so Back, reload and shared links land on the same screen. */
function locationState(): { view: View; date: string | null } {
  if (typeof window === 'undefined') return { view: 'journal', date: null };
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') as View | null;
  const date = params.get('date');
  return { view: view && VIEWS.includes(view) ? view : 'journal', date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) ? date : null };
}
function urlFor(view: View, date: string, currentDay: string): string {
  const params = new URLSearchParams();
  if (view !== 'journal') params.set('view', view);
  if (date !== currentDay) params.set('date', date);
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ''}`;
}
type Phase = 'loading' | 'setup' | 'login' | 'ready';
type SaveState = 'saved' | 'pending' | 'saving' | 'device' | 'offline' | 'error';
type ModalState = { type: 'entry'; entry?: Entry; foodId?: string; meal?: string } | { type: 'food'; food?: Food; returnToLog?: boolean } | { type: 'targets' } | { type: 'transfer' } | { type: 'garmin' } | { type: 'bank-prepare' } | { type: 'bank-consume'; portion: BankPortion } | null;


export default function CaloriesApp({ clientOverride }: { clientOverride?: ReturnType<typeof createClient> } = {}) {
  const [client] = useState(() => clientOverride ?? createClient());
  const [phase, setPhase] = useState<Phase>('loading');
  const [data, setData] = useState<TrackerData>(emptyData);
  const dataRef = useRef(data);
  const [view, setView] = useState<View>(() => locationState().view);
  const [date, setDate] = useState(() => locationState().date ?? todayISO());
  const [currentDay, setCurrentDay] = useState(todayISO);
  const [modal, setModal] = useState<ModalState>(null);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const [email, setEmail] = useState(client.getEmail());
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState('');
  const [offline, setOffline] = useState(false);
  const [journalScope, setJournalScope] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [undoNotice, setUndoNotice] = useState<{ action: UndoAction; message: string; scope: string } | null>(null);
  const [garmin, setGarmin] = useState<GarminSnapshot>(emptyGarminSnapshot);
  const [garminLoading, setGarminLoading] = useState(false);
  const [garminLoadError, setGarminLoadError] = useState('');
  const [garminDisconnecting, setGarminDisconnecting] = useState(false);
  const disconnectingGarmin = useRef(false);
  const garminFetching = useRef(false);
  const garminRequest = useRef(0);
  const garminSessionScope = useRef(0);
  const deferredGarmin = useRef<GarminSnapshot | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [foodSearch, setFoodSearch] = useState('');
  const [showAllLibrary, setShowAllLibrary] = useState(false);
  const [deleteFoodId, setDeleteFoodId] = useState<string | null>(null);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const [trendsNotice, setTrendsNotice] = useState('');
  const [updateWorker, setUpdateWorker] = useState<ServiceWorker | null>(null);
  const queue = useRef<TrackerData | null>(null);
  const saving = useRef(false);
  const blockedSave = useRef(false);
  const refreshing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const localWork = useRef<Promise<void>>(Promise.resolve());
  const localWrites = useRef(0);
  const changeVersion = useRef(0);
  const journalVersion = useRef<string | undefined>(undefined);
  const deferredJournal = useRef<{ snapshot: JournalSnapshot; version: number } | null>(null);
  const lastLocalError = useRef('');
  const undoing = useRef(false);
  const navigationMode = useRef<'push' | 'replace'>('replace');
  const modalInHistory = useRef(false);
  const closingModalByCode = useRef(false);
  const locationRef = useRef({ view, date, currentDay: todayISO() });
  const lastGarminRefresh = useRef(0);

  useEffect(() => {
    let dayTimer: ReturnType<typeof setTimeout>;
    const updateCurrentDay = () => {
      const now = new Date();
      setCurrentDay(todayISO());
      clearTimeout(dayTimer);
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      dayTimer = setTimeout(updateCurrentDay, midnight.getTime() - now.getTime() + 50);
    };
    updateCurrentDay();
    window.addEventListener('focus', updateCurrentDay);
    document.addEventListener('visibilitychange', updateCurrentDay);
    return () => { clearTimeout(dayTimer); window.removeEventListener('focus', updateCurrentDay); document.removeEventListener('visibilitychange', updateCurrentDay); };
  }, []);

  locationRef.current = { view, date, currentDay };

  useEffect(() => {
    const onUpdate = (event: Event) => setUpdateWorker((event as CustomEvent<ServiceWorker>).detail);
    window.addEventListener(CALORIES_UPDATE_EVENT, onUpdate);
    // The build may have finished installing before this component mounted.
    navigator.serviceWorker?.getRegistration('/calories/').then(registration => { if (registration?.waiting && navigator.serviceWorker.controller) setUpdateWorker(registration.waiting); }).catch(() => {});
    return () => window.removeEventListener(CALORIES_UPDATE_EVENT, onUpdate);
  }, []);
  async function reloadForUpdate() {
    if (!updateWorker) return;
    // Changes are staged on this device first, so finishing the local write is enough before reloading.
    await localWork.current;
    applyCaloriesUpdate(updateWorker);
  }

  useEffect(() => {
    if (phase !== 'ready') return;
    const url = urlFor(view, date, currentDay);
    const mode = navigationMode.current;
    navigationMode.current = 'replace';
    if (modalInHistory.current || url === `${window.location.pathname}${window.location.search}`) return;
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  }, [view, date, currentDay, phase]);

  // An open dialog owns one history entry, so the phone's Back button closes it instead of leaving the app.
  const modalOpen = Boolean(modal);
  useEffect(() => {
    if (modalOpen && !modalInHistory.current) {
      window.history.pushState({ caloriesDialog: true }, '', window.location.href);
      modalInHistory.current = true;
    } else if (!modalOpen && modalInHistory.current) {
      modalInHistory.current = false;
      closingModalByCode.current = true;
      window.history.back();
    }
  }, [modalOpen]);

  useEffect(() => {
    function onPopState() {
      const current = locationRef.current;
      if (closingModalByCode.current) {
        closingModalByCode.current = false;
        // Keep any view or date the app moved to while the dialog was closing.
        window.history.replaceState(null, '', urlFor(current.view, current.date, current.currentDay));
        return;
      }
      if (modalInHistory.current) { modalInHistory.current = false; setModal(null); return; }
      const next = locationState();
      setView(next.view); setDate(next.date ?? current.currentDay); setDeleteFoodId(null);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  async function refreshGarmin(force = false) {
    if (phaseRef.current !== 'ready' || garminFetching.current || disconnectingGarmin.current || (modalRef.current && modalRef.current.type !== 'garmin')) return;
    // Imports run hourly; background checks reuse a reading fetched in the last five minutes.
    if (!force && Date.now() - lastGarminRefresh.current < 300_000) return;
    const request = ++garminRequest.current;
    garminFetching.current = true;
    setGarminLoading(true);
    try {
      const latest = await client.loadGarmin();
      if (!mounted.current || request !== garminRequest.current || phaseRef.current !== 'ready') return;
      if (modalRef.current && modalRef.current.type !== 'garmin') deferredGarmin.current = latest;
      else setGarmin(latest);
      lastGarminRefresh.current = Date.now();
      setGarminLoadError('');
    } catch (error) {
      if (mounted.current && request === garminRequest.current && phaseRef.current === 'ready') setGarminLoadError(errorMessage(error));
    } finally {
      if (request === garminRequest.current) { garminFetching.current = false; if (mounted.current) setGarminLoading(false); }
    }
  }

  async function disconnectGarmin() {
    if (!window.confirm('Disconnect Garmin? Automatic imports will stop. Previously imported calorie readings will be kept.')) return;
    const scope = garminSessionScope.current;
    garminRequest.current++; garminFetching.current = false;
    disconnectingGarmin.current = true; setGarminDisconnecting(true); setGarminLoadError('');
    try {
      await client.disconnectGarmin();
      if (scope !== garminSessionScope.current || phaseRef.current !== 'ready') return;
      disconnectingGarmin.current = false;
      setGarmin(current => ({ ...current, status: { ...current.status, state: 'not_connected', last_error_code: null } }));
      if (phaseRef.current === 'ready') await refreshGarmin(true);
    } catch (error) {
      if (scope === garminSessionScope.current && phaseRef.current === 'ready') setGarminLoadError(errorMessage(error));
    } finally { if (scope === garminSessionScope.current) { disconnectingGarmin.current = false; if (mounted.current) setGarminDisconnecting(false); } }
  }

  function acceptJournal(snapshot: JournalSnapshot, expectedChange = changeVersion.current, localStage = false) {
    setOffline(snapshot.offline);
    setJournalScope(client.getJournalScope());
    blockedSave.current = Boolean(snapshot.conflict);
    setSaveError(snapshot.conflict ?? '');
    if (!localStage && modalRef.current) {
      deferredJournal.current = { snapshot, version: expectedChange };
    } else if (changeVersion.current === expectedChange) {
      deferredJournal.current = null;
      journalVersion.current = snapshot.localVersion;
      dataRef.current = snapshot.data;
      setData(snapshot.data);
      queue.current = snapshot.pending ? snapshot.data : null;
    }
    setSaveState(snapshot.conflict ? 'error' : snapshot.offline ? 'offline' : queue.current ? 'device' : 'saved');
  }

  function scheduleSync() {
    if (timer.current) clearTimeout(timer.current);
    if (!blockedSave.current && navigator.onLine !== false) timer.current = setTimeout(() => { void flushSave(); }, 500);
  }

  async function loadData() {
    const snapshot = await client.openJournal();
    acceptJournal(snapshot);
    const cachedGarmin = client.getCachedGarmin();
    if (cachedGarmin) setGarmin(cachedGarmin);
    setPhase('ready');
    if (phaseRef.current === 'ready') void refreshGarmin(true);
    if (snapshot.pending && !snapshot.offline && !snapshot.conflict) scheduleSync();
  }

  async function reloadSavedData() {
    if (saving.current || refreshing.current || localWrites.current) { setSaveError('Wait for the current save or refresh to finish before reloading.'); return; }
    if (!window.confirm('Reload the saved journal? Unsaved changes on this device will be discarded.')) return;
    setUndoNotice(null);
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    blockedSave.current = true;
    setModal(null);
    setPhase('loading');
    try { acceptJournal(await client.discardJournalChanges()); setPhase('ready'); }
    catch (error) { setPhase('ready'); setSaveState('error'); setSaveError(errorMessage(error)); }
  }

  useEffect(() => {
    mounted.current = true;
    let active = true;
    async function start() {
      if (!client.configured) { setPhase('setup'); return; }
      try {
        const restored = await client.restoreSession();
        if (!active) return;
        if (restored) { setEmail(client.getEmail()); await loadData(); }
        else setPhase('login');
      } catch (error) {
        if (active) { setNotice(errorMessage(error)); setPhase('login'); }
      }
    }
    void start();
    return () => { active = false; mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void, o?: { timeout: number }) => number);
    const handle = idle ? idle(() => { void loadModals(); }, { timeout: 4000 }) : window.setTimeout(() => { void loadModals(); }, 1500);
    return () => { if (idle) (window as any).cancelIdleCallback?.(handle); else clearTimeout(handle); };
  }, [phase]);

  useEffect(() => {
    if (phase === 'ready') void refreshGarmin(true);
    else { lastGarminRefresh.current = 0; setUndoNotice(null); deferredGarmin.current = null; setGarmin(emptyGarminSnapshot()); setGarminLoading(false); setGarminLoadError(''); disconnectingGarmin.current = false; setGarminDisconnecting(false); }
    return () => { garminRequest.current++; garminSessionScope.current++; garminFetching.current = false; };
  }, [phase]);

  useEffect(() => {
    if (!modal && phase === 'ready' && deferredGarmin.current) { setGarmin(deferredGarmin.current); deferredGarmin.current = null; }
    if (!modal && phase === 'ready' && deferredJournal.current && !localWrites.current && !blockedSave.current) {
      const deferred = deferredJournal.current;
      deferredJournal.current = null;
      if (changeVersion.current === deferred.version) acceptJournal(deferred.snapshot, deferred.version, true);
      else scheduleSync();
    }
  }, [modal, phase]);

  useEffect(() => {
    if (phase !== 'ready') return;
    let active = true;
    let checking = false;
    async function checkSession(refreshData = false) {
      if (!active || checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const valid = await client.restoreSession();
        if (active && valid) void refreshGarmin();
        if (active && !valid) {
          setModal(null);
          setPhase('login');
          setNotice('Your session has ended. Sign in again to recover your saved device drafts.');
        } else if (active && (refreshData || queue.current) && !modalRef.current) {
          await flushSave();
        }
      } catch (error) {
        if (active && !isRecoverableNetworkError(error)) {
          setModal(null); setPhase('login'); setNotice(errorMessage(error));
        }
      }
      finally { checking = false; }
    }
    const sessionTimer = setInterval(() => { if (navigator.onLine !== false) void checkSession(); }, 120_000);
    const onFocus = () => { void checkSession(true); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    const onOffline = () => { setOffline(true); if (!blockedSave.current) setSaveState('offline'); };
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onFocus);
    return () => { active = false; clearInterval(sessionTimer); window.removeEventListener('focus', onFocus); window.removeEventListener('online', onFocus); window.removeEventListener('offline', onOffline); document.removeEventListener('visibilitychange', onFocus); };
  }, [phase]);

  useEffect(() => {
    function preventUnsavedExit(event: BeforeUnloadEvent) {
      if (localWrites.current) { event.preventDefault(); event.returnValue = ''; }
    }
    window.addEventListener('beforeunload', preventUnsavedExit);
    return () => window.removeEventListener('beforeunload', preventUnsavedExit);
  }, []);

  async function flushSave(): Promise<boolean> {
    if (blockedSave.current || refreshing.current) return false;
    if (saving.current) return false;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    saving.current = true;
    await localWork.current;
    const version = changeVersion.current;
    if (blockedSave.current) { saving.current = false; return false; }
    if (navigator.onLine !== false) setSaveState('saving');
    try {
      const snapshot = await client.syncJournal();
      if (mounted.current) acceptJournal(snapshot, version);
      return !snapshot.pending && !snapshot.conflict;
    } catch (error) {
      blockedSave.current = true;
      if (mounted.current) { setSaveState('error'); setSaveError(errorMessage(error)); }
      if (!client.getJournalScope()) { setModal(null); setPhase('login'); setNotice(errorMessage(error)); }
      return false;
    } finally {
      saving.current = false;
      if (changeVersion.current !== version && queue.current && !blockedSave.current) scheduleSync();
    }
  }

  function updateData(transform: (current: TrackerData) => TrackerData): Promise<boolean> {
    localWrites.current++;
    const work = localWork.current.then(async () => {
      let staging = false;
      try {
        const next = transform(dataRef.current);
        const version = ++changeVersion.current;
        queue.current = next; setSaveState('pending');
        staging = true;
        const snapshot = await client.stageJournal(next, journalVersion.current);
        acceptJournal(snapshot, version, true);
        if (!snapshot.conflict) scheduleSync();
        return true;
      } catch (error) {
        lastLocalError.current = errorMessage(error);
        if (staging) { blockedSave.current = true; setSaveState('error'); setSaveError(errorMessage(error)); }
        return false;
      } finally { localWrites.current--; }
    });
    localWork.current = work.then(() => {});
    return work;
  }

  async function updateWithUndo(kind: UndoKind, id: string, transform: (current: TrackerData) => TrackerData, message: (before: TrackerData) => string): Promise<boolean> {
    const scope = client.getJournalScope();
    let action: UndoAction | undefined;
    let text = '';
    const persisted = await updateData(current => {
      if (!scope || client.getJournalScope() !== scope) throw new Error('Sign in again before changing your journal.');
      const next = transform(current);
      action = createUndoAction(current, next, kind, id);
      text = message(current);
      return next;
    });
    if (persisted && action && scope && client.getJournalScope() === scope) setUndoNotice({ action, message: text, scope });
    return persisted;
  }

  async function undoLatest(action: UndoAction, scope: string) {
    if (undoing.current) throw new Error('Wait for the current Undo to finish, then try again.');
    undoing.current = true;
    try {
      if (!(await updateData(current => {
        if (client.getJournalScope() !== scope) throw new Error('This Undo belongs to an earlier sign-in.');
        return undoAction(current, action);
      }))) throw new Error(lastLocalError.current);
      if (action.kind === 'delete-entry') openDay(action.record.date);
      else if (action.kind === 'delete-food') { setView('foods'); setFoodSearch(''); }
      else setView('bank');
    } finally { undoing.current = false; }
  }

  async function removeEntry(id: string) {
    await updateWithUndo('delete-entry', id, current => ({ ...current, entries: current.entries.filter(entry => entry.id !== id) }), before => `Removed ${before.entries.find(entry => entry.id === id)?.foodName ?? 'entry'}.`);
  }

  async function removeFood(id: string) {
    if (await updateWithUndo('delete-food', id, current => ({ ...current, foods: current.foods.filter(food => food.id !== id) }), before => `Removed ${before.foods.find(food => food.id === id)?.name ?? 'food'} from the library.`)) setDeleteFoodId(null);
  }

  async function removeBankPortion(id: string) {
    await updateWithUndo('delete-bank', id, current => ({ ...current, foodBank: current.foodBank.filter(portion => portion.id !== id) }), before => `Removed ${before.foodBank.find(portion => portion.id === id)?.name ?? 'prepared portion'}.`);
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice('');
    try {
      await client.signIn(email.trim(), password, remember);
      setPassword('');
      await loadData();
    }
    catch (error) { setNotice(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function signOut() {
    if (saving.current || localWrites.current) { setSaveError('Please wait for the current save to finish before signing out.'); return; }
    if (queue.current || saving.current) {
      if (!(await flushSave())) {
        if (!window.confirm('Sign out and discard unsaved changes on this device? Cancel and export a backup first if you want to keep them.')) return;
        queue.current = null;
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      }
    }
    setBusy(true);
    setUndoNotice(null);
    if (journalScope) clearFormDrafts(journalScope);
    deferredJournal.current = null;
    const signOutRequest = client.signOut();
    garminRequest.current++; deferredGarmin.current = null; setGarmin(emptyGarminSnapshot()); setGarminLoadError(''); setGarminLoading(false);
    setPhase('login'); setModal(null); setData(emptyData()); dataRef.current = emptyData(); setJournalScope(null); journalVersion.current = undefined; setOffline(false); setRecoveryNotice(''); setNotice(''); setSaveError(''); setSaveState('saved'); blockedSave.current = false;
    try { const signOutNotice = await signOutRequest; setNotice(signOutNotice ?? ''); }
    catch (error) { setNotice(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function saveFood(food: Food, originalRecordJson: string) {
    const returnToLog = modal?.type === 'food' && modal.returnToLog;
    if (!(await updateData(current => {
      assertCurrentRecord(current.foods.find(item => item.id === food.id) ?? null, originalRecordJson, food, 'this library food');
      return { ...current, foods: current.foods.some(item => item.id === food.id) ? current.foods.map(item => item.id === food.id ? food : item) : [...current.foods, food] };
    }))) throw new Error(lastLocalError.current);
    setModal(returnToLog ? { type: 'entry', foodId: food.id } : null);
  }

  async function saveEntry(entry: Entry, originalRecordJson: string) {
    if (!(await updateData(current => {
      assertCurrentRecord(current.entries.find(item => item.id === entry.id) ?? null, originalRecordJson, entry, 'this journal entry');
      return { ...current, days: { ...current.days, [entry.date]: settingsForDay(current, entry.date) }, entries: current.entries.some(item => item.id === entry.id) ? current.entries.map(item => item.id === entry.id ? entry : item) : [...current.entries, entry] };
    }))) throw new Error(lastLocalError.current);
    setModal(null);
  }

  async function saveBankPortions(portions: BankPortion[]) {
    const persisted = await updateData(current => addPreparedPortions(current, portions));
    if (!persisted) throw new Error(lastLocalError.current);
    setModal(null); setView('bank');
  }

  async function eatBankPortion(portionId: string, entryDate: string, meal: string) {
    if (!(await updateWithUndo('consume-bank', portionId, current => consumeFoodBankPortion(current, portionId, entryDate, meal), before => `Logged ${before.foodBank.find(portion => portion.id === portionId)?.name ?? 'prepared portion'}.`))) throw new Error(lastLocalError.current);
    setModal(null); openDay(entryDate);
  }

  async function applyPlanDeficit(deficit: number) {
    const rounded = Math.round(deficit);
    if (!(await updateData(current => ({
      ...current,
      defaults: { ...current.defaults, deficit: rounded },
      days: current.days[currentDay] ? { ...current.days, [currentDay]: { ...current.days[currentDay], deficit: rounded } } : current.days,
    })))) throw new Error(lastLocalError.current);
    setTrendsNotice(`Your default deficit is now ${number(rounded)} kcal, starting today.`);
  }

  function openFoodBank() { setModal(null); setView('bank'); }

  function openDay(nextDate: string) { setDate(nextDate); if (view !== 'journal') navigationMode.current = 'push'; setView('journal'); }
  function changeView(next: View) { if (next !== view) navigationMode.current = 'push'; setView(next); setDeleteFoodId(null); setHistoryLimit(HISTORY_PAGE); setTrendsNotice(''); }

  function resumeFormDraft(draft: FormDraftSummary) {
    setRecoveryNotice('');
    if (draft.date) setDate(draft.date);
    if (draft.kind === 'entry') {
      const entry = draft.entryId ? dataRef.current.entries.find(item => item.id === draft.entryId) : undefined;
      if (draft.entryId && !entry) { setRecoveryNotice('The entry for this draft was removed. You can discard the draft below.'); return; }
      setView('journal'); setModal({ type: 'entry', entry, foodId: draft.foodId });
    } else if (draft.kind === 'food') {
      const food = draft.foodId ? dataRef.current.foods.find(item => item.id === draft.foodId) : undefined;
      if (draft.foodId && !food) { setRecoveryNotice('The food for this draft was removed. You can discard the draft below.'); return; }
      setView('foods'); setModal({ type: 'food', food });
    } else if (draft.kind === 'targets') { setView('journal'); setModal({ type: 'targets' }); }
    else { setView('bank'); setModal({ type: 'bank-prepare' }); }
  }

  const entriesByDate = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const entry of data.entries) { const list = map.get(entry.date); if (list) list.push(entry); else map.set(entry.date, [entry]); }
    return map;
  }, [data.entries]);
  const dayEntries = entriesByDate.get(date) ?? NO_ENTRIES;
  const totals = useMemo(() => dayTotals(dayEntries), [dayEntries]);
  const targets = settingsForDay(data, date, entriesByDate.has(date));
  const burned = effectiveBurned(date, targets, garmin.days, currentDay);
  const burnedSyncDay = burned.day ?? burned.restingDay;
  const ledger = useMemo(() => calorieLedger(data, garmin.days, currentDay), [data, garmin.days, currentDay]);
  const carryIn = carryBefore(date, ledger);
  const carryIsProvisional = Boolean(ledger.provisional && date > ledger.provisional.date);
  const allowance = adjustedBudget(burned.burned, targets.deficit, carryIn);
  const budget = allowance.budget;
  const remaining = budget - totals.calories;
  const selectedBalance = ledger.days[date];
  const rawBalance = selectedBalance ? selectedBalance.balance : outstandingAfter(date, ledger);
  const hasPendingLoggedDays = Object.values(ledger.days).some(row => row.date < currentDay && !row.available);
  const deficit = burned.burned - totals.calories;
  const calorieProgress = nutrientProgress(totals.calories, budget);
  const nutritionTargets = macroTargets(budget);
  const meals = useMemo(() => [...new Set(dayEntries.map(entry => entry.meal))], [dayEntries]);
  const sortedFoods = useMemo(() => sortFoodsByRecentUse(data.foods, data.entries, currentDay), [data.foods, data.entries, currentDay]);
  const recentIds = useMemo(() => recentFoodIds(data.entries, currentDay), [data.entries, currentDay]);
  // Without a search, the library shows only foods logged in the last week, unless none were.
  const hideUnusedFoods = !showAllLibrary && !foodSearch.trim() && recentIds.size > 0;
  const visibleFoods = useMemo(() => { const query = foodSearch.trim().toLowerCase(); return sortedFoods.filter(food => food.name.toLowerCase().includes(query) && (!hideUnusedFoods || recentIds.has(food.id))); }, [sortedFoods, foodSearch, hideUnusedFoods, recentIds]);
  const hiddenLibraryFoods = hideUnusedFoods ? sortedFoods.length - visibleFoods.length : 0;
  const lastQuantities = useMemo(() => {
    const latest = new Map<string, Entry>();
    for (const entry of data.entries) if (entry.source !== 'manual') { const seen = latest.get(entry.foodId); if (!seen || entry.date >= seen.date) latest.set(entry.foodId, entry); }
    return Object.fromEntries([...latest].map(([foodId, entry]) => [foodId, entry.quantity]));
  }, [data.entries]);
  const libraryIds = useMemo(() => new Set(data.foods.map(food => food.id)), [data.foods]);
  const historyDates = useMemo(() => [...new Set([...entriesByDate.keys(), ...Object.keys(data.days)])].sort().reverse(), [entriesByDate, data.days]);

  return <div className="calorie-app">
    {updateWorker && <div className="cal-update-banner" role="status"><span>A new version of Calories is ready.</span><button className="cal-button cal-button-small cal-button-primary" onClick={() => void reloadForUpdate()}><Icon name="refresh" size={16}/>Reload</button></div>}
    {phase !== 'ready' ? <main className="cal-auth-shell">
      <a className="cal-home-link" href="/">← Back to my website</a>
      <div className="cal-auth-brand"><span className="cal-brand-mark"><Icon name="leaf" size={24}/></span><span>calories<span className="cal-brand-dot">.</span></span></div>
      {phase === 'loading' ? <div className="cal-auth-card cal-loading" role="status"><span className="cal-spinner"/><h1>Opening your journal</h1><p>Checking your saved session.</p></div>
        : phase === 'setup' ? <Setup onConfigure={(config) => { client.configure(config); setPhase('login'); setNotice(''); }} />
        : <div className="cal-auth-card">
          <div className="cal-eyebrow">YOUR PERSONAL FOOD JOURNAL</div>
          <h1>A little space<br/>for your everyday.</h1>
          <p className="cal-auth-intro">Sign in to pick up where you left off.</p>
          <form onSubmit={signIn} className="cal-form">
            <label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required autoCapitalize="none" spellCheck={false} placeholder="Your account email" /></label>
            <label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required placeholder="Your password" /></label>
            <label className="cal-checkbox"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)}/><span>Remember this device for 30 days<small>Leave unchecked on a shared device.</small></span></label>
            {notice && <p className="cal-form-error" role="alert">{notice}</p>}
            <button className="cal-button cal-button-primary cal-button-full" disabled={busy}>{busy ? 'Signing in…' : 'Open my journal'}<Icon name="arrow" size={18}/></button>
          </form>
          <div className="cal-auth-footnote"><Icon name="lock" size={15}/><span>Your entries sync privately across your devices.</span></div>
          {queue.current && <button className="cal-text-button cal-auth-config" onClick={() => downloadFile(JSON.stringify(queue.current, null, 2), `calories-unsaved-${todayISO()}.json`, 'application/json')}>Export unsaved changes</button>}
          <button className="cal-text-button cal-auth-config" onClick={() => { setPhase('setup'); setNotice(''); }}>Connection settings</button>
        </div>}
      <p className="cal-auth-tagline">A record of your day. At your own pace.</p>
    </main> : <FormDraftProvider key={journalScope} scope={journalScope}>
      <header className="cal-header">
        <a href="/calories/" className="cal-brand" aria-label="Calories home"><span className="cal-brand-mark"><Icon name="leaf" size={22}/></span><span>calories<span className="cal-brand-dot">.</span></span></a>
        <nav className="cal-nav" aria-label="Journal navigation">
          {([['journal', 'Journal'], ['foods', 'Foods'], ['bank', 'Food bank'], ['history', 'History'], ['trends', 'Trends']] as [View, string][]).map(([key, label]) => <button key={key} className={view === key ? 'is-active' : ''} aria-current={view === key ? 'page' : undefined} onClick={() => changeView(key)}>{label}</button>)}
        </nav>
        <div className="cal-header-tools">
          <span className={`cal-sync cal-sync-${saveState}`} role="status" aria-live="polite">{['saved', 'device', 'offline'].includes(saveState) ? <Icon name="check" size={13}/> : <span className="cal-status-dot"/>}<span>{saveState === 'saved' ? 'All saved' : saveState === 'error' ? 'Needs attention' : saveState === 'device' ? 'Saved on device' : saveState === 'offline' ? 'Offline · on device' : 'Saving…'}</span></span>
          <button className="cal-icon-button" onClick={() => setModal({ type: 'transfer' })} title="Backup & import" aria-label="Backup and import"><Icon name="download"/></button>
          <button className="cal-icon-button" onClick={() => void signOut()} title="Sign out" aria-label="Sign out" disabled={busy}><Icon name="logout"/></button>
        </div>
      </header>

      {saveError && <div className="cal-save-alert" role="alert"><div><strong>Your latest changes haven’t synced.</strong><p>{saveError}</p></div><button className="cal-button cal-button-small" onClick={() => setModal({ type: 'transfer' })}>Export unsaved</button><button className="cal-text-button" onClick={() => void reloadSavedData()} disabled={busy || saving.current || refreshing.current}>Reload saved data</button></div>}

      {(offline || saveState === 'device') && !saveError && <div className="cal-offline-notice" role="status"><div><strong>{offline ? 'Your journal is available offline.' : 'Saved on this device.'}</strong><p>{queue.current ? 'Your changes are kept here and will sync when a connection is available.' : 'Showing the journal and Garmin readings saved on this device.'} Photo reading needs a connection.</p></div><button className="cal-button cal-button-small" disabled={saveState === 'saving'} onClick={() => void flushSave()}><Icon name="refresh" size={16}/>Sync now</button></div>}

      <main className="cal-main">
        <DraftRecovery onResume={resumeFormDraft} notice={recoveryNotice}/>
        {view === 'journal' && <>
          <section className="cal-page-heading">
            <div><div className="cal-eyebrow">{date === currentDay ? 'TODAY’S JOURNAL' : 'DAILY JOURNAL'}</div><h1>{readableDate(date, { weekday: 'long' })}<span className="cal-heading-dot">.</span></h1><p>{readableDate(date, { day: 'numeric', month: 'long', year: 'numeric' })} <span className="cal-date-divider">/</span> One day at a time.</p></div>
            <div className="cal-date-controls"><button className="cal-icon-button" onClick={() => openDay(addDays(date, -1))} aria-label="Previous day"><Icon name="left"/></button><label className="cal-date-picker"><Icon name="calendar" size={17}/><span aria-hidden="true">{readableDate(date, { day: 'numeric', month: 'short', year: 'numeric' })}</span><input type="date" aria-label="Choose journal date" value={date} onClick={event => { try { event.currentTarget.showPicker?.(); } catch { /* The native control still opens on focus. */ } }} onChange={event => { if (event.target.value) openDay(event.target.value); }}/></label><button className="cal-icon-button" onClick={() => openDay(addDays(date, 1))} aria-label="Next day"><Icon name="right"/></button>{date !== currentDay && <button className="cal-text-button cal-today" onClick={() => openDay(currentDay)}>Today</button>}</div>
          </section>

          <section className="cal-dashboard" aria-label="Daily nutrition summary">
            <div className="cal-energy-card">
              <div className="cal-card-top"><span className="cal-eyebrow">{date === currentDay ? 'ENERGY TODAY' : 'ENERGY THIS DAY'}</span><button className="cal-icon-button" onClick={() => setModal({ type: 'targets' })} aria-label="Edit daily targets" title="Edit daily targets"><Icon name="settings" size={19}/></button></div>
              <div className="cal-energy-main"><div><div className="cal-energy-value">{number(totals.calories)}<span>kcal</span></div><p>of {number(budget, 1)} kcal {burned.predicted ? 'predicted ' : ''}budget with carry</p></div><div className={`cal-ring${calorieProgress.overPercent > 0 ? ' cal-ring-over' : ''}`} style={{ '--cal-progress': `${calorieProgress.barPercent}%`, '--cal-over': `${calorieProgress.overPercent}%` } as React.CSSProperties}><div><span>{calorieProgress.percent === null ? '—' : <>{number(calorieProgress.percent)}<small>%</small></>}</span><small>{budget > 0 ? 'of budget' : 'no budget'}</small></div></div></div>
              <div className="cal-energy-bottom"><span>{remaining >= 0 ? 'Remaining' : 'Above budget'}<strong>{number(Math.abs(remaining), 1)} <small>kcal</small></strong></span><span>{burned.predicted ? 'Predicted burned' : burned.restingEstimate ? 'Estimated burned' : 'Burned'}<strong>{burned.unavailable ? '—' : number(burned.burned)} <small>kcal</small></strong></span><span>{burned.unavailable ? 'Deficit / surplus' : burned.predicted ? deficit >= 0 ? 'Predicted deficit' : 'Predicted surplus' : burned.restingEstimate ? deficit >= 0 ? 'Estimated deficit' : 'Estimated surplus' : deficit >= 0 ? 'Deficit' : 'Surplus'}<strong>{burned.unavailable ? '—' : number(Math.abs(deficit))} <small>kcal</small></strong></span></div>
              <div className="cal-target-note"><span>Deficit target: {number(targets.deficit, 1)} kcal</span><button className="cal-text-button" onClick={() => setModal({ type: 'targets' })}>Edit deficit target<Icon name="edit" size={13}/></button></div>
              <div className="cal-burned-source"><span className="cal-source-badge">{burnedLabel(burned)}</span>{burned.source === 'garmin' ? <div className="cal-burned-details"><span>{burnedFormula(burned)}</span>{burnedSyncDay && <small>{burnedSyncTime(burned)}{date === currentDay ? ' · Today is provisional' : ''}{garmin.status.state === 'not_connected' ? ' · Automatic imports stopped' : date === currentDay && staleImport(burnedSyncDay.synced_at) ? ' · Needs a new import' : ''}</small>}</div> : <span>Your saved manual calories burned value.</span>}</div>
            </div>
            <div className="cal-nutrients-card">
              <div className="cal-card-top"><span className="cal-eyebrow">DAILY NUTRIENT TARGETS</span><span className="cal-pill">grams</span></div>
              <div className="cal-macro-progress-list">
                <MacroProgressRow name="Protein" consumed={totals.protein} target={nutritionTargets.protein} tone="protein"/>
                <MacroProgressRow name="Carbs" consumed={totals.carbs} target={nutritionTargets.carbs} tone="carbs"/>
                <MacroProgressRow name="Fat" consumed={totals.fat} target={nutritionTargets.fat} tone="fat"/>
                <MacroProgressRow name="Fibre" consumed={totals.fiber} target={nutritionTargets.fiber} tone="fiber"/>
              </div>
              {nutritionTargets.budgetTooLow && <p className="cal-macro-budget-note">Current calorie budget is too low for {DAILY_PROTEIN_GRAMS} g protein and 25% fat. Carb target is 0 g.</p>}
            </div>
          </section>

          <section className="cal-carry-panel" aria-label="Running calorie balance">
            <div className="cal-carry-heading"><h2>Running calorie balance</h2><span>{burned.unavailable ? 'Waiting for Garmin' : selectedBalance?.settled ? 'Carried forward' : carryIsProvisional ? 'Future projection' : date === currentDay ? 'Today is provisional' : dayEntries.length ? 'Not settled yet' : 'Unlogged day'}</span></div>
            <div className="cal-carry-values"><span>Base budget<strong>{burned.unavailable ? '—' : number(allowance.baseBudget, 1)} <small>kcal</small></strong></span><span>Carry from last {CARRY_SPREAD_DAYS} days{carryIsProvisional ? ' (provisional)' : ''}<strong>{signedNumber(carryIn)} <small>kcal</small></strong></span><span>{selectedBalance ? 'Still to carry after this day' : 'Still to carry'}<strong>{burned.unavailable ? '—' : signedNumber(rawBalance)} <small>kcal</small></strong></span></div>
            <details className="cal-carry-details"><summary>How the running balance works</summary><p>Each logged day’s difference from its budget is spread evenly over the next {CARRY_SPREAD_DAYS} days: eating 700 kcal over takes 100 kcal off each of the next {CARRY_SPREAD_DAYS} budgets, and eating under adds it the same way. Eating exactly your budget adds nothing new. Completed logged days settle.{date === currentDay ? ledger.provisional ? ' Today’s balance is provisional and is included when previewing later days.' : dayEntries.length ? ' Today’s carry is waiting for calories burned.' : ' Today has no logged food, so it does not add to carry.' : !dayEntries.length ? ' This day has no logged food, so it does not add to carry.' : date > currentDay ? ' Planned future meals do not carry forward yet.' : ''}</p></details>
            {carryIsProvisional && <p>Includes today’s provisional balance; updates as food or Garmin data changes.</p>}
            {hasPendingLoggedDays && <p className="cal-carry-pending-note">Some logged days are waiting for Garmin data. Their balances are not included yet.</p>}
            {!burned.unavailable && allowance.deferredDebt > 0 && <p className="cal-carry-debt-note">If you eat this day’s {number(budget, 1)} kcal budget, {number(allowance.deferredDebt, 1)} kcal of debt remains for later days.</p>}
          </section>

          <button className={`cal-garmin-bar ${garmin.status.state === 'needs_login' || garmin.status.state === 'error' || (garmin.status.state === 'connected' && staleImport(garmin.status.last_sync_at)) || garminLoadError ? 'cal-garmin-attention' : ''}`} onClick={() => setModal({ type: 'garmin' })} aria-label="Garmin Connect settings">
            <span className="cal-garmin-symbol"><Icon name="watch" size={20}/></span><span className="cal-garmin-bar-text"><strong>Garmin Connect</strong><span>{garminLoading ? 'Checking imported data…' : garminLoadError ? 'Unable to refresh · saved readings retained' : garminStatusLabel(garmin.status)}{!garminLoading && !garminLoadError && garmin.status.last_sync_at ? ` · Last import ${syncTime(garmin.status.last_sync_at)}` : ''}</span></span><Icon name="right" size={18}/>
          </button>

          <section className="cal-journal-section">
            <div className="cal-section-heading"><div><h2>On the menu</h2><p>{dayEntries.length ? `${dayEntries.length} ${dayEntries.length === 1 ? 'entry' : 'entries'} logged${date === currentDay ? ' today' : ''}` : 'Your food, meal by meal.'}</p></div><button className="cal-button cal-button-primary" onClick={() => setModal({ type: 'entry' })}><Icon name="plus" size={18}/>Log food</button></div>
            {dayEntries.length === 0 ? <div className="cal-empty-journal"><span className="cal-empty-art"><Icon name="leaf" size={38}/><span/><span/></span><h3>A fresh page for {date === currentDay ? 'today' : 'this day'}.</h3><p>Choose a saved food or enter a manual estimate for a meal.</p><button className="cal-text-button" onClick={() => setModal({ type: 'entry' })}>Log your first food<Icon name="arrow" size={17}/></button></div>
              : <div className="cal-meals">{meals.map((meal, index) => {
                const entries = dayEntries.filter(entry => entry.meal === meal);
                const mealTotals = dayTotals(entries);
                return <div className="cal-meal" key={meal}><div className="cal-meal-heading"><span className="cal-meal-number">{String(index + 1).padStart(2, '0')}</span><h3>{meal}</h3><span>{number(mealTotals.calories)} kcal</span></div><div className="cal-entry-list">{entries.map(entry => <div className="cal-entry" key={entry.id}><div className="cal-entry-info"><strong>{entry.foodName}</strong><span>{entry.source === 'manual' ? 'Manual estimate' : <>{number(entry.quantity, 2)} {unitLabel(entry.unit, entry.quantity)}<i/> {entry.state}</>}</span></div><div className="cal-entry-macros"><span><b>P</b> {number(entry.protein, 1)}<small> g</small></span><span><b>C</b> {number(entry.carbs, 1)}<small> g</small></span><span><b>F</b> {number(entry.fat, 1)}<small> g</small></span><span><b>Fibre</b> {number(entry.fiber, 1)}<small> g</small></span></div><strong className="cal-entry-energy">{number(entry.calories)}<small> kcal</small></strong><div className="cal-entry-actions">{entry.source !== 'manual' && libraryIds.has(entry.foodId) && <button className="cal-icon-button" onClick={() => setModal({ type: 'entry', foodId: entry.foodId })} aria-label={`Log ${entry.foodName} again`} title="Log again"><Icon name="plus" size={16}/></button>}<button className="cal-icon-button" onClick={() => setModal({ type: 'entry', entry })} aria-label={`Edit ${entry.foodName}`}><Icon name="edit" size={16}/></button><button className="cal-icon-button" onClick={() => void removeEntry(entry.id)} aria-label={`Remove ${entry.foodName}`} title="Remove (you can undo)"><Icon name="trash" size={16}/></button></div></div>)}</div></div>;
              })}</div>}
          </section>
        </>}

        {view === 'bank' && <>
          <section className="cal-page-heading"><div><div className="cal-eyebrow">PREPARED FOR LATER</div><h1>Food bank<span className="cal-heading-dot">.</span></h1><p>Your portions, ready to log.</p></div></section>
          <FoodBankView portions={data.foodBank} onPrepare={() => setModal({ type: 'bank-prepare' })} onEat={portion => setModal({ type: 'bank-consume', portion })} onRemove={id => void removeBankPortion(id)}/>
        </>}

        {view === 'foods' && <>
          <section className="cal-page-heading"><div><div className="cal-eyebrow">YOUR OWN LITTLE LIBRARY</div><h1>Everyday foods<span className="cal-heading-dot">.</span></h1><p>Most logged in the last 14 days, first.</p></div><button className="cal-button cal-button-primary" onClick={() => setModal({ type: 'food' })}><Icon name="plus" size={18}/>Add food</button></section>
          <div className="cal-library-bar"><label className="cal-search"><Icon name="search" size={19}/><input type="search" placeholder="Find a food…" aria-label="Search food library" value={foodSearch} onChange={event => setFoodSearch(event.target.value)}/></label><span>{hiddenLibraryFoods ? <>Showing foods logged in the last {RECENT_FOOD_DAYS} days · <button className="cal-text-button" type="button" onClick={() => setShowAllLibrary(true)}>Show all {data.foods.length}</button></> : <>{data.foods.length} {data.foods.length === 1 ? 'food' : 'foods'} in your library{showAllLibrary && recentIds.size > 0 && !foodSearch.trim() && <> · <button className="cal-text-button" type="button" onClick={() => setShowAllLibrary(false)}>Show recent only</button></>}</>}</span></div>
          {visibleFoods.length ? <div className="cal-food-grid">{visibleFoods.map(food => <article className="cal-food-card" key={food.id}><div className="cal-food-heading"><span className="cal-food-state">{food.state}</span><div>{deleteFoodId === food.id ? <button className="cal-text-button" onClick={() => setDeleteFoodId(null)}>Cancel</button> : <button className="cal-icon-button" onClick={() => setModal({ type: 'food', food })} aria-label={`Edit ${food.name}`}><Icon name="edit" size={17}/></button>}</div></div><h2>{food.name}</h2><p>Per {number(food.baseQuantity, 2)} {unitLabel(food.unit, food.baseQuantity)}</p><div className="cal-food-energy"><strong>{number(food.calories)}</strong><span>kcal</span></div><div className="cal-food-macros"><span>Protein<strong>{number(food.protein, 1)} g</strong></span><span>Carbs<strong>{number(food.carbs, 1)} g</strong></span><span>Fat<strong>{number(food.fat, 1)} g</strong></span><span>Fibre<strong>{number(food.fiber, 1)} g</strong></span></div><div className="cal-food-footer">{deleteFoodId === food.id ? <><p>Existing log entries will be kept.</p><button className="cal-text-button cal-danger" onClick={() => void removeFood(food.id)}>Remove food</button></> : <><button className="cal-text-button" onClick={() => setModal({ type: 'entry', foodId: food.id })}>Log this food<Icon name="plus" size={16}/></button><button className="cal-icon-button" onClick={() => setDeleteFoodId(food.id)} aria-label={`Remove ${food.name} from library`}><Icon name="trash" size={16}/></button></>}</div></article>)}</div> : <div className="cal-empty-journal cal-library-empty"><span className="cal-empty-art"><Icon name="book" size={36}/></span><h3>{foodSearch ? 'No foods found.' : 'Your favourites start here.'}</h3><p>{foodSearch ? 'Try a different name, or add a new food.' : 'Use the nutrition on your food label to build a library that feels like you.'}</p><button className="cal-text-button" onClick={() => setModal({ type: 'food' })}>Add a food<Icon name="plus" size={17}/></button></div>}
        </>}

        {view === 'trends' && <Suspense fallback={<div className="cal-loading" role="status"><span className="cal-spinner"/></div>}><TrendsView data={data} garminDays={garmin.days} currentDay={currentDay} onApplyDeficit={applyPlanDeficit} notice={trendsNotice}/></Suspense>}

        {view === 'history' && <>
          <section className="cal-page-heading"><div><div className="cal-eyebrow">THE DAYS ADD UP</div><h1>Your history<span className="cal-heading-dot">.</span></h1><p>A simple record, whenever you need it.</p></div><button className="cal-button" onClick={() => setModal({ type: 'transfer' })}><Icon name="download" size={18}/>Export journal</button></section>
          {hasPendingLoggedDays && <p className="cal-history-pending-note">Some logged days are waiting for Garmin data. Their balances are not included yet.</p>}
          {historyDates.length ? <div className="cal-history">
            <div className="cal-history-header"><span>Day</span><span>Energy</span><span className="cal-history-protein">Protein</span><span className="cal-history-deficit">Deficit / surplus</span><span className="cal-history-balance">Still to carry</span><span/></div>
            {historyDates.slice(0, historyLimit).map(day => {
              const entries = entriesByDate.get(day) ?? NO_ENTRIES;
              const dayTotal = dayTotals(entries);
              const goals = settingsForDay(data, day, entries.length > 0);
              const dayBurned = effectiveBurned(day, goals, garmin.days, currentDay);
              const dayDeficit = dayBurned.burned - dayTotal.calories;
              const balance = ledger.days[day];
              return <button className="cal-history-row" key={day} onClick={() => openDay(day)}>
                <span><strong>{readableDate(day, { weekday: 'short', day: 'numeric', month: 'short' })}</strong><small className="cal-history-mobile-summary">{number(dayTotal.protein, 1)} g protein{entries.length && !dayBurned.unavailable ? ` · ${number(Math.abs(dayDeficit))} kcal ${dayDeficit >= 0 ? 'deficit' : 'surplus'}` : ''}</small><small>{entries.length} {entries.length === 1 ? 'entry' : 'entries'} · {day.slice(0, 4)}<em className="cal-history-source">{burnedLabel(dayBurned)}{dayBurned.source === 'garmin' && !dayBurned.unavailable && day === currentDay ? ' · provisional' : ''}</em>{dayBurned.restingEstimate && dayBurned.restingDay && <em className="cal-history-source">Resting from {readableDate(dayBurned.restingDay.date, { day: 'numeric', month: 'short', year: 'numeric' })} · {burnedSyncTime(dayBurned)}</em>}</small></span>
                <span><strong>{number(dayTotal.calories, 1)}</strong><small> kcal</small></span>
                <span className="cal-history-protein"><strong>{number(dayTotal.protein, 1)}</strong><small> g</small></span>
                <span className="cal-history-deficit"><strong>{entries.length && !dayBurned.unavailable ? number(Math.abs(dayDeficit), 1) : '—'}</strong><small>{dayBurned.unavailable ? 'Burned unavailable' : entries.length ? ` kcal ${dayBurned.restingEstimate ? 'estimated ' : ''}${dayDeficit >= 0 ? 'deficit' : 'surplus'}` : ' Unlogged'}</small></span>
                <span className="cal-history-balance"><strong>{balance?.available ? signedNumber(balance.balance) : '—'}</strong><small>{balance ? !balance.available ? 'Waiting for Garmin' : `kcal · ${balance.settled ? 'carried forward' : day === currentDay ? 'provisional' : ledger.provisional && day > ledger.provisional.date ? 'planned · provisional carry' : 'not settled'}` : 'No logged food'}</small></span>
                <Icon name="right" size={18}/>
              </button>;
            })}
          </div> : null}
          {historyDates.length > historyLimit && <button className="cal-button cal-history-more" onClick={() => setHistoryLimit(limit => limit + HISTORY_PAGE)}>Show older days ({number(historyDates.length - historyLimit)} more)</button>}
          {historyDates.length ? null : <div className="cal-empty-journal"><span className="cal-empty-art"><Icon name="calendar" size={36}/></span><h3>Your story is just beginning.</h3><p>Days you log will appear here, with your daily totals and running calorie balance.</p><button className="cal-text-button" onClick={() => openDay(currentDay)}>Go to today<Icon name="arrow" size={17}/></button></div>}

        </>}
        <footer className="cal-footer"><span>A little more aware, every day.</span><span>Personal journal · <a href="/">xingkai03</a></span></footer>
      </main>

      {view === 'journal' && !modal && <button className={`cal-fab${undoNotice ? ' cal-fab-raised' : ''}`} onClick={() => setModal({ type: 'entry' })}><Icon name="plus" size={20}/>Log food</button>}

      {undoNotice && <UndoNotice id={undoNotice.action.id} message={undoNotice.message} active={!modal} onUndo={() => undoLatest(undoNotice.action, undoNotice.scope)} onDismiss={() => setUndoNotice(current => current?.action.id === undoNotice.action.id ? null : current)}/>}

      {modal && <Modal onClose={() => setModal(null)}><Suspense fallback={<div className="cal-loading" role="status"><span className="cal-spinner"/><p>Opening…</p></div>}>{modal.type === 'entry' ? <EntryEditor key={modal.entry?.id ?? modal.foodId ?? 'new-entry'} entry={modal.entry} initialFoodId={modal.foodId} initialMeal={modal.meal} lastQuantities={lastQuantities} recentFoodIds={recentIds} foods={sortedFoods} date={date} onSave={saveEntry} readMealPhoto={(input, signal) => client.estimateMealPhoto(input, signal)} onAddFood={() => setModal({ type: 'food', returnToLog: true })} onFoodBank={openFoodBank} bankCount={data.foodBank.length} onClose={() => setModal(null)}/>
        : modal.type === 'food' ? <FoodEditor key={modal.food?.id ?? 'new-food'} food={modal.food} readPhotos={(input, signal) => client.readFoodPhotos(input, signal)} onSave={saveFood} onClose={() => setModal(null)}/>
        : modal.type === 'bank-prepare' ? <FoodBankEditor foods={sortedFoods} onSave={saveBankPortions} onClose={() => setModal(null)}/>
        : modal.type === 'bank-consume' ? <FoodBankConsume portion={modal.portion} date={date} onSave={(entryDate, meal) => eatBankPortion(modal.portion.id, entryDate, meal)} onClose={() => setModal(null)}/>
        : modal.type === 'targets' ? <TargetsEditor date={date} currentDay={currentDay} settings={targets} defaultSettings={data.defaults} garminDays={garmin.days} carryIn={carryIn} carryIsProvisional={carryIsProvisional} onSave={async (settings, makeDefault, originalRecordJson, originalDefaultsJson) => {
          if (!(await updateData(current => {
            assertCurrentRecord(settingsForDay(current, date), originalRecordJson, settings, 'these daily targets');
            const defaults = makeDefault ? { ...current.defaults, deficit: settings.deficit, protein: DAILY_PROTEIN_GRAMS } : current.defaults;
            if (makeDefault) assertCurrentRecord(current.defaults, originalDefaultsJson, defaults, 'the default targets');
            return { ...current, days: { ...current.days, [date]: settings }, defaults };
          }))) throw new Error(lastLocalError.current);
          setModal(null);
        }} onClose={() => setModal(null)}/>
        : modal.type === 'garmin' ? <GarminConnection date={date} currentDay={currentDay} snapshot={garmin} loading={garminLoading || garminDisconnecting} disconnecting={garminDisconnecting} error={garminLoadError} onRefresh={() => void refreshGarmin(true)} onDisconnect={() => void disconnectGarmin()} onClose={() => setModal(null)}/>
        : <TransferDialog data={queue.current ?? data} onImport={async (next) => { if (!(await updateData(() => next))) throw new Error('The backup could not be saved on this device.'); setUndoNotice(null); setModal(null); }} onClose={() => setModal(null)}/>}</Suspense></Modal>}
    </FormDraftProvider>}
  </div>;
}

function DraftRecovery({ onResume, notice }: { onResume: (draft: FormDraftSummary) => void; notice: string }) {
  const { drafts, discard } = useFormDrafts();
  if (!drafts.length) return null;
  return <section className="cal-draft-recovery" aria-label="Unfinished drafts"><div><strong>Pick up where you left off</strong><p>Your unfinished forms are saved on this device.</p></div>{notice && <p role="status">{notice}</p>}<ul>{drafts.map(draft => <li key={draft.key}><span>{draft.label}</span><div><button className="cal-text-button" onClick={() => onResume(draft)}>Resume<span className="cal-sr-only"> {draft.label}</span></button><button className="cal-icon-button" onClick={() => discard(draft.key)} aria-label={`Discard ${draft.label} draft`}><Icon name="close" size={16}/></button></div></li>)}</ul></section>;
}

function MacroProgressRow({ name, consumed, target, tone }: { name: string; consumed: number; target: number; tone: 'protein' | 'carbs' | 'fat' | 'fiber' }) {
  const progress = nutrientProgress(consumed, target);
  const percent = progress.percent === null ? '—' : `${number(progress.percent, 1)}%`;
  const remaining = target - consumed;
  const detail = target === 0 ? consumed > 0 ? `${number(consumed, 1)} g over a zero target` : 'Target is 0 g for this budget' : remaining > 0 ? `${number(remaining, 1)} g remaining` : remaining < 0 ? `${number(-remaining, 1)} g over target` : 'Target reached';
  return <div className={`cal-macro-progress-row cal-macro-tone-${tone}`}>
    <div className="cal-macro-progress-heading"><span className="cal-macro-name">{name}</span><span className="cal-macro-consumed"><strong>{number(consumed, 1)}</strong><small> / {number(target, 1)} g</small></span><span className="cal-macro-percentage" aria-label={progress.percent === null ? `${name} percentage unavailable` : `${number(progress.percent, 1)} percent of ${name.toLowerCase()} target consumed`}>{percent}</span></div>
    <div className="cal-progress-track" role="progressbar" aria-label={`${name} target progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.barPercent} aria-valuetext={`${number(consumed, 1)} of ${number(target, 1)} grams; ${progress.percent === null ? 'percentage unavailable' : `${number(progress.percent, 1)} percent of target consumed`}`}><span style={{ width: `${progress.barPercent}%` }}/></div>
    <p className={remaining < 0 ? 'cal-macro-over' : ''}>{detail}</p>
  </div>;
}

function Setup({ onConfigure }: { onConfigure: (config: { url: string; key: string; email?: string }) => void }) {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try { onConfigure({ url: url.trim(), key: key.trim() }); }
    catch (error) { setError(errorMessage(error)); }
  }
  return <div className="cal-auth-card cal-setup-card"><div className="cal-eyebrow">ONE-TIME DEVICE SETUP</div><h1>Connect your<br/>private journal.</h1><p className="cal-auth-intro">Your journal uses your Supabase project to keep your iPhone and Mac in sync.</p><div className="cal-setup-guide"><Icon name="book" size={19}/><div><strong>Set up your project first</strong><p>Follow the short guide to create your database and personal account.</p><a href="/calories-setup/" target="_blank" rel="noreferrer">Open setup guide ↗</a></div></div><form className="cal-form" onSubmit={submit}><label>Supabase project URL<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://your-project.supabase.co" autoComplete="off" autoCapitalize="none" spellCheck={false} required/></label><label>Publishable / anon key<textarea value={key} onChange={event => setKey(event.target.value)} placeholder="Paste your public project key" spellCheck={false} required rows={3}/><small className="cal-field-hint">Use only the public publishable or anon key. Never use a service-role or secret key.</small></label>{error && <p className="cal-form-error" role="alert">{error}</p>}<button className="cal-button cal-button-primary cal-button-full">Connect journal<Icon name="arrow" size={18}/></button></form><p className="cal-setup-note">Connection details are saved on this device. Your account password protects access to your data.</p></div>;
}

function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; element?.close(); };
  }, []);
  return <dialog className="cal-dialog" aria-labelledby="cal-dialog-title" ref={dialog} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) { const rect = dialog.current.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><div className="cal-modal-content">{children}</div></dialog>;
}

