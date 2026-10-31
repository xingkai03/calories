import { lazy, Suspense, useMemo, useState } from 'react';
import { dayTotals, settingsForDay, type Entry, type TrackerData } from '../../lib/calories/model';
import { effectiveBurned, type GarminDay } from '../../lib/calories/garmin';
import type { CalorieLedger } from '../../lib/calories/budget';
import { Icon, number, signedNumber, readableDate, burnedLabel, burnedSyncTime } from './ui';
import { t } from '../../lib/calories/i18n';

const TrendsView = lazy(() => import('./TrendsView'));
const HISTORY_PAGE = 60;
const NO_ENTRIES: Entry[] = [];

/** Trends and the planner, then every logged or configured day with its totals and running balance. */
export default function SummaryView({ data, garminDays, currentDay, ledger, entriesByDate, trendsNotice, onApplyDeficit, onOpenDay, onExport }: {
  data: TrackerData; garminDays: GarminDay[]; currentDay: string; ledger: CalorieLedger; entriesByDate: ReadonlyMap<string, Entry[]>;
  trendsNotice: string; onApplyDeficit: (deficit: number) => Promise<void>; onOpenDay: (date: string) => void; onExport: () => void;
}) {
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const historyDates = useMemo(() => [...new Set([...entriesByDate.keys(), ...Object.keys(data.days)])].sort().reverse(), [entriesByDate, data.days]);
  const hasPendingLoggedDays = Object.values(ledger.days).some(row => row.date < currentDay && !row.available);
  return <>
    <h1 className="cal-sr-only">{t('Summary')}</h1>
    <Suspense fallback={<div className="cal-loading" role="status"><span className="cal-spinner"/></div>}><TrendsView data={data} garminDays={garminDays} currentDay={currentDay} onApplyDeficit={onApplyDeficit} notice={trendsNotice}/></Suspense>
    <div className="cal-section-heading cal-summary-days"><h2>{t('Days')}</h2><button className="cal-button" onClick={onExport}><Icon name="download" size={18}/>{t('Export journal')}</button></div>
    {hasPendingLoggedDays && <p className="cal-history-pending-note">{t('Some logged days are waiting for Garmin data. Their balances are not included yet.')}</p>}
    {historyDates.length ? <div className="cal-history">
      <div className="cal-history-header"><span>{t('Day')}</span><span>{t('Energy')}</span><span className="cal-history-protein">{t('Protein')}</span><span className="cal-history-deficit">{t('Deficit / surplus')}</span><span className="cal-history-balance">{t('Still to carry')}</span><span/></div>
      {historyDates.slice(0, historyLimit).map(day => {
        const entries = entriesByDate.get(day) ?? NO_ENTRIES;
        const dayTotal = dayTotals(entries);
        const goals = settingsForDay(data, day, entries.length > 0);
        const dayBurned = effectiveBurned(day, goals, garminDays, currentDay);
        const dayDeficit = dayBurned.burned - dayTotal.calories;
        const balance = ledger.days[day];
        return <button className="cal-history-row" key={day} onClick={() => onOpenDay(day)}>
          <span><strong>{readableDate(day, { weekday: 'short', day: 'numeric', month: 'short' })}</strong><small className="cal-history-mobile-summary">{t('{amount} g protein', { amount: number(dayTotal.protein, 1) })}{entries.length && !dayBurned.unavailable ? ` · ${t(dayDeficit >= 0 ? '{amount} kcal deficit' : '{amount} kcal surplus', { amount: number(Math.abs(dayDeficit)) })}` : ''}</small><small>{t(entries.length === 1 ? '{count} entry' : '{count} entries', { count: entries.length })} · {day.slice(0, 4)}<em className="cal-history-source">{burnedLabel(dayBurned)}{dayBurned.source === 'garmin' && !dayBurned.unavailable && day === currentDay ? ` · ${t('provisional')}` : ''}</em>{dayBurned.restingEstimate && dayBurned.restingDay && <em className="cal-history-source">{t('Resting from {date}', { date: readableDate(dayBurned.restingDay.date, { day: 'numeric', month: 'short', year: 'numeric' }) })} · {burnedSyncTime(dayBurned)}</em>}</small></span>
          <span><strong>{number(dayTotal.calories, 1)}</strong><small> kcal</small></span>
          <span className="cal-history-protein"><strong>{number(dayTotal.protein, 1)}</strong><small> g</small></span>
          <span className="cal-history-deficit"><strong>{entries.length && !dayBurned.unavailable ? number(Math.abs(dayDeficit), 1) : '—'}</strong><small>{dayBurned.unavailable ? t('Burned unavailable') : entries.length ? ` ${t(dayBurned.restingEstimate ? dayDeficit >= 0 ? 'kcal estimated deficit' : 'kcal estimated surplus' : dayDeficit >= 0 ? 'kcal deficit' : 'kcal surplus')}` : ` ${t('Unlogged')}`}</small></span>
          <span className="cal-history-balance"><strong>{balance?.available ? signedNumber(balance.balance) : '—'}</strong><small>{balance ? !balance.available ? t('Waiting for Garmin') : `kcal · ${t(balance.settled ? 'carried forward' : day === currentDay ? 'provisional' : ledger.provisional && day > ledger.provisional.date ? 'planned · provisional carry' : 'not settled')}` : t('No logged food')}</small></span>
          <Icon name="right" size={18}/>
        </button>;
      })}
    </div> : null}
    {historyDates.length > historyLimit && <button className="cal-button cal-history-more" onClick={() => setHistoryLimit(limit => limit + HISTORY_PAGE)}>{t('Show older days ({count} more)', { count: number(historyDates.length - historyLimit) })}</button>}
    {historyDates.length ? null : <div className="cal-empty-journal"><span className="cal-empty-art"><Icon name="calendar" size={36}/></span><h3>{t('No days logged yet.')}</h3><p>{t('Days you log will appear here, with your daily totals and running calorie balance.')}</p><button className="cal-text-button" onClick={() => onOpenDay(currentDay)}>{t('Go to today')}<Icon name="arrow" size={17}/></button></div>}

  </>;
}
