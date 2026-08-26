import { Scene, Story, UiMode } from './types';

export const DEFAULT_UI_MODE: UiMode = 'autohide';

export function parseUiMode(value?: string | null): UiMode | null {
  if (value === 'inset' || value === 'autohide') {
    return value;
  }
  return null;
}

/** Element attribute > active scene > story > autohide. */
export function resolveUiMode(
  story?: Story | null,
  scene?: Scene | null,
  override?: string | null,
): UiMode {
  return parseUiMode(override) || parseUiMode(scene?.uiMode) || parseUiMode(story?.uiMode) || DEFAULT_UI_MODE;
}
