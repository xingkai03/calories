import { useEffect, useMemo, useState } from 'react';
import type { TrackerData } from '../../lib/calories/model';
import type { GarminDay } from '../../lib/calories/garmin';
import { KCAL_PER_KG, planForRate, summarizeTrend, trendDays } from '../../lib/calories/trends';
import { DAILY_PROTEIN_GRAMS } from '../../lib/calories/nutrition';
import { errorMessage, number, readableDate } from './ui';
import { t } from '../../lib/calories/i18n';
import './trends.css';

const SPANS = [7, 14, 30] as const;
const PAD = { top: 12, right: 8, bottom: 26, left: 38 };

/** A phone draws a narrower chart, so its labels stay readable instead of shrinking with the SVG. */
function useNarrowScreen() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 600px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

export default function TrendsView({ data, garminDays, currentDay, onApplyDeficit, notice }: { data: TrackerData; garminDays: readonly GarminDay[]; currentDay: string; onApplyDeficit: (deficit: number) => Promise<void>; notice: string }) {
  const narrow = useNarrowScreen();
  const W = narrow ? 360 : 640, H = narrow ? 240 : 220;
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [span, setSpan] = useState<(typeof SPANS)[number]>(14);
  const [rate, setRate] = useState(0.5);
  const days = useMemo(() => trendDays(data, garminDays, span, currentDay), [data, garminDays, span, currentDay]);
  const summary = useMemo(() => summarizeTrend(days), [days]);

  const top = Math.max(1000, ...days.map(day => Math.max(day.eaten, day.burned ?? 0)));
  const max = Math.ceil(top / 500) * 500;
  const innerW = W - PAD.left - PAD.right, innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / days.length;
  const barW = Math.max(3, Math.min(26, slot * 0.62));
  const x = (index: number) => PAD.left + slot * index + slot / 2;
  const y = (value: number) => PAD.top + innerH - (value / max) * innerH;
  const burnPath = days.map((day, index) => day.burned === null ? null : `${x(index)},${y(day.burned)}`);
  // Build polyline segments that break across unknown days.
  const segments: string[][] = [[]];
  for (const point of burnPath) { if (point === null) { if (segments[segments.length - 1].length) segments.push([]); } else segments[segments.length - 1].push(point); }
  const labelEvery = narrow ? (span === 7 ? 1 : span === 14 ? 3 : 7) : (span === 7 ? 1 : span === 14 ? 2 : 5);

  const avgBurned = summary.avgBurned;
  const plan = avgBurned === null ? null : planForRate(avgBurned, rate);
  const weekly = summary.kgPerWeek;

  return <>
    <div className="cal-trends-range" role="group" aria-label={t('Time range')}>{SPANS.map(option => <button key={option} type="button" aria-pressed={span === option} onClick={() => setSpan(option)}>{t('{count} days', { count: option })}</button>)}</div>

    {summary.loggedDays === 0 ? <div className="cal-empty-journal"><h3>{t('Nothing to chart yet.')}</h3><p>{t('Log food on a few days and your averages and projections will appear here.')}</p></div> : <>
      <section className="cal-trends-stats" aria-label={t('Averages')}>
        <div className="cal-trends-stat"><span>{t('Avg intake')}</span><strong>{summary.avgEaten === null ? '—' : number(summary.avgEaten)} <small>kcal</small></strong></div>
        <div className="cal-trends-stat"><span>{t('Avg protein')}</span><strong>{summary.avgProtein === null ? '—' : number(summary.avgProtein)} <small>g</small></strong></div>
        <div className="cal-trends-stat"><span>{t('Avg deficit')}</span><strong>{summary.avgDeficit === null ? '—' : number(summary.avgDeficit)} <small>kcal</small></strong></div>
        <div className="cal-trends-stat"><span>{t('Logged')}</span><strong>{summary.loggedDays} <small>{t('of {count} days', { count: span })}</small></strong></div>
      </section>

      <section className="cal-trends-chart-card" aria-label={t('Intake against calories burned')}>
        <h2>{t('Intake vs burned')}</h2>
        <p>{weekly === null ? t('Waiting for calories-burned data to estimate a rate.') : t(weekly >= 0 ? summary.measuredDays === 1 ? 'At this pace: about {rate} kg per week lost ({kg} kg over {days} measured day). Estimate uses {kcal} kcal per kg.' : 'At this pace: about {rate} kg per week lost ({kg} kg over {days} measured days). Estimate uses {kcal} kcal per kg.' : summary.measuredDays === 1 ? 'At this pace: about +{rate} kg per week gained ({kg} kg over {days} measured day). Estimate uses {kcal} kcal per kg.' : 'At this pace: about +{rate} kg per week gained ({kg} kg over {days} measured days). Estimate uses {kcal} kcal per kg.', { rate: number(Math.abs(weekly), 2), kg: number(Math.abs(summary.estimatedKg ?? 0), 1), days: summary.measuredDays, kcal: number(KCAL_PER_KG) })}</p>
        <svg className="cal-trends-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Daily intake bars and calories burned line for the last {count} days', { count: span })}>
          {[0, 0.25, 0.5, 0.75, 1].map(fraction => <g key={fraction}><line className="cal-trends-grid" x1={PAD.left} x2={W - PAD.right} y1={y(max * fraction)} y2={y(max * fraction)}/><text x={PAD.left - 6} y={y(max * fraction) + 3} textAnchor="end">{number(max * fraction)}</text></g>)}
          {days.map((day, index) => day.logged && <rect key={day.date} className={`cal-trends-bar${day.burned !== null && day.eaten > day.burned ? ' is-over' : ''}`} x={x(index) - barW / 2} y={y(day.eaten)} width={barW} height={Math.max(1, y(0) - y(day.eaten))} rx="3"><title>{`${readableDate(day.date, { day: 'numeric', month: 'short' })}: ${t('{amount} kcal eaten', { amount: number(day.eaten) })}${day.burned === null ? '' : `${t(', ')}${t('{amount} burned', { amount: number(day.burned) })}`}`}</title></rect>)}
          {segments.filter(points => points.length > 1).map((points, index) => <polyline key={index} className="cal-trends-burn" points={points.join(' ')}/>)}
          {segments.filter(points => points.length === 1).map((points, index) => { const [px, py] = points[0].split(','); return <circle key={`dot-${index}`} cx={px} cy={py} r="3" fill="var(--cal-green)"/>; })}
          {days.map((day, index) => (days.length - 1 - index) % labelEvery === 0 && <text key={day.date} x={x(index)} y={H - 8} textAnchor="middle">{readableDate(day.date, { day: 'numeric', month: 'short' })}</text>)}
        </svg>
        <div className="cal-trends-legend"><span><i/>{t('Eaten')}</span><span><i className="is-over"/>{t('Eaten above burned')}</span><span><i className="is-line"/>{t('Burned')}</span></div>
      </section>
    </>}

    <section className="cal-plan-card" aria-label={t('Diet plan')}>
      <h2>{t('Plan your next stretch')}</h2>
      {plan === null ? <p>{t('A plan appears once there is a calories-burned reading from the last {count} days.', { count: span })}</p> : <>
        <p>{t('Pick a weekly pace. The budget follows your average burn of {kcal} kcal and the app’s own macro rules.', { kcal: number(avgBurned ?? 0) })}</p>
        <div className="cal-plan-rate"><label htmlFor="cal-plan-rate">{t('Weekly loss')}</label><input id="cal-plan-rate" type="range" min="0" max="1" step="0.05" value={rate} onChange={event => setRate(Number(event.target.value))} aria-valuetext={t('{rate} kilograms per week', { rate: number(rate, 2) })}/><output htmlFor="cal-plan-rate">{t('{rate} kg / week', { rate: number(rate, 2) })}</output></div>
        <div className="cal-plan-grid">
          <span>{t('Daily budget')}<strong>{number(plan.budget)}</strong>kcal</span>
          <span>{t('Deficit')}<strong>{number(plan.deficit)}</strong>kcal</span>
          <span>{t('Protein')}<strong>{number(plan.macros.protein)}</strong>g</span>
          <span>{t('Carbs')}<strong>{number(plan.macros.carbs)}</strong>g</span>
          <span>{t('Fat')}<strong>{number(plan.macros.fat)}</strong>g</span>
        </div>
        {plan.capped && <p className="cal-plan-note">{t('Capped at the app’s 1,000 kcal daily deficit, so the real pace is about {rate} kg per week.', { rate: number(plan.kgPerWeek, 2) })}</p>}
        {plan.macros.budgetTooLow && <p className="cal-plan-note">{t('This budget is too low for {protein} g protein and 25% fat, so carbs show 0 g.', { protein: DAILY_PROTEIN_GRAMS })}</p>}
        <div className="cal-plan-apply"><button type="button" className="cal-button cal-button-primary" disabled={applying} onClick={async () => { setApplying(true); setApplyError(''); try { await onApplyDeficit(plan.deficit); } catch (error) { setApplyError(errorMessage(error)); } finally { setApplying(false); } }}>{applying ? t('Saving…') : t('Use {kcal} kcal as my deficit', { kcal: number(Math.round(plan.deficit)) })}</button>{notice && <p role="status">{notice}</p>}{applyError && <p className="cal-form-error" role="alert">{applyError}</p>}</div>
        <p className="cal-plan-note">{t('Applies to today and to new days. Days with their own saved targets keep them. Estimates only; this is not medical advice.')}</p>
      </>}
    </section>
  </>;
}
