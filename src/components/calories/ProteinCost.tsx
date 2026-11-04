import { useMemo, useState } from 'react';
import type { Food } from '../../lib/calories/model';
import { PROTEIN_BASES, pricedState, rankByProteinCost } from '../../lib/calories/price';
import { DAILY_PROTEIN_GRAMS } from '../../lib/calories/nutrition';
import { Icon, ModalHeader, number, priceLabel, rawAmount, unitLabel } from './ui';
import { t } from '../../lib/calories/i18n';
import './food-details.css';

const BASIS_KEY = 'calories.protein-cost-basis';
type Basis = (typeof PROTEIN_BASES)[number];
function storedBasis(): Basis {
  try { const value = Number(globalThis.localStorage?.getItem(BASIS_KEY)); return (PROTEIN_BASES as readonly number[]).includes(value) ? value as Basis : 100; } catch { return 100; }
}

/** Priced foods ranked by what a set amount of their protein costs, cheapest first. */
export default function ProteinCost({ foods, onOpenFood, onClose }: { foods: readonly Food[]; onOpenFood: (food: Food) => void; onClose: () => void }) {
  const [basis, setBasis] = useState<Basis>(storedBasis);
  const { ranked, noPrice, noProtein } = useMemo(() => rankByProteinCost(foods, basis), [foods, basis]);
  function choose(next: Basis) { setBasis(next); try { globalThis.localStorage?.setItem(BASIS_KEY, String(next)); } catch { /* Kept until the dialog closes. */ } }
  return <div className="cal-food-details">
    <ModalHeader title={t('Protein cost')} eyebrow={t('FOODS')} onClose={onClose}/>
    <div className="cal-entry-mode-switch cal-protein-cost-switch" role="group" aria-label={t('Cost of')}>
      {PROTEIN_BASES.map(grams => <button key={grams} type="button" className={basis === grams ? 'is-active' : ''} aria-pressed={basis === grams} onClick={() => choose(grams)}>{grams === DAILY_PROTEIN_GRAMS ? t('{grams} g protein (daily target)', { grams }) : t('{grams} g protein', { grams })}</button>)}
    </div>
    {ranked.length ? <ol className="cal-food-details-list cal-protein-cost-list" aria-label={t('Foods by cost of {grams} g protein', { grams: basis })}>
      {ranked.map(({ food, cost }, index) => { const priced = pricedState(food), raw = priced !== food, amount = `${number(priced.baseQuantity, 2)} ${unitLabel(priced.unit, priced.baseQuantity)}`; return <li key={food.id}><button type="button" onClick={() => onOpenFood(food)}>
        <span><strong>{index + 1}. {food.name}</strong><small>{priceLabel(food.price!, food.unit, raw)} · {t('{protein} g protein per {amount}', { protein: number(priced.protein, 1), amount: raw ? rawAmount(amount) : amount })}</small></span>
        <span><strong>{number(cost, 2)}</strong><small> kr</small></span>
        <Icon name="right" size={16}/>
      </button></li>; })}
    </ol> : <p className="cal-food-details-empty">{t('Add a price to a food, in its editor, to see what its protein costs.')}</p>}
    {(noPrice.length > 0 || noProtein.length > 0) && <p className="cal-field-hint">{[noPrice.length ? t(noPrice.length === 1 ? '{count} food has no price yet.' : '{count} foods have no price yet.', { count: noPrice.length }) : '', noProtein.length ? t(noProtein.length === 1 ? '{count} priced food has no protein.' : '{count} priced foods have no protein.', { count: noProtein.length }) : ''].filter(Boolean).join(' ')}</p>}
    <div className="cal-modal-actions"><button type="button" className="cal-button" onClick={onClose}>{t('Close')}</button></div>
  </div>;
}
