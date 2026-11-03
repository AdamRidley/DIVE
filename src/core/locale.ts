import type { LanguageOption, LocalizedString, PlayerText } from './types';

export const DEFAULT_LANGUAGE = 'en';
const STORAGE_KEY = 'dive-video.lang';

const PLAYER_COPY: Record<string, Record<PlayerTextKey, string>> = {
  en: {
    loadingStory: 'Loading Story...', loadingScene: 'Loading scene', end: 'End', replay: 'Replay',
    sceneError: 'This scene could not be loaded.', retry: 'Retry',
    chapters: 'Chapters', language: 'Language', settings: 'Settings', play: 'Play', pause: 'Pause',
    mute: 'Mute', unmute: 'Unmute', hideCaptions: 'Hide captions', showCaptions: 'Show captions',
    fullscreen: 'Toggle Fullscreen', captions: 'Captions', audioDescription: 'Audio description',
    data: 'Data', dataView: 'Current data view for exploration', dataLoading: 'Data loading or external',
  },
  cy: {
    loadingStory: 'Llwytho’r Stori...', loadingScene: 'Llwytho golygfa', end: 'Diwedd', replay: 'Chwarae eto',
    sceneError: 'Nid oedd modd llwytho’r olygfa hon.', retry: 'Rhoi cynnig arall arni',
    chapters: 'Penodau', language: 'Iaith', settings: 'Gosodiadau', play: 'Chwarae', pause: 'Oedi',
    mute: 'Tewi', unmute: 'Dad-dewi', hideCaptions: 'Cuddio isdeitlau', showCaptions: 'Dangos isdeitlau',
    fullscreen: 'Newid sgrin lawn', captions: 'Isdeitlau', audioDescription: 'Disgrifiad sain',
    data: 'Data', dataView: 'Golwg data cyfredol i’w archwilio', dataLoading: 'Data yn llwytho neu’n allanol',
  },
};

export type PlayerTextKey =
  | 'loadingStory' | 'loadingScene' | 'end' | 'replay' | 'sceneError' | 'retry'
  | 'chapters' | 'language' | 'settings' | 'play' | 'pause' | 'mute' | 'unmute'
  | 'hideCaptions' | 'showCaptions' | 'fullscreen' | 'captions' | 'audioDescription'
  | 'data' | 'dataView' | 'dataLoading';

function textFor(source: PlayerText | undefined, lang: string): Record<string, string> {
  if (!source) return {};
  return source[lang] || source[lang.split('-')[0]] || {};
}

/**
 * Player UI strings for `lang`: English, then built-in text for `lang`, then each override
 * in order (e.g. configured defaults, then the story). Unknown keys are ignored.
 */
export function playerCopy(lang: string, ...overrides: (PlayerText | undefined)[]): Record<PlayerTextKey, string> {
  const copy = { ...PLAYER_COPY.en, ...textFor(PLAYER_COPY, lang) };
  for (const source of overrides) {
    for (const [key, value] of Object.entries(textFor(source, lang))) {
      if (key in copy && typeof value === 'string') copy[key as PlayerTextKey] = value;
    }
  }
  return copy;
}

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
