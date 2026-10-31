import { useEffect, useState, type FormEvent } from 'react';
import { canLogPieces, energyFromMacros, macrosForFood, manualMealEntry, quantityFromPieces, normalizeData, todayISO, type DaySettings, type Entry, type Food, type TrackerData } from '../../lib/calories/model';
import { effectiveBurned, type GarminDay, type GarminSnapshot, type GarminStatus } from '../../lib/calories/garmin';
import { DAILY_PROTEIN_GRAMS, macroTargets } from '../../lib/calories/nutrition';
import { adjustedBudget, CARRY_SPREAD_DAYS } from '../../lib/calories/budget';
import { normalizeFoodPhotoDraft, type FoodPhotoDraft, type FoodPhotoRequest } from '../../lib/calories/food-photos';
import FoodPhotoImport from './FoodPhotoImport';
import MealPhotoImport from './MealPhotoImport';
import { normalizeMealPhotoDraft, type MealPhotoDraft, type MealPhotoRequest } from '../../lib/calories/meal-photos';
import { usePersistentFormDraft, DraftRestoredNotice } from './FormDrafts';
import { mealForTime } from '../../lib/calories/food-order';
import { Icon, ModalHeader, NumericField, number, signedNumber, readableDate, downloadFile, errorMessage, newId, unitLabel, previewNumber, syncTime, burnedFormula, burnedSyncTime, staleImport, garminStatusLabel, garminErrorMeaning, stateLabel } from './ui';
import { t } from '../../lib/calories/i18n';

export function EntryEditor({ entry, initialFoodId, initialMeal, lastQuantities = {}, recentFoodIds, recentWindow = 7, foods, date, onSave, readMealPhoto, onAddFood, onFoodBank, bankCount, onClose }: { entry?: Entry; initialFoodId?: string; initialMeal?: string; lastQuantities?: Record<string, { quantity: number; pieces?: number }>; recentFoodIds?: ReadonlySet<string>; recentWindow?: number; foods: Food[]; date: string; onSave: (entry: Entry, originalRecordJson: string) => void | Promise<void>; readMealPhoto: (input: MealPhotoRequest, signal: AbortSignal) => Promise<MealPhotoDraft>; onAddFood: () => void; onFoodBank: () => void; bankCount: number; onClose: () => void }) {
  const manualEditing = entry?.source === 'manual' || Boolean(entry && entry.foodId === `manual:${entry.id}`);
  const initialFood = foods.find(food => food.id === (manualEditing ? initialFoodId : entry?.foodId ?? initialFoodId)) ?? foods.find(food => recentFoodIds?.has(food.id)) ?? foods[0];
  const standardMeals = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
  // A new food starts at the amount last logged; otherwise at one piece, or the label quantity.
  const startAmount = (food: Food) => {
    const last = lastQuantities[food.id];
    if (canLogPieces(food) && (!last || last.pieces !== undefined)) return { quantity: String(last?.pieces ?? 1), byPiece: true };
    return { quantity: String(last?.quantity ?? food.baseQuantity), byPiece: false };
  };
  const newMeal = initialMeal ?? mealForTime();
  const form = usePersistentFormDraft(entry ? `entry:${entry.id}` : 'entry:new', {
    draftEntryId: entry?.id ?? newId(),
    originalRecordJson: JSON.stringify(entry ?? null),
    mode: (entry ? manualEditing ? 'manual' : 'library' : foods.length ? 'library' : 'manual') as 'library' | 'manual',
    foodId: manualEditing ? '' : entry ? entry.foodId : initialFood?.id ?? '', foodFilter: '',
    ...(!manualEditing && entry ? { quantity: String(entry.pieces ?? entry.quantity), byPiece: entry.pieces !== undefined } : initialFood ? startAmount(initialFood) : { quantity: '100', byPiece: false }),
    manualName: manualEditing ? entry?.foodName ?? '' : '',
    manualNutrients: { protein: manualEditing ? String(entry?.protein ?? '') : '', carbs: manualEditing ? String(entry?.carbs ?? '') : '', fat: manualEditing ? String(entry?.fat ?? '') : '', fiber: manualEditing ? String(entry?.fiber ?? '') : '' },
    mealChoice: (meal => standardMeals.includes(meal) ? meal : 'Custom')(entry?.meal ?? newMeal), customMeal: entry?.meal ?? (standardMeals.includes(newMeal) ? '' : newMeal), entryDate: entry?.date ?? date,
  }, value => ({ kind: 'entry', label: entry ? t('Edit {name}', { name: entry.foodName }) : value.manualName.trim() || t('New food entry'), ...(value.entryDate ? { date: value.entryDate } : {}), ...(entry ? { entryId: entry.id } : value.mode === 'library' && value.foodId ? { foodId: value.foodId } : {}) }));
  useEffect(() => {
    const explicitFood = !entry && initialFoodId ? foods.find(food => food.id === initialFoodId) : undefined;
    if (explicitFood && form.draft.mode === 'library' && form.draft.foodId !== explicitFood.id) form.setDraft(current => ({ ...current, foodId: explicitFood.id, foodFilter: '', ...startAmount(explicitFood) }));
  }, [entry?.id, initialFoodId]);
  const [mode, setMode] = form.field('mode');
  const [foodId, setFoodId] = form.field('foodId');
  const [foodFilter, setFoodFilter] = form.field('foodFilter');
  const [quantity, setQuantity] = form.field('quantity');
  const [byPiece, setByPiece] = form.field('byPiece');
  function startFood(food: Food) { const start = startAmount(food); setQuantity(start.quantity); setByPiece(start.byPiece); }
  const [manualName, setManualName] = form.field('manualName');
  const [manualNutrients, setManualNutrients] = form.field('manualNutrients');
  const [mealChoice, setMealChoice] = form.field('mealChoice');
  const [customMeal, setCustomMeal] = form.field('customMeal');
  const [entryDate, setEntryDate] = form.field('entryDate');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showAllFoods, setShowAllFoods] = useState(false);
  // Only a library entry contributes its original nutrient snapshot to the food picker.
  const savedFood: Food | undefined = entry && !manualEditing ? { id: entry.foodId, name: entry.foodName, baseQuantity: entry.quantity, unit: entry.unit, state: entry.state, ...(entry.pieces !== undefined ? { pieceWeight: entry.quantity / entry.pieces } : {}), carbs: entry.carbs, protein: entry.protein, fat: entry.fat, fiber: entry.fiber, calories: entry.calories } : undefined;
  const choices = savedFood ? [savedFood, ...foods.filter(food => food.id !== savedFood.id)] : foods;
  const matches = (food: Food, query: string) => food.name.toLowerCase().includes(query.trim().toLowerCase());
  // Without a search, the picker lists only foods logged in the chosen window, plus the food already chosen.
  const isListed = (food: Food, query: string) => matches(food, query) && (showAllFoods || query.trim() !== '' || !recentFoodIds?.size || recentFoodIds.has(food.id) || food.id === savedFood?.id || food.id === initialFoodId || food.id === foodId);
  const filteredFoods = choices.filter(food => isListed(food, foodFilter));
  const hiddenFoods = foodFilter.trim() ? 0 : choices.length - filteredFoods.length;
  const selectedFood = filteredFoods.find(food => food.id === foodId);
  const piecesAllowed = Boolean(selectedFood && canLogPieces(selectedFood));
  const loggingPieces = piecesAllowed && byPiece;
  // The amount in the food's own unit (g, ml or pieces), whichever way it was entered.
  const amountOf = (value: number) => loggingPieces && selectedFood ? quantityFromPieces(selectedFood, value) : value;
  const preview = selectedFood ? macrosForFood(selectedFood, amountOf(previewNumber(quantity))) : null;
  function changeAmountUnit(pieces: boolean) {
    if (!selectedFood?.pieceWeight || pieces === loggingPieces) return;
    const value = Number(quantity);
    // Convert what was typed so the portion stays the same.
    if (quantity.trim() && Number.isFinite(value) && value > 0) setQuantity(String(Math.round((pieces ? value / selectedFood.pieceWeight : value * selectedFood.pieceWeight) * 100) / 100));
    setByPiece(pieces); setError('');
  }
  const estimatedValue = (value: string) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e8 ? parsed : 0; };
  const manualPreview = { protein: estimatedValue(manualNutrients.protein), carbs: estimatedValue(manualNutrients.carbs), fat: estimatedValue(manualNutrients.fat), fiber: estimatedValue(manualNutrients.fiber) };
  const manualEnergy = energyFromMacros(manualPreview);
  function filterFoods(value: string) {
    setFoodFilter(value);
    const first = choices.find(food => isListed(food, value));
    setFoodId(first?.id ?? '');
    if (first && first.id !== foodId) startFood(first);
    setError('');
  }
  function changeMode(next: 'library' | 'manual') {
    if (next === 'library' && !selectedFood) {
      const first = filteredFoods[0];
      setFoodId(first?.id ?? '');
      if (first) startFood(first);
    }
    setMode(next); setError('');
  }
  function applyMealPhoto(raw: MealPhotoDraft) {
    const draft = normalizeMealPhotoDraft(raw);
    if (draft.name !== null) setManualName(draft.name);
    setManualNutrients({
      protein: draft.protein === null ? '' : String(draft.protein), carbs: draft.carbs === null ? '' : String(draft.carbs),
      fat: draft.fat === null ? '' : String(draft.fat), fiber: draft.fiber === null ? '' : String(draft.fiber),
    });
    setError('');
  }
  function changeManualNutrient(key: keyof typeof manualNutrients, value: string) { setManualNutrients(current => ({ ...current, [key]: value })); setError(''); }
  function closeEditor() { form.clearDraft(); onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (photoBusy || submitting) return;
    const meal = mealChoice === 'Custom' ? customMeal.trim() : mealChoice;
    if (!meal) { setError(t('Add a meal name or number.')); return; }
    if (mode === 'manual') {
      if (!manualName.trim()) { setError(t('Give your estimated meal a name.')); return; }
      if (Object.values(manualNutrients).some(value => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e8) || !Number.isFinite(manualEnergy) || manualEnergy > 1e8) { setError(t('Enter finite, non-negative nutrient totals. Each value and the calculated energy must be no more than 100,000,000.')); return; }
      setSubmitting(true);
      try { await onSave(manualMealEntry({ id: form.draft.draftEntryId, date: entryDate, meal, name: manualName.trim(), protein: Number(manualNutrients.protein), carbs: Number(manualNutrients.carbs), fat: Number(manualNutrients.fat), fiber: Number(manualNutrients.fiber) }), form.draft.originalRecordJson); form.clearDraft(); }
      catch (error) { setError(errorMessage(error)); }
      finally { setSubmitting(false); }
      return;
    }
    if (!selectedFood || !preview || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0 || Number(quantity) > 1e8) { setError(t('Choose a food and a quantity greater than zero.')); return; }
    // A fresh library object removes a manual source flag when the entry changes modes.
    setSubmitting(true);
    try { await onSave({ id: form.draft.draftEntryId, date: entryDate, meal, foodId: selectedFood.id, foodName: selectedFood.name, quantity: amountOf(Number(quantity)), unit: selectedFood.unit, state: selectedFood.state, ...(loggingPieces ? { pieces: Number(quantity) } : {}), ...preview }, form.draft.originalRecordJson); form.clearDraft(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSubmitting(false); }
  }
  return <>
    <ModalHeader title={t(entry ? 'Edit entry' : 'Log food')} eyebrow={t(entry ? 'DAILY JOURNAL' : 'LOG A FOOD')} onClose={closeEditor}/>
    <form className="cal-form" onSubmit={submit}>
      <DraftRestoredNotice {...form} disabled={photoBusy || submitting} discardDraft={() => { form.discardDraft(); setError(''); }}/>
      <div className={`cal-entry-mode-switch${!entry && bankCount ? ' cal-entry-mode-with-bank' : ''}`} role="group" aria-label={t('Entry method')}><button type="button" disabled={submitting} className={mode === 'library' ? 'is-active' : ''} aria-pressed={mode === 'library'} onClick={() => changeMode('library')}>{t('Food library')}</button><button type="button" disabled={submitting} className={mode === 'manual' ? 'is-active' : ''} aria-pressed={mode === 'manual'} onClick={() => changeMode('manual')}>{t('Manual estimate')}</button>{!entry && bankCount > 0 && <button type="button" disabled={submitting} onClick={onFoodBank}>{t('Food bank ({count})', { count: bankCount })}</button>}</div>
      {mode === 'manual' && <fieldset className="cal-food-editor-fields" disabled={submitting}><MealPhotoImport readPhoto={readMealPhoto} description={manualName} onDraft={applyMealPhoto} onBusyChange={setPhotoBusy}/></fieldset>}
      <fieldset className="cal-form cal-food-editor-fields" disabled={photoBusy || submitting}>
      {mode === 'library' ? <>
        <div className="cal-food-picker" role="group" aria-labelledby="cal-entry-food-label"><label id="cal-entry-food-label" htmlFor="cal-entry-food-filter">{t('Food')}</label><div className="cal-food-picker-controls"><input id="cal-entry-food-filter" type="text" aria-label={t('Filter foods')} aria-describedby="cal-entry-food-matches" value={foodFilter} onChange={event => filterFoods(event.target.value)} placeholder={t('Type part of a food name')} autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus/><select aria-label={t('Food')} aria-describedby="cal-entry-food-matches" value={foodId} onChange={event => { const food = filteredFoods.find(item => item.id === event.target.value); setFoodId(food?.id ?? ''); if (food) startFood(food); setError(''); }} required disabled={filteredFoods.length === 0}>{filteredFoods.length === 0 && <option value="" disabled>{t('No matching foods')}</option>}{filteredFoods.map(food => <option key={food.id} value={food.id}>{food.name}{food.id === savedFood?.id ? ` ${t('(saved entry)')}` : ''} · {stateLabel(food.state)}</option>)}</select></div><small className="cal-field-hint" id="cal-entry-food-matches" role="status">{filteredFoods.length === 0 ? t(foods.length === 0 && !savedFood ? 'Your library is empty. Add a food below or choose Manual estimate.' : 'No matching foods. Try another name or add a food below.') : foodFilter.trim() ? t(filteredFoods.length === 1 ? '{count} matching food' : '{count} matching foods', { count: filteredFoods.length }) : hiddenFoods ? t('Showing foods logged in the last {days} days. Type to search all {count}.', { days: recentWindow, count: choices.length }) : t('Type to filter the food list.')}</small>{hiddenFoods > 0 && <button className="cal-text-button cal-show-all-foods" type="button" onClick={() => setShowAllFoods(true)}>{t('Show all foods ({count} hidden)', { count: hiddenFoods })}</button>}</div>
        <button className="cal-text-button cal-add-food-inline" type="button" onClick={onAddFood}><Icon name="plus" size={15}/>{t('Add a new food to your library')}</button>
      </> : <>
        <label>{t('Meal / restaurant name')}<input value={manualName} onChange={event => { setManualName(event.target.value); setError(''); }} placeholder={t('e.g. Restaurant lunch')} required maxLength={160} autoFocus/></label>
        <p className="cal-field-hint">{t('Enter the estimated nutrient totals for the entire meal or portion you ate. Leave blank for zero.')}</p>
        <div className="cal-form-grid"><NumericField label={t('Protein total')} value={manualNutrients.protein} onChange={value => changeManualNutrient('protein', value)} required={false}/><NumericField label={t('Carbohydrate total')} value={manualNutrients.carbs} onChange={value => changeManualNutrient('carbs', value)} required={false}/><NumericField label={t('Fat total')} value={manualNutrients.fat} onChange={value => changeManualNutrient('fat', value)} required={false}/><NumericField label={t('Fibre total')} value={manualNutrients.fiber} onChange={value => changeManualNutrient('fiber', value)} required={false}/></div>
      </>}
      {mode === 'library' && piecesAllowed && selectedFood && <div className="cal-entry-mode-switch cal-amount-unit-switch" role="group" aria-label={t('Log amount in')}><button type="button" className={loggingPieces ? 'is-active' : ''} aria-pressed={loggingPieces} onClick={() => changeAmountUnit(true)}>{t('Pieces ({weight} each)', { weight: `${number(selectedFood.pieceWeight ?? 0, 2)} ${selectedFood.unit}` })}</button><button type="button" className={!loggingPieces ? 'is-active' : ''} aria-pressed={!loggingPieces} onClick={() => changeAmountUnit(false)}>{t(selectedFood.unit === 'ml' ? 'Millilitres' : 'Grams')}</button></div>}
      <div className="cal-form-grid">{mode === 'library' && <NumericField label={t('Quantity')} value={quantity} onChange={setQuantity} unit={loggingPieces ? unitLabel('piece', Number(quantity)) : selectedFood?.unit ?? 'g'} min={0.001}/>}<label>{t('Meal')}<select value={mealChoice} onChange={event => setMealChoice(event.target.value)}>{standardMeals.map(meal => <option key={meal} value={meal}>{t(meal)}</option>)}<option value="Custom">{t('Custom')}</option></select></label>{mode === 'manual' && <label>{t('Date')}<input type="date" value={entryDate} onChange={event => setEntryDate(event.target.value)} required/></label>}</div>
      {mealChoice === 'Custom' && <label>{t('Meal name or number')}<input type="text" value={customMeal} onChange={event => setCustomMeal(event.target.value)} placeholder={t('e.g. Meal 1, late lunch')} required maxLength={80}/></label>}
      {mode === 'library' && <label>{t('Date')}<input type="date" value={entryDate} onChange={event => setEntryDate(event.target.value)} required/></label>}
      {mode === 'manual' ? <div className="cal-budget-preview" aria-live="polite"><span>{t('Estimated energy for this meal')}</span><strong><output aria-label={t('Estimated meal energy')}>{number(manualEnergy, 1)}</output> kcal</strong><p>{t('4 × protein + 4 × carbohydrate + 9 × fat. Fibre is tracked separately.')}</p></div> : preview && <div className="cal-entry-preview"><div><span>{t('This entry')}</span><strong>{number(preview.calories)} <small>kcal</small></strong></div><div className="cal-preview-macros">{([['Protein', preview.protein], ['Carbs', preview.carbs], ['Fat', preview.fat], ['Fibre', preview.fiber]] as const).map(([name, amount]) => <span key={name}>{t(name)}<strong>{number(amount, 1)} g</strong></span>)}</div><p>{selectedFood ? stateLabel(selectedFood.state) : ''} · {loggingPieces ? `${number(amountOf(previewNumber(quantity)), 2)} ${selectedFood?.unit} · ` : ''}{entry && !manualEditing && foodId === entry.foodId ? t('Uses nutrition saved with this entry.') : t('Calculated from your food’s values per {amount}.', { amount: `${number(selectedFood?.baseQuantity ?? 0, 2)} ${selectedFood?.unit}` })}</p></div>}
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={closeEditor} disabled={submitting}>{t('Cancel')}</button><button className="cal-button cal-button-primary" disabled={submitting || photoBusy || (mode === 'library' && !selectedFood)}>{t(submitting ? 'Saving…' : entry ? 'Save changes' : 'Add to journal')}<Icon name="check" size={17}/></button></div>
    </form>
  </>;
}

export function FoodEditor({ food, readPhotos, onSave, onClose }: { food?: Food; readPhotos: (input: FoodPhotoRequest, signal: AbortSignal) => Promise<FoodPhotoDraft>; onSave: (food: Food, originalRecordJson: string) => void | Promise<void>; onClose: () => void }) {
  const form = usePersistentFormDraft(food ? `food:${food.id}` : 'food:new', { draftFoodId: food?.id ?? newId(), originalRecordJson: JSON.stringify(food ?? null), name: food?.name ?? '', baseQuantity: String(food?.baseQuantity ?? 100), unit: (food?.unit ?? 'g') as Food['unit'] | '', state: (food?.state ?? 'As served') as Food['state'], pieceWeight: food?.pieceWeight === undefined ? '' : String(food.pieceWeight), nutrients: { carbs: String(food?.carbs ?? ''), protein: String(food?.protein ?? ''), fat: String(food?.fat ?? ''), fiber: String(food?.fiber ?? '') }, importedLabel: false }, value => ({ kind: 'food', label: value.name.trim() || t('New library food'), ...(food ? { foodId: food.id } : {}) }));
  const [name, setName] = form.field('name');
  const [baseQuantity, setBaseQuantity] = form.field('baseQuantity');
  const [unit, setUnit] = form.field('unit');
  const [state, setState] = form.field('state');
  const [pieceWeight, setPieceWeight] = form.field('pieceWeight');
  const [nutrients, setNutrients] = form.field('nutrients');
  const [importedLabel, setImportedLabel] = form.field('importedLabel');
  const hasNutrients = Object.values(nutrients).some(value => value.trim() !== '');
  const calories = energyFromMacros({ carbs: Math.max(0, Number(nutrients.carbs) || 0), protein: Math.max(0, Number(nutrients.protein) || 0), fat: Math.max(0, Number(nutrients.fat) || 0), fiber: Math.max(0, Number(nutrients.fiber) || 0) });
  const [error, setError] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  function applyPhotos(raw: FoodPhotoDraft) {
    const draft = normalizeFoodPhotoDraft(raw);
    setName(draft.name ?? ''); setBaseQuantity(draft.baseQuantity === null ? '' : String(draft.baseQuantity));
    setUnit(draft.unit ?? ''); setState(draft.state ?? 'As served');
    if (draft.pieceWeight !== null) setPieceWeight(String(draft.pieceWeight));
    setNutrients({ protein: draft.protein === null ? '' : String(draft.protein), carbs: draft.carbs === null ? '' : String(draft.carbs), fat: draft.fat === null ? '' : String(draft.fat), fiber: draft.fiber === null ? '' : String(draft.fiber) });
    setImportedLabel(true); setError('');
  }
  function nutrient(key: keyof typeof nutrients, value: string) { setNutrients(current => ({ ...current, [key]: value })); }
  function closeEditor() { form.clearDraft(); onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (photoBusy || submitting) return;
    const weight = pieceWeight.trim() ? Number(pieceWeight) : undefined;
    if (weight !== undefined && (!Number.isFinite(weight) || weight <= 0 || weight > 1e8)) { setError(t('Leave the piece weight blank or enter a number greater than zero.')); return; }
    if (!name.trim() || !unit || !Number.isFinite(Number(baseQuantity)) || Number(baseQuantity) <= 0 || !Number.isFinite(calories) || calories > 1e8 || Object.values(nutrients).some(value => !Number.isFinite(Number(value)) || Number(value) < 0)) { setError(t('Add a food name, a label quantity greater than zero, a unit, and valid nutrition values.')); return; }
    setSubmitting(true);
    // A piece food with a known weight becomes a gram food, so it can be logged either way.
    const amount = unit === 'piece' && weight !== undefined ? { baseQuantity: Number(baseQuantity) * weight, unit: 'g' as const, pieceWeight: weight } : { baseQuantity: Number(baseQuantity), unit, ...(weight !== undefined ? { pieceWeight: weight } : {}) };
    try { await onSave({ id: form.draft.draftFoodId, name: name.trim(), ...amount, state, carbs: Number(nutrients.carbs), protein: Number(nutrients.protein), fat: Number(nutrients.fat), fiber: Number(nutrients.fiber), calories }, form.draft.originalRecordJson); form.clearDraft(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSubmitting(false); }
  }
  return <>
    <ModalHeader title={t(food ? 'Edit food' : 'Add food')} eyebrow={t('FOOD LIBRARY')} onClose={closeEditor}/>
    <form className="cal-form" onSubmit={submit}>
      <DraftRestoredNotice {...form} disabled={photoBusy || submitting} discardDraft={() => { form.discardDraft(); setError(''); }}/>
      {!food && <fieldset className="cal-food-editor-fields" disabled={submitting}><FoodPhotoImport readPhotos={readPhotos} onDraft={applyPhotos} onBusyChange={setPhotoBusy}/></fieldset>}
      <fieldset className="cal-form cal-food-editor-fields" disabled={photoBusy || submitting}>
        <label>{t('Food name')}<input value={name} onChange={event => setName(event.target.value)} placeholder={t('e.g. Greek yoghurt')} required maxLength={160} autoFocus/></label>
        <div className="cal-form-grid cal-form-grid-three">
          <NumericField label={t('Label quantity')} value={baseQuantity} onChange={setBaseQuantity} unit="" min={0.001}/>
          <label>{t('Unit')}<select value={unit} onChange={event => { const nextUnit = event.target.value as Food['unit']; setUnit(nextUnit); if (!food && !importedLabel) setBaseQuantity(nextUnit === 'piece' ? '1' : '100'); }} required><option value="" disabled>{t('Choose unit')}</option><option value="g">{t('grams (g)')}</option><option value="ml">{t('millilitres (ml)')}</option><option value="piece">{t('piece')}</option></select></label>
          <label>{t('State')}<select value={state} onChange={event => setState(event.target.value as Food['state'])}>{(['As served', 'Raw', 'Cooked'] as const).map(option => <option key={option} value={option}>{stateLabel(option)}</option>)}</select></label>
        </div>
        <NumericField label={t('Weight of one piece')} value={pieceWeight} onChange={setPieceWeight} unit={unit === 'ml' ? 'ml' : 'g'} required={false} placeholder={t('Optional')} describedBy="cal-piece-weight-hint"/>
        <p className="cal-field-hint" id="cal-piece-weight-hint">{t(unit === 'piece' ? 'Optional. Add it to also log this food in grams.' : 'Optional, e.g. 19 g for a slice. Lets you log this food in pieces or by weight.')}</p>
        <div className="cal-form-section-label"><strong>{t('Nutrition per {amount}', { amount: `${baseQuantity || '—'} ${unitLabel(unit, Number(baseQuantity))}` })}</strong><p>{t('Enter the label’s values in grams. Leave blank for zero.')}</p></div>
        <div className="cal-form-grid"><NumericField label={t('Protein')} value={nutrients.protein} onChange={value => nutrient('protein', value)} required={false}/><NumericField label={t('Carbohydrate')} value={nutrients.carbs} onChange={value => nutrient('carbs', value)} required={false}/><NumericField label={t('Fat')} value={nutrients.fat} onChange={value => nutrient('fat', value)} required={false}/><NumericField label={t('Fibre')} value={nutrients.fiber} onChange={value => nutrient('fiber', value)} required={false}/></div>
        <div className="cal-budget-preview" aria-live="polite"><span>{t('Calculated energy')}</span><strong><output aria-label={t('Calculated energy')}>{hasNutrients ? number(calories, 1) : '—'}</output> kcal</strong><p>{t('4 × protein + 4 × carbohydrate + 9 × fat')}</p></div>
        {food && <p className="cal-field-hint">{t('Changes apply to future entries. Previously logged nutrition stays as recorded.')}</p>}
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={closeEditor} disabled={submitting}>{t('Cancel')}</button><button className="cal-button cal-button-primary" disabled={photoBusy || submitting}>{t(submitting ? 'Saving…' : food ? 'Save changes' : 'Save food')}<Icon name="check" size={17}/></button></div>
    </form>
  </>;
}

export function TargetsEditor({ date, currentDay, settings, defaultSettings, garminDays, carryIn, carryIsProvisional, onSave, onClose }: { date: string; currentDay: string; settings: DaySettings; defaultSettings?: DaySettings; garminDays: readonly GarminDay[]; carryIn: number; carryIsProvisional: boolean; onSave: (settings: DaySettings, makeDefault: boolean, originalRecordJson: string, originalDefaultsJson: string) => void | Promise<void>; onClose: () => void }) {
  const form = usePersistentFormDraft(`targets:${date}`, { originalRecordJson: JSON.stringify(settings), originalDefaultsJson: JSON.stringify(defaultSettings ?? null), burned: settings.burned === 0 && settings.burnedSource !== 'manual' ? '' : String(settings.burned), source: (settings.burnedSource ?? 'garmin') as 'manual' | 'garmin', deficit: String(settings.deficit), activeEstimate: settings.activeEstimate === undefined ? '' : String(settings.activeEstimate), makeDefault: false }, { kind: 'targets', label: t('Targets for {date}', { date: readableDate(date, { day: 'numeric', month: 'short', year: 'numeric' }) }), date });
  const [burned, setBurned] = form.field('burned');
  const [source, setSource] = form.field('source');
  const [deficit, setDeficit] = form.field('deficit');
  const [activeEstimate, setActiveEstimate] = form.field('activeEstimate');
  const canEstimateActive = source === 'garmin' && date === currentDay;
  const estimate = canEstimateActive && activeEstimate.trim() !== '' ? { activeEstimate: previewNumber(activeEstimate) } : {};
  const [makeDefault, setMakeDefault] = form.field('makeDefault');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const resolved = effectiveBurned(date, { deficit: settings.deficit, protein: settings.protein, burned: previewNumber(burned), burnedSource: source, ...estimate }, garminDays, currentDay);
  const effective = resolved.burned;
  const previewDeficit = previewNumber(deficit);
  const previewAllowance = adjustedBudget(effective, previewDeficit, carryIn);
  const previewBudget = previewAllowance.budget;
  const nutritionTargets = macroTargets(previewBudget);
  function closeEditor() { form.clearDraft(); onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if ([deficit, ...(source === 'manual' ? [burned] : []), ...('activeEstimate' in estimate ? [activeEstimate] : [])].some(value => value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e8)) { setError(t('Enter finite, non-negative values no greater than 100,000,000.')); return; }
    if (source === 'manual' && Number(deficit) > Number(burned)) { setError(t('For a manual estimate, the deficit target cannot be greater than calories burned.')); return; }
    setSubmitting(true);
    try { await onSave({ burned: previewNumber(burned), deficit: Number(deficit), protein: DAILY_PROTEIN_GRAMS, burnedSource: source, ...estimate }, makeDefault, form.draft.originalRecordJson, form.draft.originalDefaultsJson); form.clearDraft(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSubmitting(false); }
  }
  return <>
    <ModalHeader title={t('Daily targets')} eyebrow={readableDate(date, { day: 'numeric', month: 'long' }).toUpperCase()} onClose={closeEditor}/>
    <p className="cal-modal-intro">{t('Choose your deficit target and where calories burned comes from.')}</p>
    <p className="cal-target-date-hint" id="cal-deficit-date-hint">{t('Changes apply to {date}. Leave the default-target option unchecked to edit only this date.', { date: readableDate(date, { day: 'numeric', month: 'long', year: 'numeric' }) })}</p>
    <form className="cal-form" onSubmit={submit}>
      <DraftRestoredNotice {...form} disabled={submitting} discardDraft={() => { form.discardDraft(); setError(''); }}/>
      <fieldset className="cal-form cal-food-editor-fields" disabled={submitting}>
      <label>{t('Calories burned source')}<select value={source} onChange={event => setSource(event.target.value as 'manual' | 'garmin')}><option value="garmin">{t('Garmin Connect (automatic)')}</option><option value="manual">{t('Manual estimate / override')}</option></select></label>
      {source === 'garmin' ? <>
        <label>{t(resolved.unavailable ? 'Garmin calories burned unavailable' : resolved.restingEstimate ? 'Garmin resting estimate' : resolved.predicted ? 'Predicted calories burned' : resolved.predictionUnavailable ? 'Garmin calories burned so far' : 'Calories burned from Garmin')}<span className="cal-unit-input"><input type="text" value={resolved.unavailable ? '—' : number(resolved.burned, 1)} readOnly aria-describedby="cal-garmin-target-detail"/><span>kcal</span></span></label>
        <p className="cal-field-hint" id="cal-garmin-target-detail">{burnedFormula(resolved)}.{burnedSyncTime(resolved) ? ` ${burnedSyncTime(resolved)}.` : ''}{!resolved.unavailable && date === currentDay ? ` ${t('Today’s value is provisional and updates with imported readings.')}` : ''}</p>
        {canEstimateActive && <>
          <NumericField label={t('Your estimate of today’s active calories')} value={activeEstimate} onChange={setActiveEstimate} unit="kcal" required={false} placeholder={t('Use Garmin')} describedBy="cal-active-estimate-hint"/>
          <p className="cal-field-hint" id="cal-active-estimate-hint">{t('Optional. Your full-day estimate replaces Garmin’s active calories so far, plus resting calories from the last full day. Once today ends, Garmin’s actual reading is used instead. Leave blank to use Garmin.')}{'activeEstimate' in estimate && resolved.activeEstimate === undefined ? ` ${t('No completed Garmin resting reading is available yet, so the estimate is not used.')}` : ''}</p>
        </>}
      </> : <>
        <NumericField label={t('Manual calories burned')} value={burned} onChange={setBurned} unit="kcal"/>
        <p className="cal-field-hint">{t('This value overrides Garmin for this date, even when imported readings are available.')}</p>
      </>}
      <NumericField label={t('Deficit target for this date')} value={deficit} onChange={setDeficit} unit="kcal" describedBy="cal-deficit-date-hint"/>
      <label>{t('Daily protein target')}<span className="cal-unit-input"><input type="number" value={DAILY_PROTEIN_GRAMS} readOnly aria-describedby="cal-macro-rule"/><span>g</span></span></label>
      <p className="cal-field-hint" id="cal-macro-rule">{t('Protein: {protein} g/day. Fat: 25% of daily budget. Carbs: remaining energy after protein and fat. Fibre: 0.014 g per kcal of daily budget.', { protein: DAILY_PROTEIN_GRAMS })}</p>
      <div className="cal-budget-preview"><span>{t(carryIsProvisional ? 'Provisional food budget with carry' : resolved.predicted ? 'Predicted food budget with carry' : 'Food budget with carry')}</span><strong>{number(previewBudget, 1)} kcal</strong><div className="cal-target-carry-preview"><span>{t('Base budget')}<strong>{number(previewAllowance.baseBudget, 1)} kcal</strong></span><span>{t(carryIsProvisional ? 'Carry from last {days} days (provisional)' : 'Carry from last {days} days', { days: CARRY_SPREAD_DAYS })}<strong>{signedNumber(carryIn)} kcal</strong></span></div><p>{t('Base budget is calories burned minus the deficit target, with a minimum of 0. Carry adds one seventh of each of the last {days} days’ differences from their budgets.', { days: CARRY_SPREAD_DAYS })}</p><div className="cal-target-macro-preview"><span>{t('Protein')}<strong>{number(nutritionTargets.protein, 1)} g</strong></span><span>{t('Carbs')}<strong>{number(nutritionTargets.carbs, 1)} g</strong></span><span>{t('Fat')}<strong>{number(nutritionTargets.fat, 1)} g</strong></span><span>{t('Fibre')}<strong>{number(nutritionTargets.fiber, 1)} g</strong></span></div></div>
      {carryIsProvisional && <p className="cal-field-hint">{t('Includes today’s provisional balance; updates as food or Garmin data changes.')}</p>}
      {!resolved.unavailable && previewAllowance.deferredDebt > 0 && <p className="cal-macro-budget-note">{t('If you eat this {budget} kcal budget, {debt} kcal of debt remains for later days.', { budget: number(previewBudget, 1), debt: number(previewAllowance.deferredDebt, 1) })}</p>}
      {nutritionTargets.budgetTooLow && <p className="cal-macro-budget-note">{t('Current calorie budget is too low for {protein} g protein and 25% fat. Carb target is 0 g.', { protein: DAILY_PROTEIN_GRAMS })}</p>}
      <label className="cal-checkbox"><input type="checkbox" checked={makeDefault} onChange={event => setMakeDefault(event.target.checked)}/><span>{t('Use this deficit target as my default')}<small>{t('Applies to days without their own saved targets. Manual calories burned applies only to this date; new days use Garmin.')}</small></span></label>
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={closeEditor} disabled={submitting}>{t('Cancel')}</button><button className="cal-button cal-button-primary" disabled={submitting}>{t(submitting ? 'Saving…' : 'Save targets')}<Icon name="check" size={17}/></button></div>
    </form>
  </>;
}

export function GarminConnection({ date, currentDay, snapshot, loading, disconnecting, error, onRefresh, onDisconnect, onClose }: { date: string; currentDay: string; snapshot: GarminSnapshot; loading: boolean; disconnecting: boolean; error: string; onRefresh: () => void; onDisconnect: () => void; onClose: () => void }) {
  const { status } = snapshot;
  const reading = effectiveBurned(date, { burned: 0, deficit: 0, protein: 0, burnedSource: 'garmin' }, snapshot.days, currentDay);
  const day = reading.day;
  const descriptions: Record<GarminStatus['state'], string> = {
    not_connected: t(snapshot.days.length ? 'Automatic imports are disconnected. Previously imported calorie readings are kept. Follow the guide to reconnect your account.' : 'One-time sign-in is needed. Follow the guide to connect your Garmin account. Hourly imports are already configured.'),
    connected: t(staleImport(status.last_sync_at) ? 'A new import is needed. Your last successful import was more than two hours ago. Previously imported readings are kept.' : 'Your imported active and resting calories are available across your devices.'),
    needs_login: t('Garmin needs you to sign in again. Follow the connection step in the setup guide to resume imports.'),
    error: t('The latest Garmin import did not complete. Existing readings are kept. Check the setup guide and try refreshing after the next import.'),
  };
  return <>
    <ModalHeader title="Garmin Connect" eyebrow={t('ACTIVITY IMPORTS')} onClose={onClose}/>
    <div className={`cal-garmin-status-card cal-garmin-state-${status.state} ${status.state === 'connected' && staleImport(status.last_sync_at) ? 'cal-garmin-stale' : ''}`}><span className="cal-garmin-symbol"><Icon name="watch" size={25}/></span><div><strong>{garminStatusLabel(status)}</strong><p>{descriptions[status.state]}</p></div></div>
    {error && <p className="cal-form-error cal-garmin-read-error" role="alert">{t('Couldn’t refresh imported data. {error} Your food journal is still available.', { error })}</p>}
    <dl className="cal-garmin-times"><div><dt>{t('Last successful import')}</dt><dd>{status.last_sync_at ? syncTime(status.last_sync_at) : t('No successful import yet')}</dd></div><div><dt>{t('Last import attempt')}</dt><dd>{status.last_attempt_at ? syncTime(status.last_attempt_at) : t('No attempt recorded')}</dd></div></dl>
    {status.last_error_code && <p className="cal-garmin-import-note">{garminErrorMeaning(status.last_error_code)}</p>}
    {day && <div className="cal-garmin-day-card">
      <div><strong>{readableDate(date, { day: 'numeric', month: 'long' })}</strong><span>{t(reading.predicted ? 'Prediction' : date === currentDay ? 'Provisional total so far' : 'Imported reading')}</span></div>
      <div className="cal-garmin-day-values">
        <span>{t(date === currentDay ? 'Active today' : 'Active')}<strong>{number(day.active)} <small>kcal</small></strong></span>
        <span>{reading.predicted && reading.restingDay ? <>{t('Resting yesterday')}<em>{readableDate(reading.restingDay.date, { day: 'numeric', month: 'short' })}</em></> : t(date === currentDay ? 'Resting so far' : 'Resting')}<strong>{number(reading.predicted && reading.restingDay ? reading.restingDay.resting : day.resting)} <small>kcal</small></strong></span>
        <span>{t(reading.predicted ? 'Predicted burned' : date === currentDay ? 'Total so far' : 'Total burned')}<strong>{number(reading.burned)} <small>kcal</small></strong></span>
      </div>
      <p>{(reading.predicted || reading.predictionUnavailable) && <span className="cal-garmin-formula">{burnedFormula(reading)}.</span>}{burnedSyncTime(reading)}{status.state === 'not_connected' ? `. ${t('Automatic imports are stopped; this reading is kept.')}` : date === currentDay ? `. ${t('Today’s value updates with new imported readings.')}` : '.'}{reading.predicted && <span className="cal-garmin-raw-total">{t('Garmin total so far: {kcal} kcal.', { kcal: number(day.total) })}</span>}</p>
    </div>}
    {!day && reading.restingEstimate && reading.restingDay && <div className="cal-garmin-day-card">
      <div><strong>{readableDate(date, { day: 'numeric', month: 'long' })}</strong><span>{t('Garmin resting estimate')}</span></div>
      <div className="cal-garmin-day-values cal-garmin-estimate-values"><span>{t('Reference day')}<strong>{readableDate(reading.restingDay.date, { day: 'numeric', month: 'short', year: 'numeric' })}</strong></span><span>{t('Estimated burned')}<strong>{number(reading.burned)} <small>kcal</small></strong></span></div>
      <p>{burnedFormula(reading)}. {burnedSyncTime(reading)}.{status.state === 'not_connected' ? ` ${t('Automatic imports are stopped; the reference reading is kept.')}` : ''}</p>
    </div>}
    {!day && reading.unavailable && <div className="cal-garmin-day-card cal-garmin-unavailable-card">
      <div><strong>{readableDate(date, { day: 'numeric', month: 'long' })}</strong><span>{t('Burned unavailable')}</span></div>
      <div className="cal-garmin-unavailable-value">— <small>kcal</small></div>
      <p>{burnedFormula(reading)}. {t('The automatic base budget stays at 0 until a reading is available.')}</p>
    </div>}
    <div className="cal-garmin-help"><a href="/calories/garmin-setup/" target="_blank" rel="noreferrer">{t(status.state === 'not_connected' ? 'Set up Garmin imports' : status.state === 'needs_login' ? 'Reconnect Garmin' : 'Open Garmin setup guide')} ↗</a><p>{t('Automatic imports run hourly while connected. Refresh checks for the latest data already imported into your journal’s storage.')}</p></div>
    {status.state !== 'not_connected' && <button className="cal-text-button cal-danger cal-garmin-disconnect" onClick={onDisconnect} disabled={loading}>{t(disconnecting ? 'Disconnecting…' : 'Disconnect Garmin')}</button>}
    <div className="cal-modal-actions"><button className="cal-button" onClick={onRefresh} disabled={loading}><Icon name="refresh" size={17}/>{t(loading ? 'Refreshing…' : error ? 'Try refresh again' : 'Refresh imported data')}</button><button className="cal-button cal-button-primary" onClick={onClose}>{t('Done')}</button></div>
  </>;
}


export function TransferDialog({ data, onImport, onClose }: { data: TrackerData; onImport: (data: TrackerData) => void | Promise<void>; onClose: () => void }) {
  const [incoming, setIncoming] = useState<TrackerData | null>(null);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const exportDate = todayISO();
  function exportCSV() {
    const columns: (keyof Entry)[] = ['date', 'meal', 'foodName', 'source', 'quantity', 'unit', 'pieces', 'state', 'carbs', 'protein', 'fat', 'fiber', 'calories'];
    const titles = ['Date', 'Meal', 'Food / meal name', 'Entry type', 'Quantity', 'Unit', 'Pieces', 'State', 'Carbs (g)', 'Protein (g)', 'Fat (g)', 'Fibre (g)', 'Calories (kcal)'];
    // Prefix formula-like text (including a leading tab or line break) to keep exported food names safe to open in a spreadsheet.
    const cell = (value: unknown) => { let text = String(value); if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    const csv = [titles.map(cell).join(','), ...[...data.entries].sort((a, b) => a.date.localeCompare(b.date)).map(entry => columns.map(column => cell(column === 'source' ? entry.source === 'manual' ? 'Manual estimate' : 'Food library' : entry.source === 'manual' && (column === 'quantity' || column === 'unit' || column === 'state') ? '' : entry[column] ?? '')).join(','))].join('\r\n');
    downloadFile('\uFEFF' + csv, `calories-entries-${exportDate}.csv`, 'text/csv;charset=utf-8');
  }
  async function selectFile(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(''); setIncoming(null); setFilename('');
    try { if (file.size > 20_000_000) throw new Error(t('This backup is too large. Choose a JSON backup smaller than 20 MB.')); const parsed = normalizeData(JSON.parse(await file.text())); setIncoming(parsed); setFilename(file.name); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function restoreBackup() {
    if (!incoming || busy) return;
    setBusy(true); setError('');
    try {
      // Keep a copy of the journal being replaced; a restore can't be undone in the app.
      downloadFile(JSON.stringify(data, null, 2), `calories-before-restore-${exportDate}.json`, 'application/json');
      await onImport(incoming);
    }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <><ModalHeader title={t('Backup and import')} eyebrow={t('BACKUP & IMPORT')} onClose={onClose}/><div className="cal-transfer-option"><div><strong>{t('Complete backup')}</strong><p>{t('Foods, food bank portions, journal entries, and targets in a JSON file. Use this to restore your journal.')}</p></div><button className="cal-button cal-button-small" onClick={() => downloadFile(JSON.stringify(data, null, 2), `calories-backup-${exportDate}.json`, 'application/json')}><Icon name="download" size={16}/>JSON</button></div><div className="cal-transfer-option"><div><strong>{t('Spreadsheet export')}</strong><p>{t('All logged entries, quantities, and nutrition. Opens in Numbers or Google Sheets.')}</p></div><button className="cal-button cal-button-small" onClick={exportCSV}><Icon name="download" size={16}/>CSV</button></div><div className="cal-import-section"><h3>{t('Restore a backup')}</h3><p>{t('Choose a JSON file previously exported from this app.')}</p><label className="cal-file-label">{t(busy ? 'Reading backup…' : 'Choose JSON backup')}<input type="file" accept=".json,application/json" onChange={event => void selectFile(event.target.files?.[0])} disabled={busy}/></label>{incoming && <div className="cal-import-confirm"><strong>{filename}</strong><p>{t('{foods} foods · {portions} bank portions · {entries} entries', { foods: incoming.foods.length, portions: incoming.foodBank.length, entries: incoming.entries.length })}</p><p>{t('This will replace your current journal, food library, food bank, and targets on every device. A copy of your current journal downloads first, so you can restore it if needed.')}</p><button className="cal-button cal-button-danger cal-button-small" disabled={busy} onClick={() => void restoreBackup()}>{t('Replace journal with this backup')}</button></div>}{error && <p className="cal-form-error" role="alert">{error}</p>}</div><div className="cal-modal-actions"><button className="cal-button cal-button-primary" onClick={onClose}>{t('Done')}</button></div></>;
}
