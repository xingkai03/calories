import { useId, useRef, useState, type FormEvent } from 'react';
import { canLogPieces, energyFromMacros, foodInState, hasRawState, macrosForFood, quantityFromPieces, type BankItem, type BankPortion, type Food, type Macros } from '../../lib/calories/model';
import { groupFoodBankPortions, nutritionForGrams, prepareFoodBankBatch, prepareFoodBankPortions, type BankIngredientInput } from '../../lib/calories/food-bank';
import { mealForTime } from '../../lib/calories/food-order';
import { DraftRestoredNotice, usePersistentFormDraft } from './FormDrafts';
import { amountLabel, NumericField } from './ui';
import { t, translateMessage } from '../../lib/calories/i18n';
import { stateLabel } from './ui';
import './food-bank.css';

const number = (value: number, decimals = 1) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: decimals }).format(value);
const zeroMacros = (): Macros => ({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
function sumNutrition(items: readonly Macros[]): Macros {
  return items.reduce((total, item) => ({ calories: total.calories + item.calories, protein: total.protein + item.protein, carbs: total.carbs + item.carbs, fat: total.fat + item.fat, fiber: total.fiber + item.fiber }), zeroMacros());
}
const scaleMacros = (totals: Macros, ratio: number): Macros => ({ calories: totals.calories * ratio, protein: totals.protein * ratio, carbs: totals.carbs * ratio, fat: totals.fat * ratio, fiber: totals.fiber * ratio });
function BankIcon({ name, size = 19 }: { name: 'plus' | 'close' | 'trash' | 'search' | 'box' | 'check'; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name === 'plus' ? <path d="M12 5v14M5 12h14"/> : name === 'close' ? <path d="m6 6 12 12M6 18 18 6"/> : name === 'trash' ? <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></> : name === 'search' ? <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></> : name === 'check' ? <path d="m5 12 4 4L19 6"/> : <><path d="m3 7 9-4 9 4-9 4-9-4ZM3 7v10l9 4 9-4V7M12 11v10"/></>}</svg>;
}
function BankHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return <div className="cal-modal-heading"><div><div className="cal-eyebrow">{t('FOOD BANK')}</div><h2 id="cal-dialog-title">{title}</h2></div><button className="cal-icon-button cal-bank-touch" type="button" onClick={onClose} aria-label={t('Close dialog')}><BankIcon name="close" size={20}/></button></div>;
}
function BankNutrition({ totals, label = t('Per portion') }: { totals: Macros; label?: string }) {
  return <div className="cal-bank-nutrition"><div className="cal-bank-energy"><span>{label}</span><strong>{number(totals.calories, 0)} <small>kcal</small></strong></div><div className="cal-bank-macros">{([['Protein', totals.protein], ['Carbs', totals.carbs], ['Fat', totals.fat], ['Fibre', totals.fiber]] as const).map(([label, value]) => <span key={label}>{t(label)}<strong>{number(value)} g</strong></span>)}</div></div>;
}
const isEstimate = (item: BankItem) => item.foodId === `manual:${item.id}`;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
function BankIngredients({ portion, name = portion.name }: { portion: BankPortion; name?: string }) {
  // A single ingredient named like the portion itself shows only its state and amount, not the name again.
  const repeatsName = portion.items.length === 1 && sameName(portion.items[0].foodName, name);
  return <ul className="cal-bank-ingredients" aria-label={t('Ingredients in this portion')}>{portion.items.map((item, index) => <li key={`${item.id}-${index}`}><span>{!repeatsName && item.foodName}<small>{isEstimate(item) ? t('Manual estimate') : stateLabel(item.state)}</small></span><strong>{isEstimate(item) ? `${number(item.calories, 0)} kcal` : amountLabel(item)}</strong></li>)}</ul>;
}

export function FoodBankView({ portions, onPrepare, onEat, onRemove }: { portions: readonly BankPortion[]; onPrepare: () => void; onEat: (portion: BankPortion) => void; onRemove: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const query = search.trim().toLowerCase();
  const visible = groupFoodBankPortions(portions).filter(group => group.name.toLowerCase().includes(query) || group.portions[0].items.some(item => item.foodName.toLowerCase().includes(query)));
  const visibleCount = visible.reduce((total, group) => total + group.portions.length, 0);
  const portionsLeft = (count: number) => t(count === 1 ? '{count} portion left' : '{count} portions left', { count });
  const batches = portions.filter(portion => portion.weight).length, whole = portions.length - batches;
  const totalLine = [...(whole || !batches ? [t(whole === 1 ? '{count} prepared portion' : '{count} prepared portions', { count: whole })] : []), ...(batches ? [t(batches === 1 ? '{count} food kept by weight' : '{count} foods kept by weight', { count: batches })] : [])].join(' · ');
  return <div className="cal-bank-view">
    <div className="cal-bank-toolbar"><div className="cal-bank-search"><BankIcon name="search" size={17}/><input type="search" aria-label={t('Search prepared portions')} value={search} onChange={event => setSearch(event.target.value)} placeholder={t('Search prepared food')}/></div><button className="cal-button cal-button-primary" type="button" onClick={onPrepare}><BankIcon name="plus"/>{t('Prepare portions')}</button></div>
    <p className="cal-bank-count" role="status">{query ? t(visibleCount === 1 ? '{count} matching portion' : '{count} matching portions', { count: visibleCount }) : totalLine}</p>
    {visible.length > 0 ? <div className="cal-bank-grid">{visible.map(({ name, portions: group }) => { const portion = group[0], weight = portion.weight; return <article className="cal-food-card cal-bank-card" key={portion.id}>
      <div className="cal-bank-card-heading"><span>{weight ? t('{weight} g left', { weight: number(weight.left) }) : portionsLeft(group.length)}</span><BankIcon name="box" size={18}/></div><h2>{name}</h2>
      {weight && <p className="cal-bank-batch-note">{t('Ingredients in the whole batch ({weight} g)', { weight: number(weight.total) })}</p>}
      <BankIngredients portion={portion} name={name}/>{weight ? <BankNutrition totals={nutritionForGrams(portion, 100)} label={t('Per 100 g')}/> : <BankNutrition totals={sumNutrition(portion.items)}/>}
      {removing === portion.id ? <div className="cal-bank-remove-confirm"><p>{t(weight ? 'Remove all that’s left? It won’t be added to your journal.' : 'Remove one portion? It won’t be added to your journal.')}</p><div><button className="cal-text-button cal-bank-touch" type="button" onClick={() => setRemoving(null)}>{t('Cancel')}</button><button className="cal-text-button cal-danger cal-bank-touch" type="button" onClick={() => { onRemove(portion.id); setRemoving(null); }}>{t(weight ? 'Remove all' : 'Remove portion')}</button></div></div> : <div className="cal-bank-card-actions"><button className="cal-button cal-button-small cal-bank-eat" type="button" aria-label={weight ? t('Eat some of {name}', { name }) : t('Eat one portion of {name}', { name })} onClick={() => onEat(portion)}>{t(weight ? 'Eat some' : 'Eat 1')}<BankIcon name="check" size={17}/></button><button className="cal-icon-button cal-bank-touch" type="button" aria-label={weight ? t('Remove {name} from the food bank', { name }) : t('Remove one portion of {name}', { name })} onClick={() => setRemoving(portion.id)}><BankIcon name="trash" size={17}/></button></div>}
    </article>; })}</div> : <div className="cal-empty-journal cal-bank-empty"><span className="cal-empty-art"><BankIcon name="box" size={36}/></span><h3>{t(query ? 'No portions found.' : 'No prepared portions.')}</h3><p>{t(query ? 'Try a food or portion name.' : 'Prepare individual portions from your food library or your own estimates. Eat one to move its ingredients into your journal.')}</p><button className="cal-text-button cal-bank-touch" type="button" onClick={onPrepare}>{t('Prepare portions')}<BankIcon name="plus" size={17}/></button></div>}
  </div>;
}

type EstimateDraft = { protein: string; carbs: string; fat: string; fiber: string };
const emptyEstimate = (): EstimateDraft => ({ protein: '', carbs: '', fat: '', fiber: '' });
/** byPiece and the manual estimate fields are optional so older drafts still restore. */
interface IngredientDraft { key: number; foodId: string; query: string; quantity: string; byPiece?: boolean; raw?: boolean; manual?: boolean; estimateName?: string; estimate?: EstimateDraft }
const estimateNumber = (value: string) => value.trim() === '' ? 0 : Number(value);
const validEstimate = (estimate: EstimateDraft) => Object.values(estimate).every(value => { const parsed = estimateNumber(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e8; });
const estimateMacros = (estimate: EstimateDraft) => { const values = { protein: estimateNumber(estimate.protein), carbs: estimateNumber(estimate.carbs), fat: estimateNumber(estimate.fat), fiber: estimateNumber(estimate.fiber) }; return { ...values, calories: energyFromMacros(values) }; };
/** byWeight and totalWeight are optional so older drafts still restore as portions. */
export function FoodBankEditor({ foods, onSave, onClose }: { foods: readonly Food[]; onSave: (portions: BankPortion[]) => void | Promise<void>; onClose: () => void }) {
  const id = useId();
  const form = usePersistentFormDraft('bank:prepare', { draftBatchId: crypto.randomUUID(), name: '', count: '1', ingredients: [{ key: 0, foodId: foods[0]?.id ?? '', query: '', quantity: '', ...(foods.length ? {} : { manual: true }) }] as IngredientDraft[], byWeight: false as boolean | undefined, totalWeight: '' as string | undefined }, value => ({ kind: 'bank-prepare', label: value.name.trim() || t('Prepared portions') }));
  const [name, setName] = form.field('name');
  const [count, setCount] = form.field('count');
  const [ingredients, setIngredients] = form.field('ingredients');
  const [byWeightField, setByWeight] = form.field('byWeight');
  const [totalWeightField, setTotalWeight] = form.field('totalWeight');
  const byWeight = Boolean(byWeightField), totalWeight = totalWeightField ?? '';
  const nextKey = useRef(Math.max(0, ...ingredients.map(ingredient => ingredient.key)) + 1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const matches = (food: Food, query: string) => food.name.toLowerCase().includes(query.trim().toLowerCase());
  const libraryFood = (ingredient: IngredientDraft) => foods.find(food => food.id === ingredient.foodId && matches(food, ingredient.query));
  // A cooked food can go in by its raw weight; the ingredient then uses the food's raw state.
  const selectedFood = (ingredient: IngredientDraft) => { const food = libraryFood(ingredient); return food && ingredient.raw && hasRawState(food) ? foodInState(food, 'Raw') : food; };
  // An ingredient whose food has a piece weight starts in pieces, as in the log form.
  const inPieces = (ingredient: IngredientDraft, food = selectedFood(ingredient)) => Boolean(food && canLogPieces(food) && (ingredient.byPiece ?? true));
  const amountOf = (ingredient: IngredientDraft, food: Food, value: number) => inPieces(ingredient, food) ? quantityFromPieces(food, value) : value;
  const ingredientName = (ingredient: IngredientDraft) => ingredient.manual ? ingredient.estimateName?.trim() : selectedFood(ingredient)?.name;
  const autoName = ingredients.map(ingredientName).filter(Boolean).join(' + ').slice(0, 160);
  const validPreviews = ingredients.flatMap(ingredient => {
    if (ingredient.manual) {
      const estimate = ingredient.estimate ?? emptyEstimate();
      return ingredient.estimateName?.trim() && validEstimate(estimate) ? [estimateMacros(estimate)] : [];
    }
    const food = selectedFood(ingredient);
    const quantity = Number(ingredient.quantity);
    if (!food || !ingredient.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1e8) return [];
    const nutrients = macrosForFood(food, amountOf(ingredient, food, quantity));
    return Object.values(nutrients).every(value => Number.isFinite(value) && value >= 0 && value <= 1e8) ? [nutrients] : [];
  });
  const preview = sumNutrition(validPreviews);
  // Without a weighed total, a batch weighs what its gram ingredients add up to.
  const ingredientGrams = ingredients.reduce((total, ingredient) => {
    const food = !ingredient.manual ? selectedFood(ingredient) : undefined, value = Number(ingredient.quantity);
    // Raw grams count as the cooked weight they become.
    const cooked = food && ingredient.raw ? libraryFood(ingredient)?.cookedRatio ?? 1 : 1;
    return food?.unit === 'g' && ingredient.quantity.trim() && Number.isFinite(value) && value > 0 ? total + amountOf(ingredient, food, value) * cooked : total;
  }, 0);
  const batchWeight = totalWeight.trim() ? Number(totalWeight) : ingredientGrams;
  const validBatchWeight = Number.isFinite(batchWeight) && batchWeight > 0 && batchWeight <= 1e8;
  const previewComplete = validPreviews.length === ingredients.length;
  function updateIngredient(key: number, update: (ingredient: IngredientDraft) => IngredientDraft) {
    setIngredients(current => current.map(ingredient => ingredient.key === key ? update(ingredient) : ingredient));
    setError('');
  }
  function filterIngredient(key: number, query: string) {
    const first = foods.find(food => matches(food, query));
    updateIngredient(key, current => first?.id === current.foodId ? { ...current, query } : { ...current, query, foodId: first?.id ?? '', quantity: '', byPiece: undefined, raw: undefined });
  }
  function changeIngredientSource(key: number, manual: boolean) {
    updateIngredient(key, current => ({ ...current, manual, estimateName: current.estimateName ?? '', estimate: current.estimate ?? emptyEstimate() }));
  }
  function changeEstimate(key: number, field: keyof EstimateDraft, value: string) {
    updateIngredient(key, current => ({ ...current, estimate: { ...(current.estimate ?? emptyEstimate()), [field]: value } }));
  }
  function changeIngredientUnit(ingredient: IngredientDraft, food: Food, pieces: boolean) {
    if (!food.pieceWeight || inPieces(ingredient, food) === pieces) return;
    const value = Number(ingredient.quantity);
    // Convert what was typed so the portion stays the same.
    const quantity = ingredient.quantity.trim() && Number.isFinite(value) && value > 0 ? String(Math.round((pieces ? value / food.pieceWeight : value * food.pieceWeight) * 100) / 100) : ingredient.quantity;
    updateIngredient(ingredient.key, current => ({ ...current, quantity, byPiece: pieces }));
  }
  function changeIngredientState(ingredient: IngredientDraft, raw: boolean) {
    const food = libraryFood(ingredient);
    if (!food || !hasRawState(food) || Boolean(ingredient.raw) === raw) return;
    const value = Number(ingredient.quantity), ratio = food.cookedRatio ?? 1;
    // Convert what was typed so the portion stays the same; a count of pieces stays as it is.
    const quantity = !inPieces(ingredient) && ingredient.quantity.trim() && Number.isFinite(value) && value > 0 ? String(Math.round((raw ? value / ratio : value * ratio) * 100) / 100) : ingredient.quantity;
    updateIngredient(ingredient.key, current => ({ ...current, quantity, raw }));
  }
  function addIngredient() {
    if (ingredients.length >= 50) return;
    const key = nextKey.current++;
    setIngredients(current => [...current, { key, foodId: foods[0]?.id ?? '', query: '', quantity: '', ...(foods.length ? {} : { manual: true }) }]);
    setError('');
  }
  function closeEditor() { form.clearDraft(); onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (ingredients.some(ingredient => !ingredient.manual && (!selectedFood(ingredient) || !ingredient.quantity.trim()))) { setError(t('Choose a food and enter an amount for every ingredient.')); return; }
    if (ingredients.some(ingredient => ingredient.manual && !ingredient.estimateName?.trim())) { setError(t('Give each estimated ingredient a name.')); return; }
    if (ingredients.some(ingredient => ingredient.manual && !validEstimate(ingredient.estimate ?? emptyEstimate()))) { setError(t('Enter finite, non-negative nutrient estimates no greater than 100,000,000.')); return; }
    if (byWeight ? !validBatchWeight : !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 100) { setError(t(byWeight ? 'Enter the total weight of the food in grams.' : 'Prepare between 1 and 100 whole portions.')); return; }
    try {
      let generatedId = 0;
      const inputs = ingredients.map((ingredient): BankIngredientInput => ingredient.manual ? { manual: { name: ingredient.estimateName ?? '', ...estimateMacros(ingredient.estimate ?? emptyEstimate()) } } : { foodId: ingredient.foodId, ...(inPieces(ingredient) ? { pieces: Number(ingredient.quantity) } : { quantity: Number(ingredient.quantity) }), ...(ingredient.raw && selectedFood(ingredient)?.state === 'Raw' ? { state: 'Raw' as const } : {}) });
      const makeId = () => `${form.draft.draftBatchId}:${generatedId++}`;
      const prepared = byWeight ? prepareFoodBankBatch(foods, inputs, batchWeight, name.trim() || autoName, makeId) : prepareFoodBankPortions(foods, inputs, Number(count), name.trim() || autoName, makeId);
      setSubmitting(true);
      await onSave(prepared);
      form.clearDraft();
    } catch (caught) { setError(caught instanceof Error ? translateMessage(caught.message) : t('These portions couldn’t be prepared. Check the ingredients and amounts.')); }
    finally { setSubmitting(false); }
  }
  return <>
    <BankHeader title={t(byWeight ? 'Add food by weight' : 'Prepare portions')} onClose={closeEditor}/>
    <form className="cal-form cal-bank-editor" onSubmit={submit}>
      <DraftRestoredNotice {...form} disabled={submitting} discardDraft={() => { form.discardDraft(); setError(''); }}/>
      <fieldset className="cal-form cal-food-editor-fields" disabled={submitting}>
      <div className="cal-entry-mode-switch cal-bank-keep-switch" role="group" aria-label={t('Keep this food as')}>{[false, true].map(weight => <button key={String(weight)} type="button" className={byWeight === weight ? 'is-active' : ''} aria-pressed={byWeight === weight} onClick={() => { setByWeight(weight); setError(''); }}>{t(weight ? 'By weight' : 'Portions')}</button>)}</div>
      <p className="cal-bank-keep-hint">{t(byWeight ? 'Weigh the finished food once. Each time you eat some, enter the grams and they come off what’s left.' : 'Split the food into equal portions and eat one at a time.')}</p>
      <div className="cal-form-grid cal-bank-name-grid"><label>{t(byWeight ? 'Name' : 'Portion name')} <small className="cal-field-hint">{t('Optional')}</small><input value={name} onChange={event => setName(event.target.value)} placeholder={autoName || t('e.g. Chicken and rice')} maxLength={160}/></label>{byWeight
        ? <label>{t('Total weight')} {!totalWeight.trim() && ingredientGrams > 0 && <small className="cal-field-hint">{t('Optional')}</small>}<span className="cal-unit-input"><input type="number" inputMode="decimal" value={totalWeight} onChange={event => { setTotalWeight(event.target.value); setError(''); }} placeholder={ingredientGrams > 0 ? number(ingredientGrams) : t('Weight')} min={0.001} max={100000000} step="any" required={ingredientGrams <= 0}/><span>g</span></span></label>
        : <label>{t('Number of portions')}<input type="number" inputMode="numeric" value={count} onChange={event => { setCount(event.target.value); setError(''); }} min={1} max={100} step={1} required/></label>}</div>
      <div className="cal-bank-section-heading"><strong id={`${id}-amounts`}>{t(byWeight ? 'Amounts in the whole batch' : 'Amounts per portion')}</strong><span>{t(byWeight ? 'Everything that went into the food. Leave the total weight blank to use the ingredients’ weight.' : 'Each portion gets these amounts.')}</span></div>
      <div className="cal-bank-ingredient-rows">{ingredients.map((ingredient, index) => {
        const filtered = foods.filter(food => matches(food, ingredient.query));
        const food = selectedFood(ingredient);
        const fieldId = `${id}-${ingredient.key}`;
        const estimate = ingredient.estimate ?? emptyEstimate();
        return <fieldset className="cal-bank-ingredient-row" key={ingredient.key}><legend>{t('Ingredient {number}', { number: index + 1 })}</legend>
          <div className="cal-entry-mode-switch cal-bank-source-switch" role="group" aria-label={t('Ingredient {number} from', { number: index + 1 })}>{[false, true].map(manual => <button key={String(manual)} type="button" className={Boolean(ingredient.manual) === manual ? 'is-active' : ''} aria-pressed={Boolean(ingredient.manual) === manual} onClick={() => changeIngredientSource(ingredient.key, manual)} disabled={!manual && foods.length === 0}>{t(manual ? 'Manual estimate' : 'Food library')}</button>)}</div>
          {ingredient.manual ? <div className="cal-bank-estimate-fields">
          <label>{t('Name')}<input value={ingredient.estimateName ?? ''} onChange={event => updateIngredient(ingredient.key, current => ({ ...current, estimateName: event.target.value }))} placeholder={t('e.g. Homemade curry')} maxLength={160} required/></label>
          <div className="cal-form-grid"><NumericField label={t('Protein')} value={estimate.protein} onChange={value => changeEstimate(ingredient.key, 'protein', value)} required={false} placeholder="0"/><NumericField label={t('Carbohydrate')} value={estimate.carbs} onChange={value => changeEstimate(ingredient.key, 'carbs', value)} required={false} placeholder="0"/><NumericField label={t('Fat')} value={estimate.fat} onChange={value => changeEstimate(ingredient.key, 'fat', value)} required={false} placeholder="0"/><NumericField label={t('Fibre')} value={estimate.fiber} onChange={value => changeEstimate(ingredient.key, 'fiber', value)} required={false} placeholder="0"/></div>
          <div className="cal-bank-estimate-footer"><small>{t(byWeight ? '{kcal} kcal in the batch' : '{kcal} kcal per portion', { kcal: number(validEstimate(estimate) ? estimateMacros(estimate).calories : 0, 0) })}</small>{ingredients.length > 1 && <button className="cal-icon-button cal-bank-touch" type="button" aria-label={t('Remove ingredient {number}', { number: index + 1 })} onClick={() => { setIngredients(current => current.filter(item => item.key !== ingredient.key)); setError(''); }}><BankIcon name="trash" size={17}/></button>}</div>
          </div> : <div className="cal-bank-ingredient-fields">
          <div className="cal-food-picker"><label htmlFor={`${fieldId}-search`}>{t('Food')}</label><div className="cal-food-picker-controls"><input id={`${fieldId}-search`} type="text" value={ingredient.query} onChange={event => filterIngredient(ingredient.key, event.target.value)} placeholder={t('Filter food names')} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={`${fieldId}-matches`}/><select aria-label={t('Food for ingredient {number}', { number: index + 1 })} value={food?.id ?? ''} onChange={event => updateIngredient(ingredient.key, current => event.target.value === current.foodId ? current : { ...current, foodId: event.target.value, quantity: '', byPiece: undefined, raw: undefined })} disabled={filtered.length === 0} required>{filtered.length === 0 && <option value="" disabled>{t('No matching foods')}</option>}{filtered.map(food => <option key={food.id} value={food.id}>{food.name} · {stateLabel(food.state)}</option>)}</select></div><small className="cal-bank-match-count" id={`${fieldId}-matches`} role="status">{filtered.length === 0 ? t('No matching foods') : ingredient.query.trim() ? t(filtered.length === 1 ? '{count} matching food' : '{count} matching foods', { count: filtered.length }) : ''}</small></div>
          <label>{t(byWeight ? 'Amount in the batch' : 'Amount per portion')}<span className="cal-unit-input"><input type="number" inputMode="decimal" value={ingredient.quantity} onChange={event => updateIngredient(ingredient.key, current => ({ ...current, quantity: event.target.value }))} placeholder={t('Amount')} min={0.001} max={100000000} step="any" required aria-describedby={`${id}-amounts`}/><span>{food ? inPieces(ingredient, food) ? t('pieces') : food.unit : '—'}</span></span></label>
          {food && hasRawState(libraryFood(ingredient) ?? food) && <div className="cal-entry-mode-switch cal-amount-unit-switch" role="group" aria-label={t('State of ingredient {number}', { number: index + 1 })}>{[false, true].map(raw => <button key={String(raw)} type="button" className={Boolean(ingredient.raw) === raw ? 'is-active' : ''} aria-pressed={Boolean(ingredient.raw) === raw} onClick={() => changeIngredientState(ingredient, raw)}>{stateLabel(raw ? 'Raw' : 'Cooked')}</button>)}</div>}
          {food && canLogPieces(food) && <div className="cal-entry-mode-switch cal-amount-unit-switch" role="group" aria-label={t('Amount of ingredient {number} in', { number: index + 1 })}>{[true, false].map(pieces => <button key={String(pieces)} type="button" className={inPieces(ingredient, food) === pieces ? 'is-active' : ''} aria-pressed={inPieces(ingredient, food) === pieces} onClick={() => changeIngredientUnit(ingredient, food, pieces)}>{pieces ? t('Pieces ({weight} each)', { weight: `${number(food.pieceWeight ?? 0, 2)} ${food.unit}` }) : t(food.unit === 'ml' ? 'Millilitres' : 'Grams')}</button>)}</div>}
          {ingredients.length > 1 && <button className="cal-icon-button cal-bank-touch cal-bank-remove-ingredient" type="button" aria-label={t('Remove ingredient {number}', { number: index + 1 })} onClick={() => { setIngredients(current => current.filter(item => item.key !== ingredient.key)); setError(''); }}><BankIcon name="trash" size={17}/></button>}
        </div>}</fieldset>;
      })}</div>
      <button className="cal-text-button cal-bank-add-ingredient cal-bank-touch" type="button" onClick={addIngredient} disabled={ingredients.length >= 50}><BankIcon name="plus" size={17}/>{t(ingredients.length >= 50 ? '50 ingredients maximum' : 'Add ingredient')}</button>
      <div className="cal-bank-editor-preview" aria-live="polite"><BankNutrition totals={preview} label={t(byWeight ? 'Nutrition in the whole batch' : 'Nutrition per portion')}/>{byWeight && validBatchWeight && previewComplete && <BankNutrition totals={scaleMacros(preview, 100 / batchWeight)} label={t('Per 100 g')}/>}{!previewComplete && <p>{t('Add every amount to complete the preview.')}</p>}</div>
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={closeEditor} disabled={submitting}>{t('Cancel')}</button><button className="cal-button cal-button-primary" type="submit" disabled={submitting}>{submitting ? t(byWeight ? 'Saving…' : 'Saving portions…') : byWeight ? validBatchWeight ? t('Add {weight} g to the food bank', { weight: number(batchWeight) }) : t('Add to the food bank') : Number.isInteger(Number(count)) && Number(count) > 0 && Number(count) <= 100 ? t(Number(count) === 1 ? 'Prepare {count} portion' : 'Prepare {count} portions', { count: number(Number(count), 0) }) : t('Prepare portions')}<BankIcon name="check" size={17}/></button></div>
    </form>
  </>;
}

export function FoodBankConsume({ portion, date, onSave, onClose }: { portion: BankPortion; date: string; onSave: (date: string, meal: string, grams?: number) => void | Promise<void>; onClose: () => void }) {
  const weight = portion.weight;
  const [grams, setGrams] = useState('');
  const eaten = Number(grams), validGrams = Boolean(weight && grams.trim() && Number.isFinite(eaten) && eaten > 0);
  const [entryDate, setEntryDate] = useState(date);
  const [meal, setMeal] = useState<string>(() => mealForTime());
  const [customMeal, setCustomMeal] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const selectedMeal = meal === 'Custom' ? customMeal.trim() : meal;
    if (weight && !validGrams) { setError(t('Enter how many grams you ate.')); return; }
    if (weight && eaten > weight.left + 0.001) { setError(t('That is more than is left in the food bank.')); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || Number.isNaN(Date.parse(`${entryDate}T12:00:00Z`)) || new Date(`${entryDate}T12:00:00Z`).toISOString().slice(0, 10) !== entryDate || !selectedMeal) { setError(t('Choose a date and meal for this portion.')); return; }
    setSubmitting(true);
    try { await onSave(entryDate, selectedMeal, weight ? Math.min(eaten, weight.left) : undefined); } catch (caught) { setError(caught instanceof Error ? translateMessage(caught.message) : t('This portion couldn’t be logged. Try again.')); }
    finally { setSubmitting(false); }
  }
  return <>
    <BankHeader title={t(weight ? 'Eat from the food bank' : 'Eat a prepared portion')} onClose={onClose}/>
    {weight ? <div className="cal-bank-consume-summary"><h3>{portion.name}</h3><p className="cal-bank-batch-note">{t('{weight} g left', { weight: number(weight.left) })}</p><BankNutrition totals={nutritionForGrams(portion, validGrams ? Math.min(eaten, weight.left) : 100)} label={validGrams ? t('In {weight} g', { weight: number(Math.min(eaten, weight.left)) }) : t('Per 100 g')}/></div>
      : <div className="cal-bank-consume-summary"><h3>{portion.name}</h3><BankIngredients portion={portion}/><BankNutrition totals={sumNutrition(portion.items)}/></div>}
    <form className="cal-form cal-bank-consume-form" onSubmit={submit}>
      <fieldset className="cal-form cal-food-editor-fields" disabled={submitting}>
      {weight && <div className="cal-bank-grams"><label>{t('Amount eaten')}<span className="cal-unit-input"><input type="number" inputMode="decimal" value={grams} onChange={event => { setGrams(event.target.value); setError(''); }} placeholder={t('Weight')} min={0.001} max={weight.left} step="any" required autoFocus/><span>g</span></span></label><button className="cal-text-button cal-bank-touch" type="button" onClick={() => { setGrams(String(Math.round(weight.left * 1000) / 1000)); setError(''); }}>{t('All that’s left ({weight} g)', { weight: number(weight.left) })}</button></div>}
      <div className="cal-form-grid"><label>{t('Date')}<input type="date" value={entryDate} onChange={event => { setEntryDate(event.target.value); setError(''); }} required/></label><label>{t('Meal')}<select value={meal} onChange={event => { setMeal(event.target.value); setError(''); }}>{['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Custom'].map(meal => <option key={meal} value={meal}>{t(meal)}</option>)}</select></label></div>
      {meal === 'Custom' && <label>{t('Meal name or number')}<input value={customMeal} onChange={event => { setCustomMeal(event.target.value); setError(''); }} placeholder={t('e.g. Meal 1')} maxLength={80} required/></label>}
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={onClose} disabled={submitting}>{t('Cancel')}</button><button className="cal-button cal-button-primary" type="submit" disabled={submitting}>{t(submitting ? 'Logging…' : 'Eat and log')}<BankIcon name="check" size={17}/></button></div>
    </form>
  </>;
}
