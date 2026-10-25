import { useMemo, useState } from 'react';
import type { Entry, Food } from '../../lib/calories/model';
import { foodUsage } from '../../lib/calories/food-order';
import { Icon, ModalHeader, number, readableDate, unitLabel } from './ui';
import './food-details.css';

const PAGE = 30;

export default function FoodDetails({ food, entries, currentDay, onOpenDay, onLog, onClose }: { food: Food; entries: readonly Entry[]; currentDay: string; onOpenDay: (date: string) => void; onLog: () => void; onClose: () => void }) {
  const usage = useMemo(() => foodUsage(entries, food.id, currentDay), [entries, food.id, currentDay]);
  const [limit, setLimit] = useState(PAGE);
  const amount = usage.amounts.map(({ unit, quantity }) => `${number(quantity, 1)} ${unitLabel(unit, quantity)}`).join(' + ');
  const typical = usage.amounts[0];
  const lastAgo = usage.lastDate ? Math.round((Date.parse(`${currentDay}T12:00:00Z`) - Date.parse(`${usage.lastDate}T12:00:00Z`)) / 86_400_000) : null;
  return <div className="cal-food-details">
    <ModalHeader title={food.name} eyebrow="FOOD DETAILS" onClose={onClose}/>
    <div className="cal-food-details-stats">
      <span>Times eaten<strong>{number(usage.count)}</strong><small>{usage.count ? `on ${number(usage.days)} ${usage.days === 1 ? 'day' : 'days'}` : 'Not logged yet'}</small></span>
      <span>Last eaten<strong>{usage.lastDate ? readableDate(usage.lastDate, { day: 'numeric', month: 'short' }) : '—'}</strong><small>{lastAgo === null ? 'Never' : lastAgo === 0 ? 'Today' : lastAgo === 1 ? 'Yesterday' : `${number(lastAgo)} days ago`}</small></span>
      <span>Last 7 days<strong>{number(usage.last7)}</strong><small>{usage.last7 === 1 ? 'time' : 'times'}</small></span>
      <span>Last 30 days<strong>{number(usage.last30)}</strong><small>{usage.last30 === 1 ? 'time' : 'times'}</small></span>
      <span>Total amount<strong>{amount || '—'}</strong><small>{typical ? `About ${number(typical.quantity / typical.count, 1)} ${unitLabel(typical.unit, typical.quantity / typical.count)} each time` : 'Nothing eaten yet'}</small></span>
      <span>Total energy<strong>{number(usage.calories)}</strong><small>kcal{usage.firstDate ? ` since ${readableDate(usage.firstDate, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</small></span>
    </div>
    {usage.entries.length ? <ol className="cal-food-details-list" aria-label={`Every time ${food.name} was logged`}>
      {usage.entries.slice(0, limit).map(entry => <li key={entry.id}><button type="button" onClick={() => onOpenDay(entry.date)}>
        <span><strong>{readableDate(entry.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</strong><small>{entry.meal}{entry.date > currentDay ? ' · Planned' : ''}</small></span>
        <span>{number(entry.quantity, 2)} {unitLabel(entry.unit, entry.quantity)}</span>
        <span>{number(entry.calories)}<small> kcal</small></span>
        <Icon name="right" size={16}/>
      </button></li>)}
    </ol> : <p className="cal-food-details-empty">Every time you log {food.name}, it appears here with the day, meal and amount.</p>}
    {usage.entries.length > limit && <button type="button" className="cal-button cal-history-more" onClick={() => setLimit(value => value + PAGE)}>Show older ({number(usage.entries.length - limit)} more)</button>}
    <div className="cal-modal-actions"><button type="button" className="cal-button" onClick={onClose}>Close</button><button type="button" className="cal-button cal-button-primary" onClick={onLog}><Icon name="plus" size={17}/>Log this food</button></div>
  </div>;
}
