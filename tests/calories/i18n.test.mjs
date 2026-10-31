import test from 'node:test';
import assert from 'node:assert/strict';
import { getLanguage, setLanguage, t, translateMessage, translateIfKnown, dateLocale } from '../../src/lib/calories/i18n.ts';
import { ZH_CN } from '../../src/lib/calories/i18n-zh.ts';
import { emptyData, normalizeData } from '../../src/lib/calories/model.ts';
import { mergeJournals, JournalConflictError } from '../../src/lib/calories/offline.ts';
import { translationKeys } from '../../scripts/i18n-keys.mjs';

/** Text passed to t() through a variable or lookup table, which the source scan can't see. */
const DYNAMIC_KEYS = [
  'Journal', 'Foods', 'Food bank', 'Summary', // navigation
  'Breakfast', 'Lunch', 'Dinner', 'Snack', 'Custom', // meals
  'As served', 'Raw', 'Cooked', // food states
  'Last 7 days', 'Last 14 days', 'Last 30 days', 'Last 90 days', 'All time', 'Most logged', 'Recently logged', 'Name (A–Z)', // food list options
  'Product photo', 'Nutrition table photo', // photo slots
  'Garmin hasn’t reported complete calorie data yet.', 'Garmin couldn’t be reached. A later import will try again.', 'Sign in to Garmin again to resume automatic imports.', 'Garmin is temporarily limiting requests. A later import will try again.',
];

test('every piece of UI text has a Simplified Chinese translation', () => {
  const keys = [...translationKeys('src'), ...DYNAMIC_KEYS];
  assert.ok(keys.length > 400, `expected the scan to find the app's text, found ${keys.length}`);
  const missing = keys.filter(key => !Object.hasOwn(ZH_CN, key));
  assert.deepEqual(missing, []);
});

test('translations keep the same placeholders as the English text', () => {
  const names = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  const mismatched = Object.entries(ZH_CN).filter(([english, chinese]) => names(english).join() !== names(chinese).join());
  assert.deepEqual(mismatched, []);
});

test('English is the default, and t() fills placeholders in either language', () => {
  assert.equal(getLanguage(), 'en');
  assert.equal(t('Removed {name}.', { name: 'Peas' }), 'Removed Peas.');
  assert.equal(t('Text without a translation'), 'Text without a translation');
  setLanguage('zh-CN');
  try {
    assert.equal(t('Removed {name}.', { name: 'Peas' }), '已删除 Peas。');
    assert.equal(t('Log food'), '记录食物');
    assert.equal(t('Text without a translation'), 'Text without a translation');
    assert.equal(dateLocale(), 'zh-CN');
    // Custom meal names are the user's words and stay as typed.
    assert.equal(translateIfKnown('Lunch'), '午餐');
    assert.equal(translateIfKnown('Meal 1'), 'Meal 1');
  } finally { setLanguage('en'); }
  assert.equal(dateLocale(), 'en-GB');
});

test('error messages from the app translate, including ones built with values', () => {
  assert.equal(translateMessage('Your session has ended. Sign in again.'), 'Your session has ended. Sign in again.');
  setLanguage('zh-CN');
  try {
    assert.equal(translateMessage('Your session has ended. Sign in again.'), '你的登录已过期，请重新登录。');
    assert.equal(translateMessage('this journal entry changed since this draft was started. Your draft is kept. Review the current saved record before applying these edits.'), '这条日志记录在草稿开始后已被修改。草稿已保留，请先查看当前保存的记录再应用这些修改。');
    assert.equal(translateMessage('Bread has no piece weight. Enter its amount in g.'), 'Bread 没有单个重量，请以 g 输入分量。');
    assert.equal(translateMessage(new JournalConflictError('the app settings').message), '此设备和另一台设备都修改了应用设置。本地更改已保留，请先导出备份再选择保留哪个版本。');
    // Text from elsewhere, such as the server, is shown as it came.
    assert.equal(translateMessage('Some server message'), 'Some server message');
  } finally { setLanguage('en'); }
});

test('the language setting is saved with the journal and rejects unknown values', () => {
  const foodList = { window: 7, sort: 'frequent' };
  assert.deepEqual(normalizeData({ ...emptyData(), preferences: { foodList, language: 'zh-CN' } }).preferences, { foodList, language: 'zh-CN' });
  assert.deepEqual(normalizeData({ ...emptyData(), preferences: { foodList } }).preferences, { foodList });
  assert.throws(() => normalizeData({ ...emptyData(), preferences: { foodList, language: 'fr' } }), /language setting/);
});

test('a language change on one device merges with the other device’s journal', () => {
  const base = { ...emptyData(), preferences: { foodList: { window: 7, sort: 'frequent' } } };
  const chinese = { ...base, preferences: { ...base.preferences, language: 'zh-CN' } };
  assert.deepEqual(mergeJournals(base, chinese, base).preferences, chinese.preferences);
  assert.deepEqual(mergeJournals(base, base, chinese).preferences, chinese.preferences);
  const byName = { ...base, preferences: { foodList: { window: 7, sort: 'name' } } };
  assert.throws(() => mergeJournals(base, chinese, byName), JournalConflictError);
});
