import { useId, useRef, useState, type FormEvent } from 'react';
import { canLogPieces, energyFromMacros, macrosForFood, quantityFromPieces, type BankItem, type BankPortion, type Food, type Macros } from '../../lib/calories/model';
import { groupFoodBankPortions, prepareFoodBankPortions, type BankIngredientInput } from '../../lib/calories/food-bank';
import { mealForTime } from '../../lib/calories/food-order';
import { DraftRestoredNotice, usePersistentFormDraft } from './FormDrafts';
import { amountLabel, NumericField } from './ui';
import './food-bank.css';

const number = (value: number, decimals = 1) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: decimals }).format(value);
const zeroMacros = (): Macros => ({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
function sumNutrition(items: readonly Macros[]): Macros {
  return items.reduce((total, item) => ({ calories: total.calories + item.calories, protein: total.protein + item.protein, carbs: total.carbs + item.carbs, fat: total.fat + item.fat, fiber: total.fiber + item.fiber }), zeroMacros());
}
function BankIcon({ name, size = 19 }: { name: 'plus' | 'close' | 'trash' | 'search' | 'box' | 'check'; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name === 'plus' ? <path d="M12 5v14M5 12h14"/> : name === 'close' ? <path d="m6 6 12 12M6 18 18 6"/> : name === 'trash' ? <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></> : name === 'search' ? <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></> : name === 'check' ? <path d="m5 12 4 4L19 6"/> : <><path d="m3 7 9-4 9 4-9 4-9-4ZM3 7v10l9 4 9-4V7M12 11v10"/></>}</svg>;
}
function BankHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return <div className="cal-modal-heading"><div><div className="cal-eyebrow">FOOD BANK</div><h2 id="cal-dialog-title">{title}</h2></div><button className="cal-icon-button cal-bank-touch" type="button" onClick={onClose} aria-label="Close dialog"><BankIcon name="close" size={20}/></button></div>;
}
function BankNutrition({ totals, label = 'Per portion' }: { totals: Macros; label?: string }) {
  return <div className="cal-bank-nutrition"><div className="cal-bank-energy"><span>{label}</span><strong>{number(totals.calories, 0)} <small>kcal</small></strong></div><div className="cal-bank-macros">{([['Protein', totals.protein], ['Carbs', totals.carbs], ['Fat', totals.fat], ['Fibre', totals.fiber]] as const).map(([label, value]) => <span key={label}>{label}<strong>{number(value)} g</strong></span>)}</div></div>;
}
const isEstimate = (item: BankItem) => item.foodId === `manual:${item.id}`;
function BankIngredients({ portion }: { portion: BankPortion }) {
  return <ul className="cal-bank-ingredients" aria-label="Ingredients in this portion">{portion.items.map((item, index) => <li key={`${item.id}-${index}`}><span>{item.foodName}<small>{isEstimate(item) ? 'Manual estimate' : item.state}</small></span><strong>{isEstimate(item) ? `${number(item.calories, 0)} kcal` : amountLabel(item)}</strong></li>)}</ul>;
}

export function FoodBankView({ portions, onPrepare, onEat, onRemove }: { portions: readonly BankPortion[]; onPrepare: () => void; onEat: (portion: BankPortion) => void; onRemove: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const query = search.trim().toLowerCase();
  const visible = groupFoodBankPortions(portions).filter(group => group.name.toLowerCase().includes(query) || group.portions[0].items.some(item => item.foodName.toLowerCase().includes(query)));
  const visibleCount = visible.reduce((total, group) => total + group.portions.length, 0);
  const portionsLabel = (count: number) => `${count} ${count === 1 ? 'portion' : 'portions'}`;
  return <div className="cal-bank-view">
    <div className="cal-bank-toolbar"><div className="cal-bank-search"><BankIcon name="search" size={17}/><input type="search" aria-label="Search prepared portions" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search prepared food"/></div><button className="cal-button cal-button-primary" type="button" onClick={onPrepare}><BankIcon name="plus"/>Prepare portions</button></div>
    <p className="cal-bank-count" role="status">{query ? `${visibleCount} matching ${visibleCount === 1 ? 'portion' : 'portions'}` : `${portions.length} prepared ${portions.length === 1 ? 'portion' : 'portions'}`}</p>
    {visible.length > 0 ? <div className="cal-bank-grid">{visible.map(({ name, portions: group }) => { const portion = group[0]; return <article className="cal-food-card cal-bank-card" key={portion.id}>
      <div className="cal-bank-card-heading"><span>{portionsLabel(group.length)} left</span><BankIcon name="box" size={18}/></div><h2>{name}</h2>
      <BankIngredients portion={portion}/><BankNutrition totals={sumNutrition(portion.items)}/>
      {removing === portion.id ? <div className="cal-bank-remove-confirm"><p>Remove one portion? It won’t be added to your journal.</p><div><button className="cal-text-button cal-bank-touch" type="button" onClick={() => setRemoving(null)}>Cancel</button><button className="cal-text-button cal-danger cal-bank-touch" type="button" onClick={() => { onRemove(portion.id); setRemoving(null); }}>Remove portion</button></div></div> : <div className="cal-bank-card-actions"><button className="cal-button cal-button-small cal-bank-eat" type="button" aria-label={`Eat one portion of ${name}`} onClick={() => onEat(portion)}>Eat 1<BankIcon name="check" size={17}/></button><button className="cal-icon-button cal-bank-touch" type="button" aria-label={`Remove one portion of ${name}`} onClick={() => setRemoving(portion.id)}><BankIcon name="trash" size={17}/></button></div>}
    </article>; })}</div> : <div className="cal-empty-journal cal-bank-empty"><span className="cal-empty-art"><BankIcon name="box" size={36}/></span><h3>{query ? 'No portions found.' : 'No prepared portions.'}</h3><p>{query ? 'Try a food or portion name.' : 'Prepare individual portions from your food library or your own estimates. Eat one to move its ingredients into your journal.'}</p><button className="cal-text-button cal-bank-touch" type="button" onClick={onPrepare}>Prepare portions<BankIcon name="plus" size={17}/></button></div>}
  </div>;
}

type EstimateDraft = { protein: string; carbs: string; fat: string; fiber: string };
const emptyEstimate = (): EstimateDraft => ({ protein: '', carbs: '', fat: '', fiber: '' });
/** byPiece and the manual estimate fields are optional so older drafts still restore. */
interface IngredientDraft { key: number; foodId: string; query: string; quantity: string; byPiece?: boolean; manual?: boolean; estimateName?: string; estimate?: EstimateDraft }
const estimateNumber = (value: string) => value.trim() === '' ? 0 : Number(value);
const validEstimate = (estimate: EstimateDraft) => Object.values(estimate).every(value => { const parsed = estimateNumber(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e8; });
const estimateMacros = (estimate: EstimateDraft) => { const values = { protein: estimateNumber(estimate.protein), carbs: estimateNumber(estimate.carbs), fat: estimateNumber(estimate.fat), fiber: estimateNumber(estimate.fiber) }; return { ...values, calories: energyFromMacros(values) }; };
export function FoodBankEditor({ foods, onSave, onClose }: { foods: readonly Food[]; onSave: (portions: BankPortion[]) => void | Promise<void>; onClose: () => void }) {
  const id = useId();
  const form = usePersistentFormDraft('bank:prepare', { draftBatchId: crypto.randomUUID(), name: '', count: '1', ingredients: [{ key: 0, foodId: foods[0]?.id ?? '', query: '', quantity: '', ...(foods.length ? {} : { manual: true }) }] as IngredientDraft[] }, value => ({ kind: 'bank-prepare', label: value.name.trim() || 'Prepared portions' }));
  const [name, setName] = form.field('name');
  const [count, setCount] = form.field('count');
  const [ingredients, setIngredients] = form.field('ingredients');
  const nextKey = useRef(Math.max(0, ...ingredients.map(ingredient => ingredient.key)) + 1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const matches = (food: Food, query: string) => food.name.toLowerCase().includes(query.trim().toLowerCase());
  const selectedFood = (ingredient: IngredientDraft) => foods.find(food => food.id === ingredient.foodId && matches(food, ingredient.query));
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
  const previewComplete = validPreviews.length === ingredients.length;
  function updateIngredient(key: number, update: (ingredient: IngredientDraft) => IngredientDraft) {
    setIngredients(current => current.map(ingredient => ingredient.key === key ? update(ingredient) : ingredient));
    setError('');
  }
  function filterIngredient(key: number, query: string) {
    const first = foods.find(food => matches(food, query));
    updateIngredient(key, current => first?.id === current.foodId ? { ...current, query } : { ...current, query, foodId: first?.id ?? '', quantity: '', byPiece: undefined });
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
    if (ingredients.some(ingredient => !ingredient.manual && (!selectedFood(ingredient) || !ingredient.quantity.trim()))) { setError('Choose a food and enter an amount for every ingredient.'); return; }
    if (ingredients.some(ingredient => ingredient.manual && !ingredient.estimateName?.trim())) { setError('Give each estimated ingredient a name.'); return; }
    if (ingredients.some(ingredient => ingredient.manual && !validEstimate(ingredient.estimate ?? emptyEstimate()))) { setError('Enter finite, non-negative nutrient estimates no greater than 100,000,000.'); return; }
    if (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 100) { setError('Prepare between 1 and 100 whole portions.'); return; }
    try {
      let generatedId = 0;
      const prepared = prepareFoodBankPortions(foods, ingredients.map((ingredient): BankIngredientInput => ingredient.manual ? { manual: { name: ingredient.estimateName ?? '', ...estimateMacros(ingredient.estimate ?? emptyEstimate()) } } : inPieces(ingredient) ? { foodId: ingredient.foodId, pieces: Number(ingredient.quantity) } : { foodId: ingredient.foodId, quantity: Number(ingredient.quantity) }), Number(count), name.trim() || autoName, () => `${form.draft.draftBatchId}:${generatedId++}`);
      setSubmitting(true);
      await onSave(prepared);
      form.clearDraft();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'These portions couldn’t be prepared. Check the ingredients and amounts.'); }
    finally { setSubmitting(false); }
  }
  return <>
    <BankHeader title="Prepare portions" onClose={closeEditor}/>
    <form className="cal-form cal-bank-editor" onSubmit={submit}>
      <DraftRestoredNotice {...form} disabled={submitting} discardDraft={() => { form.discardDraft(); setError(''); }}/>
      <fieldset className="cal-form cal-food-editor-fields" disabled={submitting}>
      <div className="cal-form-grid cal-bank-name-grid"><label>Portion name <small className="cal-field-hint">Optional</small><input value={name} onChange={event => setName(event.target.value)} placeholder={autoName || 'e.g. Chicken and rice'} maxLength={160}/></label><label>Number of portions<input type="number" inputMode="numeric" value={count} onChange={event => { setCount(event.target.value); setError(''); }} min={1} max={100} step={1} required/></label></div>
      <div className="cal-bank-section-heading"><strong id={`${id}-amounts`}>Amounts per portion</strong><span>Each portion gets these amounts.</span></div>
      <div className="cal-bank-ingredient-rows">{ingredients.map((ingredient, index) => {
        const filtered = foods.filter(food => matches(food, ingredient.query));
        const food = selectedFood(ingredient);
        const fieldId = `${id}-${ingredient.key}`;
        const estimate = ingredient.estimate ?? emptyEstimate();
        return <fieldset className="cal-bank-ingredient-row" key={ingredient.key}><legend>Ingredient {index + 1}</legend>
          <div className="cal-entry-mode-switch cal-bank-source-switch" role="group" aria-label={`Ingredient ${index + 1} from`}>{[false, true].map(manual => <button key={String(manual)} type="button" className={Boolean(ingredient.manual) === manual ? 'is-active' : ''} aria-pressed={Boolean(ingredient.manual) === manual} onClick={() => changeIngredientSource(ingredient.key, manual)} disabled={!manual && foods.length === 0}>{manual ? 'Manual estimate' : 'Food library'}</button>)}</div>
          {ingredient.manual ? <div className="cal-bank-estimate-fields">
          <label>Name<input value={ingredient.estimateName ?? ''} onChange={event => updateIngredient(ingredient.key, current => ({ ...current, estimateName: event.target.value }))} placeholder="e.g. Homemade curry" maxLength={160} required/></label>
          <div className="cal-form-grid"><NumericField label="Protein" value={estimate.protein} onChange={value => changeEstimate(ingredient.key, 'protein', value)} required={false} placeholder="0"/><NumericField label="Carbohydrate" value={estimate.carbs} onChange={value => changeEstimate(ingredient.key, 'carbs', value)} required={false} placeholder="0"/><NumericField label="Fat" value={estimate.fat} onChange={value => changeEstimate(ingredient.key, 'fat', value)} required={false} placeholder="0"/><NumericField label="Fibre" value={estimate.fiber} onChange={value => changeEstimate(ingredient.key, 'fiber', value)} required={false} placeholder="0"/></div>
          <div className="cal-bank-estimate-footer"><small>{number(validEstimate(estimate) ? estimateMacros(estimate).calories : 0, 0)} kcal per portion</small>{ingredients.length > 1 && <button className="cal-icon-button cal-bank-touch" type="button" aria-label={`Remove ingredient ${index + 1}`} onClick={() => { setIngredients(current => current.filter(item => item.key !== ingredient.key)); setError(''); }}><BankIcon name="trash" size={17}/></button>}</div>
          </div> : <div className="cal-bank-ingredient-fields">
          <div className="cal-food-picker"><label htmlFor={`${fieldId}-search`}>Food</label><div className="cal-food-picker-controls"><input id={`${fieldId}-search`} type="text" value={ingredient.query} onChange={event => filterIngredient(ingredient.key, event.target.value)} placeholder="Filter food names" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={`${fieldId}-matches`}/><select aria-label={`Food for ingredient ${index + 1}`} value={food?.id ?? ''} onChange={event => updateIngredient(ingredient.key, current => event.target.value === current.foodId ? current : { ...current, foodId: event.target.value, quantity: '', byPiece: undefined })} disabled={filtered.length === 0} required>{filtered.length === 0 && <option value="" disabled>No matching foods</option>}{filtered.map(food => <option key={food.id} value={food.id}>{food.name} · {food.state}</option>)}</select></div><small className="cal-bank-match-count" id={`${fieldId}-matches`} role="status">{filtered.length === 0 ? 'No matching foods' : ingredient.query.trim() ? `${filtered.length} matching ${filtered.length === 1 ? 'food' : 'foods'}` : ''}</small></div>
          <label>Amount per portion<span className="cal-unit-input"><input type="number" inputMode="decimal" value={ingredient.quantity} onChange={event => updateIngredient(ingredient.key, current => ({ ...current, quantity: event.target.value }))} placeholder="Amount" min={0.001} max={100000000} step="any" required aria-describedby={`${id}-amounts`}/><span>{food ? inPieces(ingredient, food) ? 'pieces' : food.unit : '—'}</span></span></label>
          {food && canLogPieces(food) && <div className="cal-entry-mode-switch cal-amount-unit-switch" role="group" aria-label={`Amount of ingredient ${index + 1} in`}>{[true, false].map(pieces => <button key={String(pieces)} type="button" className={inPieces(ingredient, food) === pieces ? 'is-active' : ''} aria-pressed={inPieces(ingredient, food) === pieces} onClick={() => changeIngredientUnit(ingredient, food, pieces)}>{pieces ? `Pieces (${number(food.pieceWeight ?? 0, 2)} ${food.unit} each)` : food.unit === 'ml' ? 'Millilitres' : 'Grams'}</button>)}</div>}
          {ingredients.length > 1 && <button className="cal-icon-button cal-bank-touch cal-bank-remove-ingredient" type="button" aria-label={`Remove ingredient ${index + 1}`} onClick={() => { setIngredients(current => current.filter(item => item.key !== ingredient.key)); setError(''); }}><BankIcon name="trash" size={17}/></button>}
        </div>}</fieldset>;
      })}</div>
      <button className="cal-text-button cal-bank-add-ingredient cal-bank-touch" type="button" onClick={addIngredient} disabled={ingredients.length >= 50}><BankIcon name="plus" size={17}/>{ingredients.length >= 50 ? '50 ingredients maximum' : 'Add ingredient'}</button>
      <div className="cal-bank-editor-preview" aria-live="polite"><BankNutrition totals={preview} label="Nutrition per portion"/>{!previewComplete && <p>Add every amount to complete the preview.</p>}</div>
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={closeEditor} disabled={submitting}>Cancel</button><button className="cal-button cal-button-primary" type="submit" disabled={submitting}>{submitting ? 'Saving portions…' : <>Prepare {Number.isInteger(Number(count)) && Number(count) > 0 && Number(count) <= 100 ? `${number(Number(count), 0)} ${Number(count) === 1 ? 'portion' : 'portions'}` : 'portions'}</>}<BankIcon name="check" size={17}/></button></div>
    </form>
  </>;
}

export function FoodBankConsume({ portion, date, onSave, onClose }: { portion: BankPortion; date: string; onSave: (date: string, meal: string) => void | Promise<void>; onClose: () => void }) {
  const [entryDate, setEntryDate] = useState(date);
  const [meal, setMeal] = useState<string>(() => mealForTime());
  const [customMeal, setCustomMeal] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const selectedMeal = meal === 'Custom' ? customMeal.trim() : meal;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || Number.isNaN(Date.parse(`${entryDate}T12:00:00Z`)) || new Date(`${entryDate}T12:00:00Z`).toISOString().slice(0, 10) !== entryDate || !selectedMeal) { setError('Choose a date and meal for this portion.'); return; }
    setSubmitting(true);
    try { await onSave(entryDate, selectedMeal); } catch (caught) { setError(caught instanceof Error ? caught.message : 'This portion couldn’t be logged. Try again.'); }
    finally { setSubmitting(false); }
  }
  return <>
    <BankHeader title="Eat a prepared portion" onClose={onClose}/>
    <div className="cal-bank-consume-summary"><h3>{portion.name}</h3><BankIngredients portion={portion}/><BankNutrition totals={sumNutrition(portion.items)}/></div>
    <form className="cal-form cal-bank-consume-form" onSubmit={submit}>
      <fieldset className="cal-form cal-food-editor-fields" disabled={submitting}>
      <div className="cal-form-grid"><label>Date<input type="date" value={entryDate} onChange={event => { setEntryDate(event.target.value); setError(''); }} required/></label><label>Meal<select value={meal} onChange={event => { setMeal(event.target.value); setError(''); }}>{['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Custom'].map(meal => <option key={meal}>{meal}</option>)}</select></label></div>
      {meal === 'Custom' && <label>Meal name or number<input value={customMeal} onChange={event => { setCustomMeal(event.target.value); setError(''); }} placeholder="e.g. Meal 1" maxLength={80} required/></label>}
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={onClose} disabled={submitting}>Cancel</button><button className="cal-button cal-button-primary" type="submit" disabled={submitting}>{submitting ? 'Logging…' : 'Eat and log'}<BankIcon name="check" size={17}/></button></div>
    </form>
  </>;
}
