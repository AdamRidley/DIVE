import { LanguageOption, LocalizedString } from './types';

export const DEFAULT_LANGUAGE = 'en';
const STORAGE_KEY = 'dive-video.lang';

export function resolveLocalized(
  value: LocalizedString | undefined,
  lang: string,
  fallback = DEFAULT_LANGUAGE,
): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return value[lang] ?? value[fallback] ?? Object.values(value)[0] ?? '';
}

export function listedLanguages(options?: LanguageOption[]): LanguageOption[] {
  if (options && options.length > 0) {
    return options;
  }
  return [{ code: DEFAULT_LANGUAGE, label: 'English', default: true }];
}

export function defaultLanguageCode(options?: LanguageOption[]): string {
  const listed = listedLanguages(options);
  return listed.find((item) => item.default)?.code || listed[0]?.code || DEFAULT_LANGUAGE;
}

export function isLanguageAllowed(code: string, options?: LanguageOption[]): boolean {
  return listedLanguages(options).some((item) => item.code === code);
}

export function storedLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeLanguage(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // ignore quota / private mode
  }
}

export function browserPreferredLanguage(options?: LanguageOption[]): string | null {
  const codes = listedLanguages(options).map((item) => item.code);
  const nav = typeof navigator === 'undefined' ? [] : [...(navigator.languages || []), navigator.language];
  for (const candidate of nav) {
    if (!candidate) continue;
    const exact = candidate.toLowerCase();
    const base = exact.split('-')[0];
    const match = codes.find((code) => code.toLowerCase() === exact || code.toLowerCase() === base);
    if (match) {
      return match;
    }
  }
  return null;
}

export function resolvePlayerLanguage(
  options: LanguageOption[] | undefined,
  explicit?: string | null,
): string {
  if (explicit && isLanguageAllowed(explicit, options)) {
    return explicit;
  }
  const stored = storedLanguage();
  if (stored && isLanguageAllowed(stored, options)) {
    return stored;
  }
  return browserPreferredLanguage(options) || defaultLanguageCode(options);
}
