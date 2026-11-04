import { ZH_CN } from './i18n-zh.ts';
import { DE } from './i18n-de.ts';
import { SV } from './i18n-sv.ts';

/** The app's display languages. English is the default and the source text for every translation. */
export const LANGUAGES = ['en', 'zh-CN', 'de', 'sv'] as const;
export type Language = (typeof LANGUAGES)[number];
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', 'zh-CN': '简体中文', de: 'Deutsch', sv: 'Svenska' };
/** Translations for every language but English, keyed by the English source text. */
export const TRANSLATIONS: Record<Exclude<Language, 'en'>, Record<string, string>> = { 'zh-CN': ZH_CN, de: DE, sv: SV };
const DATE_LOCALES: Record<Language, string> = { en: 'en-GB', 'zh-CN': 'zh-CN', de: 'de-DE', sv: 'sv-SE' };
export const isLanguage = (value: unknown): value is Language => typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);

const STORAGE_KEY = 'calories.language';
let current: Language = 'en';

export function getLanguage(): Language { return current; }
/** The locale used for dates in the current language. */
export function dateLocale(): string { return DATE_LOCALES[current]; }
const table = (): Record<string, string> | undefined => current === 'en' ? undefined : TRANSLATIONS[current];

/** Switches the language for every later t() call; the app re-renders to show it. */
export function setLanguage(language: Language): void {
  current = isLanguage(language) ? language : 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

/** The language last chosen on this device, so the sign-in screen and first paint use it before the journal loads. */
export function storedLanguage(): Language {
  try { const value = globalThis.localStorage?.getItem(STORAGE_KEY); return isLanguage(value) ? value : 'en'; } catch { return 'en'; }
}
export function storeLanguage(language: Language): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, language); } catch { /* The choice still applies until reload. */ }
}

type Vars = Record<string, string | number>;
const fill = (text: string, vars?: Vars) => vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match) : text;

/** Translates English source text. {name} placeholders are filled from vars; text without a translation stays English. */
export function t(text: string, vars?: Vars): string {
  const translations = table();
  return fill(translations && Object.hasOwn(translations, text) ? translations[text] : text, vars);
}

/** Like t(), but leaves text alone when there is no translation, for values that may be the user's own words (meal names). */
export function translateIfKnown(text: string): string {
  const translations = table();
  return translations && Object.hasOwn(translations, text) ? translations[text] : text;
}

/** Translated text placed mid-sentence: lowercases its first letter, except in German, where nouns keep their capital. */
export function inSentence(text: string): string {
  return current === 'de' ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** Messages built with values, from the app's own code, matched so errors can be shown translated too. */
const PATTERNS: [RegExp, string][] = [
  [/^(.+) changed since this draft was started\. Your draft is kept\. Review the current saved record before applying these edits\.$/, '{0} changed since this draft was started. Your draft is kept. Review the current saved record before applying these edits.'],
  [/^(.+) has no piece weight\. Enter its amount in (.+)\.$/, '{0} has no piece weight. Enter its amount in {1}.'],
  [/^This device and another device changed (.+)\. Your local changes are kept\. Export a backup before choosing which version to keep\.$/, 'This device and another device changed {0}. Your local changes are kept. Export a backup before choosing which version to keep.'],
];

/** Translates an error or notice message produced by the app's English code. Unknown messages (such as server text) stay as they are. */
export function translateMessage(message: string): string {
  const translations = table();
  if (!translations) return message;
  if (Object.hasOwn(translations, message)) return translations[message];
  for (const [pattern, key] of PATTERNS) {
    const match = pattern.exec(message);
    if (match && Object.hasOwn(translations, key)) return translations[key].replace(/\{(\d)\}/g, (_: string, index: string) => translateIfKnown(match[Number(index) + 1]));
  }
  return message;
}
