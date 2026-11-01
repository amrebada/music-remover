// Translations from public/_locales. Chrome uses the same files for the extension's
// name in its menus and the store; the popup and the messages over videos read
// them directly instead, so the language picked in the popup applies at once.
import { browser } from 'wxt/browser';
import ar from '../../public/_locales/ar/messages.json';
import en from '../../public/_locales/en/messages.json';
import type { LanguageSetting } from './settings';

export type Language = Exclude<LanguageSetting, 'auto'>;
export type MessageKey = keyof typeof en;
type Catalog = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;

const CATALOGS: Record<Language, Catalog> = { en, ar };
let current: Language | undefined;

/** Chrome's own choice for the extension, from its display language. */
function browserLanguage(): Language {
  return browser.i18n.getMessage('@@ui_locale').startsWith('ar') ? 'ar' : 'en';
}

export function setLanguage(setting: LanguageSetting) {
  current = setting === 'auto' ? browserLanguage() : setting;
}

export function language(): Language {
  return (current ??= browserLanguage());
}

/** The message in the current language, with $1…$9 filled from `values` like chrome.i18n does. */
export function t(key: MessageKey, ...values: (string | number)[]): string {
  const entry = CATALOGS[language()][key] ?? CATALOGS.en[key];
  return entry.message.replace(/\$(\w+)\$/g, (_, name: string) =>
    (entry.placeholders?.[name.toLowerCase()]?.content ?? '').replace(/\$(\d)/g, (_, i: string) => String(values[Number(i) - 1] ?? '')),
  );
}

/** Sets lang/dir and fills every [data-i18n] element. */
export function localizePage() {
  document.documentElement.lang = language();
  document.documentElement.dir = language() === 'ar' ? 'rtl' : 'ltr';
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as MessageKey);
}
