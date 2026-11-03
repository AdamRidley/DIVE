import type { LanguageOption, LanguageToggle, PlayerText, Scene, Story, UiMode } from './types';

/**
 * Site-wide defaults for every `<dive-video>` on the page. A story value always wins,
 * so a downstream build (for example a branded distribution) can set house defaults
 * without editing stories or the player.
 */
export interface PlayerDefaults {
  uiMode?: UiMode;
  languages?: LanguageOption[];
  languageToggle?: LanguageToggle;
  pauseOnInteract?: boolean;
  /** CSS custom properties applied to `:host`, e.g. `{ '--dive-accent': '#0a7' }`. Page CSS still wins. */
  theme?: Record<string, string>;
  /** Player UI strings by language for languages without built-in text (or to reword it). Story `playerText` wins. */
  playerText?: PlayerText;
}

let defaults: PlayerDefaults = {};
const themeListeners = new Set<() => void>();

export function configurePlayer(next: PlayerDefaults): void {
  defaults = { ...defaults, ...next };
  if (next.theme) {
    defaults.theme = { ...next.theme };
    themeListeners.forEach((listener) => listener());
  }
}

export function playerDefaults(): Readonly<PlayerDefaults> {
  return defaults;
}

export function onThemeChange(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

export function themeCss(theme: Record<string, string> = defaults.theme || {}): string {
  const declarations = Object.entries(theme)
    .filter(([name, value]) => /^--[\w-]+$/.test(name) && typeof value === 'string' && !/[;{}]/.test(value))
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
  return declarations ? `:host { ${declarations} }` : '';
}

/** Keyframe state > scene > story > configured default > false. */
export function resolvePauseOnInteract(
  story?: Story | null,
  scene?: Scene | null,
  visualState?: unknown,
): boolean {
  const keyframe = (visualState as { pauseOnInteract?: unknown } | null | undefined)?.pauseOnInteract;
  if (typeof keyframe === 'boolean') return keyframe;
  if (typeof scene?.pauseOnInteract === 'boolean') return scene.pauseOnInteract;
  if (typeof story?.pauseOnInteract === 'boolean') return story.pauseOnInteract;
  return defaults.pauseOnInteract ?? false;
}

export function parseLanguageToggle(value?: string | null): LanguageToggle | null {
  return value === 'auto' || value === 'inline' || value === 'menu' || value === 'none' ? value : null;
}

/** Where the language picker renders: element attribute > story > configured default > `menu`. */
export function resolveLanguageToggle(
  languageCount: number,
  story?: Story | null,
  override?: string | null,
): Exclude<LanguageToggle, 'auto'> {
  if (languageCount < 2) return 'none';
  const mode = parseLanguageToggle(override)
    || parseLanguageToggle(story?.languageToggle)
    || defaults.languageToggle
    || 'menu';
  if (mode === 'auto') return languageCount === 2 ? 'inline' : 'menu';
  return mode;
}
