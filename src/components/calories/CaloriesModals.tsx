import { useEffect, useState, type FormEvent } from 'react';
import { energyFromMacros, macrosForFood, manualMealEntry, normalizeData, todayISO, type DaySettings, type Entry, type Food, type TrackerData } from '../../lib/calories/model';
import { effectiveBurned, type GarminDay, type GarminSnapshot, type GarminStatus } from '../../lib/calories/garmin';
import { DAILY_PROTEIN_GRAMS, macroTargets } from '../../lib/calories/nutrition';
import { adjustedBudget, MAX_DAILY_DEFICIT, MAX_DAILY_SURPLUS_CARRY } from '../../lib/calories/budget';
import { normalizeFoodPhotoDraft, type FoodPhotoDraft, type FoodPhotoRequest } from '../../lib/calories/food-photos';
import FoodPhotoImport from './FoodPhotoImport';
import MealPhotoImport from './MealPhotoImport';
import { normalizeMealPhotoDraft, type MealPhotoDraft, type MealPhotoRequest } from '../../lib/calories/meal-photos';
import { usePersistentFormDraft, DraftRestoredNotice } from './FormDrafts';
import { mealForTime, RECENT_FOOD_DAYS } from '../../lib/calories/food-order';
import { Icon, ModalHeader, NumericField, number, signedNumber, readableDate, downloadFile, errorMessage, newId, unitLabel, previewNumber, syncTime, burnedFormula, burnedSyncTime, staleImport, garminStatusLabel, garminErrorMeaning } from './ui';

export function EntryEditor({ entry, initialFoodId, initialMeal, lastQuantities = {}, recentFoodIds, foods, date, onSave, readMealPhoto, onAddFood, onFoodBank, bankCount, onClose }: { entry?: Entry; initialFoodId?: string; initialMeal?: string; lastQuantities?: Record<string, number>; recentFoodIds?: ReadonlySet<string>; foods: Food[]; date: string; onSave: (entry: Entry, originalRecordJson: string) => void | Promise<void>; readMealPhoto: (input: MealPhotoRequest, signal: AbortSignal) => Promise<MealPhotoDraft>; onAddFood: () => void; onFoodBank: () => void; bankCount: number; onClose: () => void }) {
  const manualEditing = entry?.source === 'manual' || Boolean(entry && entry.foodId === `manual:${entry.id}`);
  const initialFood = foods.find(food => food.id === (manualEditing ? initialFoodId : entry?.foodId ?? initialFoodId)) ?? foods.find(food => recentFoodIds?.has(food.id)) ?? foods[0];
  const standardMeals = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
  // A new food starts at the amount last logged; otherwise at the label quantity.
  const startQuantity = (food: Food) => String(lastQuantities[food.id] ?? food.baseQuantity);
  const newMeal = initialMeal ?? mealForTime();
  const form = usePersistentFormDraft(entry ? `entry:${entry.id}` : 'entry:new', {
    draftEntryId: entry?.id ?? newId(),
    originalRecordJson: JSON.stringify(entry ?? null),
    mode: (entry ? manualEditing ? 'manual' : 'library' : foods.length ? 'library' : 'manual') as 'library' | 'manual',
    foodId: manualEditing ? '' : entry ? entry.foodId : initialFood?.id ?? '', foodFilter: '',
    quantity: !manualEditing && entry ? String(entry.quantity) : initialFood ? startQuantity(initialFood) : '100',
    manualName: manualEditing ? entry?.foodName ?? '' : '',
    manualNutrients: { protein: manualEditing ? String(entry?.protein ?? '') : '', carbs: manualEditing ? String(entry?.carbs ?? '') : '', fat: manualEditing ? String(entry?.fat ?? '') : '', fiber: manualEditing ? String(entry?.fiber ?? '') : '' },
    mealChoice: (meal => standardMeals.includes(meal) ? meal : 'Custom')(entry?.meal ?? newMeal), customMeal: entry?.meal ?? (standardMeals.includes(newMeal) ? '' : newMeal), entryDate: entry?.date ?? date,
  }, value => ({ kind: 'entry', label: entry ? `Edit ${entry.foodName}` : value.manualName.trim() || 'New food entry', ...(value.entryDate ? { date: value.entryDate } : {}), ...(entry ? { entryId: entry.id } : value.mode === 'library' && value.foodId ? { foodId: value.foodId } : {}) }));
  useEffect(() => {
    const explicitFood = !entry && initialFoodId ? foods.find(food => food.id === initialFoodId) : undefined;
    if (explicitFood && form.draft.mode === 'library' && form.draft.foodId !== explicitFood.id) form.setDraft(current => ({ ...current, foodId: explicitFood.id, foodFilter: '', quantity: startQuantity(explicitFood) }));
  }, [entry?.id, initialFoodId]);
  const [mode, setMode] = form.field('mode');
  const [foodId, setFoodId] = form.field('foodId');
  const [foodFilter, setFoodFilter] = form.field('foodFilter');
  const [quantity, setQuantity] = form.field('quantity');
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
  const savedFood: Food | undefined = entry && !manualEditing ? { id: entry.foodId, name: entry.foodName, baseQuantity: entry.quantity, unit: entry.unit, state: entry.state, carbs: entry.carbs, protein: entry.protein, fat: entry.fat, fiber: entry.fiber, calories: entry.calories } : undefined;
  const choices = savedFood ? [savedFood, ...foods.filter(food => food.id !== savedFood.id)] : foods;
  const matches = (food: Food, query: string) => food.name.toLowerCase().includes(query.trim().toLowerCase());
  // Without a search, the picker lists only foods logged in the last week, plus the food already chosen.
  const isListed = (food: Food, query: string) => matches(food, query) && (showAllFoods || query.trim() !== '' || !recentFoodIds?.size || recentFoodIds.has(food.id) || food.id === savedFood?.id || food.id === initialFoodId || food.id === foodId);
  const filteredFoods = choices.filter(food => isListed(food, foodFilter));
  const hiddenFoods = foodFilter.trim() ? 0 : choices.length - filteredFoods.length;
  const selectedFood = filteredFoods.find(food => food.id === foodId);
  const preview = selectedFood ? macrosForFood(selectedFood, previewNumber(quantity)) : null;
  const estimatedValue = (value: string) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e8 ? parsed : 0; };
  const manualPreview = { protein: estimatedValue(manualNutrients.protein), carbs: estimatedValue(manualNutrients.carbs), fat: estimatedValue(manualNutrients.fat), fiber: estimatedValue(manualNutrients.fiber) };
  const manualEnergy = energyFromMacros(manualPreview);
  function filterFoods(value: string) {
    setFoodFilter(value);
    const first = choices.find(food => isListed(food, value));
    setFoodId(first?.id ?? '');
    if (first && first.id !== foodId) setQuantity(startQuantity(first));
    setError('');
  }
  function changeMode(next: 'library' | 'manual') {
    if (next === 'library' && !selectedFood) {
      const first = filteredFoods[0];
      setFoodId(first?.id ?? '');
      if (first) setQuantity(startQuantity(first));
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
    if (!meal) { setError('Add a meal name or number.'); return; }
    if (mode === 'manual') {
      if (!manualName.trim()) { setError('Give your estimated meal a name.'); return; }
      if (Object.values(manualNutrients).some(value => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e8) || !Number.isFinite(manualEnergy) || manualEnergy > 1e8) { setError('Enter finite, non-negative nutrient totals. Each value and the calculated energy must be no more than 100,000,000.'); return; }
      setSubmitting(true);
      try { await onSave(manualMealEntry({ id: form.draft.draftEntryId, date: entryDate, meal, name: manualName.trim(), protein: Number(manualNutrients.protein), carbs: Number(manualNutrients.carbs), fat: Number(manualNutrients.fat), fiber: Number(manualNutrients.fiber) }), form.draft.originalRecordJson); form.clearDraft(); }
      catch (error) { setError(errorMessage(error)); }
      finally { setSubmitting(false); }
      return;
    }
    if (!selectedFood || !preview || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0 || Number(quantity) > 1e8) { setError('Choose a food and a quantity greater than zero.'); return; }
    // A fresh library object removes a manual source flag when the entry changes modes.
    setSubmitting(true);
    try { await onSave({ id: form.draft.draftEntryId, date: entryDate, meal, foodId: selectedFood.id, foodName: selectedFood.name, quantity: Number(quantity), unit: selectedFood.unit, state: selectedFood.state, ...preview }, form.draft.originalRecordJson); form.clearDraft(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSubmitting(false); }
  }
  return <>
    <ModalHeader title={entry ? 'Edit your entry' : 'What’s on the menu?'} eyebrow={entry ? 'DAILY JOURNAL' : 'LOG A FOOD'} onClose={closeEditor}/>
    <form className="cal-form" onSubmit={submit}>
      <DraftRestoredNotice {...form} disabled={photoBusy || submitting} discardDraft={() => { form.discardDraft(); setError(''); }}/>
      <div className={`cal-entry-mode-switch${!entry && bankCount ? ' cal-entry-mode-with-bank' : ''}`} role="group" aria-label="Entry method"><button type="button" disabled={submitting} className={mode === 'library' ? 'is-active' : ''} aria-pressed={mode === 'library'} onClick={() => changeMode('library')}>Food library</button><button type="button" disabled={submitting} className={mode === 'manual' ? 'is-active' : ''} aria-pressed={mode === 'manual'} onClick={() => changeMode('manual')}>Manual estimate</button>{!entry && bankCount > 0 && <button type="button" disabled={submitting} onClick={onFoodBank}>Food bank ({bankCount})</button>}</div>
      {mode === 'manual' && <fieldset className="cal-food-editor-fields" disabled={submitting}><MealPhotoImport readPhoto={readMealPhoto} description={manualName} onDraft={applyMealPhoto} onBusyChange={setPhotoBusy}/></fieldset>}
      <fieldset className="cal-form cal-food-editor-fields" disabled={photoBusy || submitting}>
      {mode === 'library' ? <>
        <div className="cal-food-picker" role="group" aria-labelledby="cal-entry-food-label"><label id="cal-entry-food-label" htmlFor="cal-entry-food-filter">Food</label><div className="cal-food-picker-controls"><input id="cal-entry-food-filter" type="text" aria-label="Filter foods" aria-describedby="cal-entry-food-matches" value={foodFilter} onChange={event => filterFoods(event.target.value)} placeholder="Type part of a food name" autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus/><select aria-label="Food" aria-describedby="cal-entry-food-matches" value={foodId} onChange={event => { const food = filteredFoods.find(item => item.id === event.target.value); setFoodId(food?.id ?? ''); if (food) setQuantity(startQuantity(food)); setError(''); }} required disabled={filteredFoods.length === 0}>{filteredFoods.length === 0 && <option value="" disabled>No matching foods</option>}{filteredFoods.map(food => <option key={food.id} value={food.id}>{food.name}{food.id === savedFood?.id ? ' (saved entry)' : ''} · {food.state}</option>)}</select></div><small className="cal-field-hint" id="cal-entry-food-matches" role="status">{filteredFoods.length === 0 ? foods.length === 0 && !savedFood ? 'Your library is empty. Add a food below or choose Manual estimate.' : 'No matching foods. Try another name or add a food below.' : foodFilter.trim() ? `${filteredFoods.length} matching ${filteredFoods.length === 1 ? 'food' : 'foods'}` : hiddenFoods ? `Showing foods logged in the last ${RECENT_FOOD_DAYS} days. Type to search all ${choices.length}.` : 'Type to filter the food list.'}</small>{hiddenFoods > 0 && <button className="cal-text-button cal-show-all-foods" type="button" onClick={() => setShowAllFoods(true)}>Show all foods ({hiddenFoods} hidden)</button>}</div>
        <button className="cal-text-button cal-add-food-inline" type="button" onClick={onAddFood}><Icon name="plus" size={15}/>Add a new food to your library</button>
      </> : <>
        <label>Meal / restaurant name<input value={manualName} onChange={event => { setManualName(event.target.value); setError(''); }} placeholder="e.g. Restaurant lunch" required maxLength={160} autoFocus/></label>
        <p className="cal-field-hint">Enter the estimated nutrient totals for the entire meal or portion you ate. Leave blank for zero.</p>
        <div className="cal-form-grid"><NumericField label="Protein total" value={manualNutrients.protein} onChange={value => changeManualNutrient('protein', value)} required={false}/><NumericField label="Carbohydrate total" value={manualNutrients.carbs} onChange={value => changeManualNutrient('carbs', value)} required={false}/><NumericField label="Fat total" value={manualNutrients.fat} onChange={value => changeManualNutrient('fat', value)} required={false}/><NumericField label="Fibre total" value={manualNutrients.fiber} onChange={value => changeManualNutrient('fiber', value)} required={false}/></div>
      </>}
      <div className="cal-form-grid">{mode === 'library' && <NumericField label="Quantity" value={quantity} onChange={setQuantity} unit={selectedFood?.unit ?? 'g'} min={0.001}/>}<label>Meal<select value={mealChoice} onChange={event => setMealChoice(event.target.value)}>{standardMeals.map(meal => <option key={meal}>{meal}</option>)}<option>Custom</option></select></label>{mode === 'manual' && <label>Date<input type="date" value={entryDate} onChange={event => setEntryDate(event.target.value)} required/></label>}</div>
      {mealChoice === 'Custom' && <label>Meal name or number<input type="text" value={customMeal} onChange={event => setCustomMeal(event.target.value)} placeholder="e.g. Meal 1, late lunch" required maxLength={80}/></label>}
      {mode === 'library' && <label>Date<input type="date" value={entryDate} onChange={event => setEntryDate(event.target.value)} required/></label>}
      {mode === 'manual' ? <div className="cal-budget-preview" aria-live="polite"><span>Estimated energy for this meal</span><strong><output aria-label="Estimated meal energy">{number(manualEnergy, 1)}</output> kcal</strong><p>4 × protein + 4 × carbohydrate + 9 × fat. Fibre is tracked separately.</p></div> : preview && <div className="cal-entry-preview"><div><span>This entry</span><strong>{number(preview.calories)} <small>kcal</small></strong></div><div className="cal-preview-macros">{([['Protein', preview.protein], ['Carbs', preview.carbs], ['Fat', preview.fat], ['Fibre', preview.fiber]] as const).map(([name, amount]) => <span key={name}>{name}<strong>{number(amount, 1)} g</strong></span>)}</div><p>{selectedFood?.state} · {entry && !manualEditing && foodId === entry.foodId ? 'Uses nutrition saved with this entry.' : `Calculated from your food’s values per ${number(selectedFood?.baseQuantity ?? 0, 2)} ${selectedFood?.unit}.`}</p></div>}
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={closeEditor} disabled={submitting}>Cancel</button><button className="cal-button cal-button-primary" disabled={submitting || photoBusy || (mode === 'library' && !selectedFood)}>{submitting ? 'Saving…' : entry ? 'Save changes' : 'Add to journal'}<Icon name="check" size={17}/></button></div>
    </form>
  </>;
}

export function FoodEditor({ food, readPhotos, onSave, onClose }: { food?: Food; readPhotos: (input: FoodPhotoRequest, signal: AbortSignal) => Promise<FoodPhotoDraft>; onSave: (food: Food, originalRecordJson: string) => void | Promise<void>; onClose: () => void }) {
  const form = usePersistentFormDraft(food ? `food:${food.id}` : 'food:new', { draftFoodId: food?.id ?? newId(), originalRecordJson: JSON.stringify(food ?? null), name: food?.name ?? '', baseQuantity: String(food?.baseQuantity ?? 100), unit: (food?.unit ?? 'g') as Food['unit'] | '', state: (food?.state ?? 'As served') as Food['state'], nutrients: { carbs: String(food?.carbs ?? ''), protein: String(food?.protein ?? ''), fat: String(food?.fat ?? ''), fiber: String(food?.fiber ?? '') }, importedLabel: false }, value => ({ kind: 'food', label: value.name.trim() || 'New library food', ...(food ? { foodId: food.id } : {}) }));
  const [name, setName] = form.field('name');
  const [baseQuantity, setBaseQuantity] = form.field('baseQuantity');
  const [unit, setUnit] = form.field('unit');
  const [state, setState] = form.field('state');
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
    setNutrients({ protein: draft.protein === null ? '' : String(draft.protein), carbs: draft.carbs === null ? '' : String(draft.carbs), fat: draft.fat === null ? '' : String(draft.fat), fiber: draft.fiber === null ? '' : String(draft.fiber) });
    setImportedLabel(true); setError('');
  }
  function nutrient(key: keyof typeof nutrients, value: string) { setNutrients(current => ({ ...current, [key]: value })); }
  function closeEditor() { form.clearDraft(); onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (photoBusy || submitting) return;
    if (!name.trim() || !unit || !Number.isFinite(Number(baseQuantity)) || Number(baseQuantity) <= 0 || !Number.isFinite(calories) || calories > 1e8 || Object.values(nutrients).some(value => !Number.isFinite(Number(value)) || Number(value) < 0)) { setError('Add a food name, a label quantity greater than zero, a unit, and valid nutrition values.'); return; }
    setSubmitting(true);
    try { await onSave({ id: form.draft.draftFoodId, name: name.trim(), baseQuantity: Number(baseQuantity), unit, state, carbs: Number(nutrients.carbs), protein: Number(nutrients.protein), fat: Number(nutrients.fat), fiber: Number(nutrients.fiber), calories }, form.draft.originalRecordJson); form.clearDraft(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSubmitting(false); }
  }
  return <>
    <ModalHeader title={food ? 'Edit a favourite' : 'Add an everyday food'} eyebrow="FOOD LIBRARY" onClose={closeEditor}/>
    <form className="cal-form" onSubmit={submit}>
      <DraftRestoredNotice {...form} disabled={photoBusy || submitting} discardDraft={() => { form.discardDraft(); setError(''); }}/>
      {!food && <fieldset className="cal-food-editor-fields" disabled={submitting}><FoodPhotoImport readPhotos={readPhotos} onDraft={applyPhotos} onBusyChange={setPhotoBusy}/></fieldset>}
      <fieldset className="cal-form cal-food-editor-fields" disabled={photoBusy || submitting}>
        <label>Food name<input value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Greek yoghurt" required maxLength={160} autoFocus/></label>
        <div className="cal-form-grid cal-form-grid-three">
          <NumericField label="Label quantity" value={baseQuantity} onChange={setBaseQuantity} unit="" min={0.001}/>
          <label>Unit<select value={unit} onChange={event => { const nextUnit = event.target.value as Food['unit']; setUnit(nextUnit); if (!food && !importedLabel) setBaseQuantity(nextUnit === 'piece' ? '1' : '100'); }} required><option value="" disabled>Choose unit</option><option value="g">grams (g)</option><option value="ml">millilitres (ml)</option><option value="piece">piece</option></select></label>
          <label>State<select value={state} onChange={event => setState(event.target.value as Food['state'])}><option>As served</option><option>Raw</option><option>Cooked</option></select></label>
        </div>
        <div className="cal-form-section-label"><strong>Nutrition per {baseQuantity || '—'} {unitLabel(unit, Number(baseQuantity))}</strong><p>Enter the label’s values in grams. Leave blank for zero.</p></div>
        <div className="cal-form-grid"><NumericField label="Protein" value={nutrients.protein} onChange={value => nutrient('protein', value)} required={false}/><NumericField label="Carbohydrate" value={nutrients.carbs} onChange={value => nutrient('carbs', value)} required={false}/><NumericField label="Fat" value={nutrients.fat} onChange={value => nutrient('fat', value)} required={false}/><NumericField label="Fibre" value={nutrients.fiber} onChange={value => nutrient('fiber', value)} required={false}/></div>
        <div className="cal-budget-preview" aria-live="polite"><span>Calculated energy</span><strong><output aria-label="Calculated energy">{hasNutrients ? number(calories, 1) : '—'}</output> kcal</strong><p>4 × protein + 4 × carbohydrate + 9 × fat</p></div>
        {food && <p className="cal-field-hint">Changes apply to future entries. Previously logged nutrition stays as recorded.</p>}
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={closeEditor} disabled={submitting}>Cancel</button><button className="cal-button cal-button-primary" disabled={photoBusy || submitting}>{submitting ? 'Saving…' : food ? 'Save changes' : 'Save food'}<Icon name="check" size={17}/></button></div>
    </form>
  </>;
}

export function TargetsEditor({ date, currentDay, settings, defaultSettings, garminDays, carryIn, carryIsProvisional, onSave, onClose }: { date: string; currentDay: string; settings: DaySettings; defaultSettings?: DaySettings; garminDays: readonly GarminDay[]; carryIn: number; carryIsProvisional: boolean; onSave: (settings: DaySettings, makeDefault: boolean, originalRecordJson: string, originalDefaultsJson: string) => void | Promise<void>; onClose: () => void }) {
  const form = usePersistentFormDraft(`targets:${date}`, { originalRecordJson: JSON.stringify(settings), originalDefaultsJson: JSON.stringify(defaultSettings ?? null), burned: settings.burned === 0 && settings.burnedSource !== 'manual' ? '' : String(settings.burned), source: (settings.burnedSource ?? 'garmin') as 'manual' | 'garmin', deficit: String(settings.deficit), makeDefault: false }, { kind: 'targets', label: `Targets for ${readableDate(date, { day: 'numeric', month: 'short', year: 'numeric' })}`, date });
  const [burned, setBurned] = form.field('burned');
  const [source, setSource] = form.field('source');
  const [deficit, setDeficit] = form.field('deficit');
  const [makeDefault, setMakeDefault] = form.field('makeDefault');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const resolved = effectiveBurned(date, { ...settings, burned: previewNumber(burned), burnedSource: source }, garminDays, currentDay);
  const effective = resolved.burned;
  const previewDeficit = previewNumber(deficit);
  const previewAllowance = adjustedBudget(effective, previewDeficit, carryIn);
  const previewBudget = previewAllowance.budget;
  const nutritionTargets = macroTargets(previewBudget);
  function closeEditor() { form.clearDraft(); onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if ([deficit, ...(source === 'manual' ? [burned] : [])].some(value => value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e8)) { setError('Enter finite, non-negative values no greater than 100,000,000.'); return; }
    if (source === 'manual' && Number(deficit) > Number(burned)) { setError('For a manual estimate, the deficit target cannot be greater than calories burned.'); return; }
    setSubmitting(true);
    try { await onSave({ burned: previewNumber(burned), deficit: Number(deficit), protein: DAILY_PROTEIN_GRAMS, burnedSource: source }, makeDefault, form.draft.originalRecordJson, form.draft.originalDefaultsJson); form.clearDraft(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSubmitting(false); }
  }
  return <>
    <ModalHeader title="Your daily targets" eyebrow={readableDate(date, { day: 'numeric', month: 'long' }).toUpperCase()} onClose={closeEditor}/>
    <p className="cal-modal-intro">Choose your deficit target and where calories burned comes from.</p>
    <p className="cal-target-date-hint" id="cal-deficit-date-hint">Changes apply to {readableDate(date, { day: 'numeric', month: 'long', year: 'numeric' })}. Leave the default-target option unchecked to edit only this date.</p>
    <form className="cal-form" onSubmit={submit}>
      <DraftRestoredNotice {...form} disabled={submitting} discardDraft={() => { form.discardDraft(); setError(''); }}/>
      <fieldset className="cal-form cal-food-editor-fields" disabled={submitting}>
      <label>Calories burned source<select value={source} onChange={event => setSource(event.target.value as 'manual' | 'garmin')}><option value="garmin">Garmin Connect (automatic)</option><option value="manual">Manual estimate / override</option></select></label>
      {source === 'garmin' ? <>
        <label>{resolved.unavailable ? 'Garmin calories burned unavailable' : resolved.restingEstimate ? 'Garmin resting estimate' : resolved.predicted ? 'Predicted calories burned' : resolved.predictionUnavailable ? 'Garmin calories burned so far' : 'Calories burned from Garmin'}<span className="cal-unit-input"><input type="text" value={resolved.unavailable ? '—' : number(resolved.burned, 1)} readOnly aria-describedby="cal-garmin-target-detail"/><span>kcal</span></span></label>
        <p className="cal-field-hint" id="cal-garmin-target-detail">{burnedFormula(resolved)}.{burnedSyncTime(resolved) ? ` ${burnedSyncTime(resolved)}.` : ''}{!resolved.unavailable && date === currentDay ? ' Today’s value is provisional and updates with imported readings.' : ''}</p>
      </> : <>
        <NumericField label="Manual calories burned" value={burned} onChange={setBurned} unit="kcal"/>
        <p className="cal-field-hint">This value overrides Garmin for this date, even when imported readings are available.</p>
      </>}
      <NumericField label="Deficit target for this date" value={deficit} onChange={setDeficit} unit="kcal" describedBy="cal-deficit-date-hint"/>
      <label>Daily protein target<span className="cal-unit-input"><input type="number" value={DAILY_PROTEIN_GRAMS} readOnly aria-describedby="cal-macro-rule"/><span>g</span></span></label>
      <p className="cal-field-hint" id="cal-macro-rule">Protein: {DAILY_PROTEIN_GRAMS} g/day. Fat: 25% of daily budget. Carbs: remaining energy after protein and fat. Fibre: 0.014 g per kcal of daily budget.</p>
      <div className="cal-budget-preview"><span>{carryIsProvisional ? 'Provisional food budget with carry' : resolved.predicted ? 'Predicted food budget with carry' : 'Food budget with carry'}</span><strong>{number(previewBudget, 1)} kcal</strong><div className="cal-target-carry-preview"><span>Base budget<strong>{number(previewAllowance.baseBudget, 1)} kcal</strong></span><span>Carry from earlier days{carryIsProvisional ? ' (provisional)' : ''}<strong>{signedNumber(carryIn)} kcal</strong></span></div><p>Base budget is calories burned minus the deficit target, with a minimum of 0. Carry adjusts the food budget: at most {number(MAX_DAILY_DEFICIT)} kcal below burned, and at most {number(MAX_DAILY_SURPLUS_CARRY)} kcal above the base budget.</p><div className="cal-target-macro-preview"><span>Protein<strong>{number(nutritionTargets.protein, 1)} g</strong></span><span>Carbs<strong>{number(nutritionTargets.carbs, 1)} g</strong></span><span>Fat<strong>{number(nutritionTargets.fat, 1)} g</strong></span><span>Fibre<strong>{number(nutritionTargets.fiber, 1)} g</strong></span></div></div>
      {carryIsProvisional && <p className="cal-field-hint">Includes today’s provisional balance; updates as food or Garmin data changes.</p>}
      {!resolved.unavailable && previewAllowance.deferredDebt > 0 && <p className="cal-macro-budget-note">If you eat this {number(previewBudget, 1)} kcal budget, {number(previewAllowance.deferredDebt, 1)} kcal of debt remains for later days.</p>}
      {!resolved.unavailable && previewAllowance.deferredSurplus > 0 && <p className="cal-field-hint">{number(previewAllowance.deferredSurplus, 1)} kcal of unused credit stays banked for later days. A day’s budget rises by at most {number(MAX_DAILY_SURPLUS_CARRY)} kcal from carry.</p>}
      {nutritionTargets.budgetTooLow && <p className="cal-macro-budget-note">Current calorie budget is too low for {DAILY_PROTEIN_GRAMS} g protein and 25% fat. Carb target is 0 g.</p>}
      <label className="cal-checkbox"><input type="checkbox" checked={makeDefault} onChange={event => setMakeDefault(event.target.checked)}/><span>Use this deficit target as my default<small>Applies to days without their own saved targets. Manual calories burned applies only to this date; new days use Garmin.</small></span></label>
      </fieldset>
      {error && <p className="cal-form-error" role="alert">{error}</p>}
      <div className="cal-modal-actions"><button className="cal-button" type="button" onClick={closeEditor} disabled={submitting}>Cancel</button><button className="cal-button cal-button-primary" disabled={submitting}>{submitting ? 'Saving…' : 'Save targets'}<Icon name="check" size={17}/></button></div>
    </form>
  </>;
}

export function GarminConnection({ date, currentDay, snapshot, loading, disconnecting, error, onRefresh, onDisconnect, onClose }: { date: string; currentDay: string; snapshot: GarminSnapshot; loading: boolean; disconnecting: boolean; error: string; onRefresh: () => void; onDisconnect: () => void; onClose: () => void }) {
  const { status } = snapshot;
  const reading = effectiveBurned(date, { burned: 0, deficit: 0, protein: 0, burnedSource: 'garmin' }, snapshot.days, currentDay);
  const day = reading.day;
  const descriptions: Record<GarminStatus['state'], string> = {
    not_connected: snapshot.days.length ? 'Automatic imports are disconnected. Previously imported calorie readings are kept. Follow the guide to reconnect your account.' : 'One-time sign-in is needed. Follow the guide to connect your Garmin account. Hourly imports are already configured.',
    connected: staleImport(status.last_sync_at) ? 'A new import is needed. Your last successful import was more than two hours ago. Previously imported readings are kept.' : 'Your imported active and resting calories are available across your devices.',
    needs_login: 'Garmin needs you to sign in again. Follow the connection step in the setup guide to resume imports.',
    error: 'The latest Garmin import did not complete. Existing readings are kept. Check the setup guide and try refreshing after the next import.',
  };
  return <>
    <ModalHeader title="Garmin Connect" eyebrow="ACTIVITY IMPORTS" onClose={onClose}/>
    <div className={`cal-garmin-status-card cal-garmin-state-${status.state} ${status.state === 'connected' && staleImport(status.last_sync_at) ? 'cal-garmin-stale' : ''}`}><span className="cal-garmin-symbol"><Icon name="watch" size={25}/></span><div><strong>{garminStatusLabel(status)}</strong><p>{descriptions[status.state]}</p></div></div>
    {error && <p className="cal-form-error cal-garmin-read-error" role="alert">Couldn’t refresh imported data. {error} Your food journal is still available.</p>}
    <dl className="cal-garmin-times"><div><dt>Last successful import</dt><dd>{status.last_sync_at ? syncTime(status.last_sync_at) : 'No successful import yet'}</dd></div><div><dt>Last import attempt</dt><dd>{status.last_attempt_at ? syncTime(status.last_attempt_at) : 'No attempt recorded'}</dd></div></dl>
    {status.last_error_code && <p className="cal-garmin-import-note">{garminErrorMeaning(status.last_error_code)}</p>}
    {day && <div className="cal-garmin-day-card">
      <div><strong>{readableDate(date, { day: 'numeric', month: 'long' })}</strong><span>{reading.predicted ? 'Prediction' : date === currentDay ? 'Provisional total so far' : 'Imported reading'}</span></div>
      <div className="cal-garmin-day-values">
        <span>{date === currentDay ? 'Active today' : 'Active'}<strong>{number(day.active)} <small>kcal</small></strong></span>
        <span>{reading.predicted && reading.restingDay ? <>Resting yesterday<em>{readableDate(reading.restingDay.date, { day: 'numeric', month: 'short' })}</em></> : date === currentDay ? 'Resting so far' : 'Resting'}<strong>{number(reading.predicted && reading.restingDay ? reading.restingDay.resting : day.resting)} <small>kcal</small></strong></span>
        <span>{reading.predicted ? 'Predicted burned' : date === currentDay ? 'Total so far' : 'Total burned'}<strong>{number(reading.burned)} <small>kcal</small></strong></span>
      </div>
      <p>{(reading.predicted || reading.predictionUnavailable) && <span className="cal-garmin-formula">{burnedFormula(reading)}.</span>}{burnedSyncTime(reading)}{status.state === 'not_connected' ? '. Automatic imports are stopped; this reading is kept.' : date === currentDay ? '. Today’s value updates with new imported readings.' : '.'}{reading.predicted && <span className="cal-garmin-raw-total">Garmin total so far: {number(day.total)} kcal.</span>}</p>
    </div>}
    {!day && reading.restingEstimate && reading.restingDay && <div className="cal-garmin-day-card">
      <div><strong>{readableDate(date, { day: 'numeric', month: 'long' })}</strong><span>Garmin resting estimate</span></div>
      <div className="cal-garmin-day-values cal-garmin-estimate-values"><span>Reference day<strong>{readableDate(reading.restingDay.date, { day: 'numeric', month: 'short', year: 'numeric' })}</strong></span><span>Estimated burned<strong>{number(reading.burned)} <small>kcal</small></strong></span></div>
      <p>{burnedFormula(reading)}. {burnedSyncTime(reading)}.{status.state === 'not_connected' ? ' Automatic imports are stopped; the reference reading is kept.' : ''}</p>
    </div>}
    {!day && reading.unavailable && <div className="cal-garmin-day-card cal-garmin-unavailable-card">
      <div><strong>{readableDate(date, { day: 'numeric', month: 'long' })}</strong><span>Burned unavailable</span></div>
      <div className="cal-garmin-unavailable-value">— <small>kcal</small></div>
      <p>{burnedFormula(reading)}. The automatic base budget stays at 0 until a reading is available.</p>
    </div>}
    <div className="cal-garmin-help"><a href="/calories/garmin-setup/" target="_blank" rel="noreferrer">{status.state === 'not_connected' ? 'Set up Garmin imports' : status.state === 'needs_login' ? 'Reconnect Garmin' : 'Open Garmin setup guide'} ↗</a><p>Automatic imports run hourly while connected. Refresh checks for the latest data already imported into your journal’s storage.</p></div>
    {status.state !== 'not_connected' && <button className="cal-text-button cal-danger cal-garmin-disconnect" onClick={onDisconnect} disabled={loading}>{disconnecting ? 'Disconnecting…' : 'Disconnect Garmin'}</button>}
    <div className="cal-modal-actions"><button className="cal-button" onClick={onRefresh} disabled={loading}><Icon name="refresh" size={17}/>{loading ? 'Refreshing…' : error ? 'Try refresh again' : 'Refresh imported data'}</button><button className="cal-button cal-button-primary" onClick={onClose}>Done</button></div>
  </>;
}


export function TransferDialog({ data, onImport, onClose }: { data: TrackerData; onImport: (data: TrackerData) => void | Promise<void>; onClose: () => void }) {
  const [incoming, setIncoming] = useState<TrackerData | null>(null);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const exportDate = todayISO();
  function exportCSV() {
    const columns: (keyof Entry)[] = ['date', 'meal', 'foodName', 'source', 'quantity', 'unit', 'state', 'carbs', 'protein', 'fat', 'fiber', 'calories'];
    const titles = ['Date', 'Meal', 'Food / meal name', 'Entry type', 'Quantity', 'Unit', 'State', 'Carbs (g)', 'Protein (g)', 'Fat (g)', 'Fibre (g)', 'Calories (kcal)'];
    // Prefix formula-like text to keep exported food names safe to open in a spreadsheet.
    const cell = (value: unknown) => { let text = String(value); if (/^[=+@-]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    const csv = [titles.map(cell).join(','), ...[...data.entries].sort((a, b) => a.date.localeCompare(b.date)).map(entry => columns.map(column => cell(column === 'source' ? entry.source === 'manual' ? 'Manual estimate' : 'Food library' : entry.source === 'manual' && (column === 'quantity' || column === 'unit' || column === 'state') ? '' : entry[column])).join(','))].join('\r\n');
    downloadFile('\uFEFF' + csv, `calories-entries-${exportDate}.csv`, 'text/csv;charset=utf-8');
  }
  async function selectFile(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(''); setIncoming(null); setFilename('');
    try { if (file.size > 20_000_000) throw new Error('This backup is too large. Choose a JSON backup smaller than 20 MB.'); const parsed = normalizeData(JSON.parse(await file.text())); setIncoming(parsed); setFilename(file.name); }
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
  return <><ModalHeader title="Keep a copy of your days" eyebrow="BACKUP & IMPORT" onClose={onClose}/><p className="cal-modal-intro">Download your journal whenever you like.</p><div className="cal-transfer-option"><div><strong>Complete backup</strong><p>Foods, food bank portions, journal entries, and targets in a JSON file. Use this to restore your journal.</p></div><button className="cal-button cal-button-small" onClick={() => downloadFile(JSON.stringify(data, null, 2), `calories-backup-${exportDate}.json`, 'application/json')}><Icon name="download" size={16}/>JSON</button></div><div className="cal-transfer-option"><div><strong>Spreadsheet export</strong><p>All logged entries, quantities, and nutrition. Opens in Numbers or Google Sheets.</p></div><button className="cal-button cal-button-small" onClick={exportCSV}><Icon name="download" size={16}/>CSV</button></div><div className="cal-import-section"><h3>Restore a backup</h3><p>Choose a JSON file previously exported from this app.</p><label className="cal-file-label">{busy ? 'Reading backup…' : 'Choose JSON backup'}<input type="file" accept=".json,application/json" onChange={event => void selectFile(event.target.files?.[0])} disabled={busy}/></label>{incoming && <div className="cal-import-confirm"><strong>{filename}</strong><p>{incoming.foods.length} foods · {incoming.foodBank.length} bank portions · {incoming.entries.length} entries</p><p>This will replace your current journal, food library, food bank, and targets on every device. A copy of your current journal downloads first, so you can restore it if needed.</p><button className="cal-button cal-button-danger cal-button-small" disabled={busy} onClick={() => void restoreBackup()}>Replace journal with this backup</button></div>}{error && <p className="cal-form-error" role="alert">{error}</p>}</div><div className="cal-modal-actions"><button className="cal-button cal-button-primary" onClick={onClose}>Done</button></div></>;
}
