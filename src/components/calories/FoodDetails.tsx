import { useMemo, useState } from 'react';
import type { Entry, Food } from '../../lib/calories/model';
import { foodUsage } from '../../lib/calories/food-order';
import { Icon, ModalHeader, number, readableDate, unitLabel, amountLabel, mealLabel } from './ui';
import { t } from '../../lib/calories/i18n';
import './food-details.css';

const PAGE = 30;

export default function FoodDetails({ food, entries, currentDay, onOpenDay, onLog, onClose }: { food: Food; entries: readonly Entry[]; currentDay: string; onOpenDay: (date: string) => void; onLog: () => void; onClose: () => void }) {
  const usage = useMemo(() => foodUsage(entries, food.id, currentDay), [entries, food.id, currentDay]);
  const [limit, setLimit] = useState(PAGE);
  const amount = usage.amounts.map(({ unit, quantity }) => `${number(quantity, 1)} ${unitLabel(unit, quantity)}`).join(' + ');
  const typical = usage.amounts[0];
  const lastAgo = usage.lastDate ? Math.round((Date.parse(`${currentDay}T12:00:00Z`) - Date.parse(`${usage.lastDate}T12:00:00Z`)) / 86_400_000) : null;
  return <div className="cal-food-details">
    <ModalHeader title={food.name} eyebrow={t('FOOD DETAILS')} onClose={onClose}/>
    <div className="cal-food-details-stats">
      <span>{t('Times eaten')}<strong>{number(usage.count)}</strong><small>{usage.count ? t(usage.days === 1 ? 'on {count} day' : 'on {count} days', { count: number(usage.days) }) : t('Not logged yet')}</small></span>
      <span>{t('Last eaten')}<strong>{usage.lastDate ? readableDate(usage.lastDate, { day: 'numeric', month: 'short' }) : '—'}</strong><small>{lastAgo === null ? t('Never') : lastAgo === 0 ? t('Today') : lastAgo === 1 ? t('Yesterday') : t('{count} days ago', { count: number(lastAgo) })}</small></span>
      <span>{t('Last 7 days')}<strong>{number(usage.last7)}</strong><small>{t(usage.last7 === 1 ? 'time' : 'times')}</small></span>
      <span>{t('Last 30 days')}<strong>{number(usage.last30)}</strong><small>{t(usage.last30 === 1 ? 'time' : 'times')}</small></span>
      <span>{t('Total amount')}<strong>{amount || '—'}</strong><small>{typical ? t('About {amount} each time', { amount: `${number(typical.quantity / typical.count, 1)} ${unitLabel(typical.unit, typical.quantity / typical.count)}` }) : t('Nothing eaten yet')}</small></span>
      <span>{t('Total energy')}<strong>{number(usage.calories)}</strong><small>kcal{usage.firstDate ? ` ${t('since {date}', { date: readableDate(usage.firstDate, { day: 'numeric', month: 'short', year: 'numeric' }) })}` : ''}</small></span>
    </div>
    {usage.entries.length ? <ol className="cal-food-details-list" aria-label={t('Every time {name} was logged', { name: food.name })}>
      {usage.entries.slice(0, limit).map(entry => <li key={entry.id}><button type="button" onClick={() => onOpenDay(entry.date)}>
        <span><strong>{readableDate(entry.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</strong><small>{mealLabel(entry.meal)}{entry.date > currentDay ? ` · ${t('Planned')}` : ''}</small></span>
        <span>{amountLabel(entry)}</span>
        <span>{number(entry.calories)}<small> kcal</small></span>
        <Icon name="right" size={16}/>
      </button></li>)}
    </ol> : <p className="cal-food-details-empty">{t('Every time you log {name}, it appears here with the day, meal and amount.', { name: food.name })}</p>}
    {usage.entries.length > limit && <button type="button" className="cal-button cal-history-more" onClick={() => setLimit(value => value + PAGE)}>{t('Show older ({count} more)', { count: number(usage.entries.length - limit) })}</button>}
    <div className="cal-modal-actions"><button type="button" className="cal-button" onClick={onClose}>{t('Close')}</button><button type="button" className="cal-button cal-button-primary" onClick={onLog}><Icon name="plus" size={17}/>{t('Log this food')}</button></div>
  </div>;
}
