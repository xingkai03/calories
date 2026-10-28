import { useMemo } from 'react';
import { addDays, dayTotals, type DaySettings, type Entry } from '../../lib/calories/model';
import type { EffectiveBurned, GarminSnapshot } from '../../lib/calories/garmin';
import { DAILY_PROTEIN_GRAMS, macroTargets, nutrientProgress } from '../../lib/calories/nutrition';
import { adjustedBudget, outstandingAfter, CARRY_SPREAD_DAYS, type CalorieLedger } from '../../lib/calories/budget';
import { Icon, number, signedNumber, readableDate, syncTime, burnedLabel, burnedFormula, burnedSyncTime, staleImport, garminStatusLabel, amountLabel } from './ui';
import type { ModalState } from './CaloriesApp';

/** One day: its energy budget with carry, nutrient targets, running balance and logged meals. */
export default function JournalView({ date, currentDay, dayEntries, targets, burned, ledger, carryIn, carryIsProvisional, garmin, garminLoading, garminLoadError, libraryIds, onOpenDay, onModal, onRemoveEntry }: {
  date: string; currentDay: string; dayEntries: Entry[]; targets: DaySettings; burned: EffectiveBurned; ledger: CalorieLedger; carryIn: number; carryIsProvisional: boolean;
  garmin: GarminSnapshot; garminLoading: boolean; garminLoadError: string; libraryIds: ReadonlySet<string>;
  onOpenDay: (date: string) => void; onModal: (modal: NonNullable<ModalState>) => void; onRemoveEntry: (id: string) => Promise<void>;
}) {
  const totals = useMemo(() => dayTotals(dayEntries), [dayEntries]);
  const meals = useMemo(() => [...new Set(dayEntries.map(entry => entry.meal))], [dayEntries]);
  const burnedSyncDay = burned.day ?? burned.restingDay;
  const allowance = adjustedBudget(burned.burned, targets.deficit, carryIn);
  const budget = allowance.budget;
  const remaining = budget - totals.calories;
  const selectedBalance = ledger.days[date];
  const rawBalance = selectedBalance ? selectedBalance.balance : outstandingAfter(date, ledger);
  const hasPendingLoggedDays = Object.values(ledger.days).some(row => row.date < currentDay && !row.available);
  const deficit = burned.burned - totals.calories;
  const calorieProgress = nutrientProgress(totals.calories, budget);
  const nutritionTargets = macroTargets(budget);
  return <>
    <section className="cal-page-heading">
      <div><h1>{readableDate(date, { weekday: 'long' })}<span className="cal-heading-dot">.</span></h1><p>{readableDate(date, { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
      <div className="cal-date-controls"><button className="cal-icon-button" onClick={() => onOpenDay(addDays(date, -1))} aria-label="Previous day"><Icon name="left"/></button><label className="cal-date-picker"><Icon name="calendar" size={17}/><span aria-hidden="true">{readableDate(date, { day: 'numeric', month: 'short', year: 'numeric' })}</span><input type="date" aria-label="Choose journal date" value={date} onClick={event => { try { event.currentTarget.showPicker?.(); } catch { /* The native control still opens on focus. */ } }} onChange={event => { if (event.target.value) onOpenDay(event.target.value); }}/></label><button className="cal-icon-button" onClick={() => onOpenDay(addDays(date, 1))} aria-label="Next day"><Icon name="right"/></button>{date !== currentDay && <button className="cal-text-button cal-today" onClick={() => onOpenDay(currentDay)}>Today</button>}</div>
    </section>

    <section className="cal-dashboard" aria-label="Daily nutrition summary">
      <div className="cal-energy-card">
        <div className="cal-card-top"><span className="cal-eyebrow">{date === currentDay ? 'ENERGY TODAY' : 'ENERGY THIS DAY'}</span><button className="cal-icon-button" onClick={() => onModal({ type: 'targets' })} aria-label="Edit daily targets" title="Edit daily targets"><Icon name="settings" size={19}/></button></div>
        <div className="cal-energy-main"><div><div className="cal-energy-value">{number(totals.calories)}<span>kcal</span></div><p>of {number(budget, 1)} kcal {burned.predicted ? 'predicted ' : ''}budget with carry</p></div><div className={`cal-ring${calorieProgress.overPercent > 0 ? ' cal-ring-over' : ''}`} style={{ '--cal-progress': `${calorieProgress.barPercent}%`, '--cal-over': `${calorieProgress.overPercent}%` } as React.CSSProperties}><div><span>{calorieProgress.percent === null ? '—' : <>{number(calorieProgress.percent)}<small>%</small></>}</span><small>{budget > 0 ? 'of budget' : 'no budget'}</small></div></div></div>
        <div className="cal-energy-bottom"><span>{remaining >= 0 ? 'Remaining' : 'Above budget'}<strong>{number(Math.abs(remaining), 1)} <small>kcal</small></strong></span><span>{burned.predicted ? 'Predicted burned' : burned.restingEstimate ? 'Estimated burned' : 'Burned'}<strong>{burned.unavailable ? '—' : number(burned.burned)} <small>kcal</small></strong></span><span>{burned.unavailable ? 'Deficit / surplus' : burned.predicted ? deficit >= 0 ? 'Predicted deficit' : 'Predicted surplus' : burned.restingEstimate ? deficit >= 0 ? 'Estimated deficit' : 'Estimated surplus' : deficit >= 0 ? 'Deficit' : 'Surplus'}<strong>{burned.unavailable ? '—' : number(Math.abs(deficit))} <small>kcal</small></strong></span></div>
        <div className="cal-target-note"><span>Deficit target: {number(targets.deficit, 1)} kcal</span><button className="cal-text-button" onClick={() => onModal({ type: 'targets' })}>Edit deficit target<Icon name="edit" size={13}/></button>{date === currentDay && burned.requestedSource === 'garmin' && <button className="cal-text-button" onClick={() => onModal({ type: 'targets' })}>{targets.activeEstimate === undefined ? 'Estimate active calories' : 'Edit active estimate'}<Icon name="edit" size={13}/></button>}</div>
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

    <button className={`cal-garmin-bar ${garmin.status.state === 'needs_login' || garmin.status.state === 'error' || (garmin.status.state === 'connected' && staleImport(garmin.status.last_sync_at)) || garminLoadError ? 'cal-garmin-attention' : ''}`} onClick={() => onModal({ type: 'garmin' })} aria-label="Garmin Connect settings">
      <span className="cal-garmin-symbol"><Icon name="watch" size={20}/></span><span className="cal-garmin-bar-text"><strong>Garmin Connect</strong><span>{garminLoading ? 'Checking imported data…' : garminLoadError ? 'Unable to refresh · saved readings retained' : garminStatusLabel(garmin.status)}{!garminLoading && !garminLoadError && garmin.status.last_sync_at ? ` · Last import ${syncTime(garmin.status.last_sync_at)}` : ''}</span></span><Icon name="right" size={18}/>
    </button>

    <section className="cal-journal-section">
      <div className="cal-section-heading cal-section-actions"><h2 className="cal-sr-only">Meals</h2><button className="cal-button cal-button-primary" onClick={() => onModal({ type: 'entry' })}><Icon name="plus" size={18}/>Log food</button></div>
      {dayEntries.length === 0 ? <div className="cal-empty-journal"><span className="cal-empty-art"><Icon name="leaf" size={38}/><span/><span/></span><h3>No food logged {date === currentDay ? 'today' : 'this day'}.</h3><p>Choose a saved food or enter a manual estimate for a meal.</p><button className="cal-text-button" onClick={() => onModal({ type: 'entry' })}>Log food<Icon name="arrow" size={17}/></button></div>
        : <div className="cal-meals">{meals.map((meal, index) => {
          const entries = dayEntries.filter(entry => entry.meal === meal);
          const mealTotals = dayTotals(entries);
          return <div className="cal-meal" key={meal}><div className="cal-meal-heading"><span className="cal-meal-number">{String(index + 1).padStart(2, '0')}</span><h3>{meal}</h3><span>{number(mealTotals.calories)} kcal</span></div><div className="cal-entry-list">{entries.map(entry => <div className="cal-entry" key={entry.id}><div className="cal-entry-info"><strong>{entry.foodName}</strong><span>{entry.source === 'manual' ? 'Manual estimate' : <>{amountLabel(entry)}<i/> {entry.state}</>}</span></div><div className="cal-entry-macros"><span><b>P</b> {number(entry.protein, 1)}<small> g</small></span><span><b>C</b> {number(entry.carbs, 1)}<small> g</small></span><span><b>F</b> {number(entry.fat, 1)}<small> g</small></span><span><b>Fibre</b> {number(entry.fiber, 1)}<small> g</small></span></div><strong className="cal-entry-energy">{number(entry.calories)}<small> kcal</small></strong><div className="cal-entry-actions">{entry.source !== 'manual' && libraryIds.has(entry.foodId) && <button className="cal-icon-button" onClick={() => onModal({ type: 'entry', foodId: entry.foodId })} aria-label={`Log ${entry.foodName} again`} title="Log again"><Icon name="plus" size={16}/></button>}<button className="cal-icon-button" onClick={() => onModal({ type: 'entry', entry })} aria-label={`Edit ${entry.foodName}`}><Icon name="edit" size={16}/></button><button className="cal-icon-button" onClick={() => void onRemoveEntry(entry.id)} aria-label={`Remove ${entry.foodName}`} title="Remove (you can undo)"><Icon name="trash" size={16}/></button></div></div>)}</div></div>;
        })}</div>}
    </section>
  </>;
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
