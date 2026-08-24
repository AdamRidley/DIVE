export function parseTimeParam(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+(\.\d+)?s$/i.test(trimmed)) {
    return Math.max(0, Number(trimmed.slice(0, -1)) * 1000);
  }
  if (/^\d+(\.\d+)?ms$/i.test(trimmed)) {
    return Math.max(0, Number(trimmed.slice(0, -2)));
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  // Bare numbers < 1000 are treated as seconds (YouTube-style); larger as ms.
  return numeric < 1000 ? numeric * 1000 : numeric;
}

export interface DiveUrlState {
  timeMs?: number;
  sceneId?: string;
  lang?: string;
}

export function readDiveUrlState(
  search = typeof location === 'undefined' ? '' : location.search,
  hash = typeof location === 'undefined' ? '' : location.hash,
): DiveUrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const timeMs = parseTimeParam(params.get('t'));
  const hashScene = hash.replace(/^#/, '').trim();
  const sceneId = params.get('scene') || (hashScene && !hashScene.includes('=') ? hashScene : undefined) || undefined;
  const lang = params.get('lang') || undefined;
  return {
    timeMs: timeMs == null ? undefined : timeMs,
    sceneId,
    lang,
  };
}

export function writeDiveUrlState(state: DiveUrlState): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') {
    return;
  }
  const url = new URL(location.href);
  if (state.timeMs == null) {
    url.searchParams.delete('t');
  } else {
    url.searchParams.set('t', String(Math.round(state.timeMs / 1000)));
  }
  if (state.sceneId) {
    url.searchParams.set('scene', state.sceneId);
  } else {
    url.searchParams.delete('scene');
  }
  if (state.lang) {
    url.searchParams.set('lang', state.lang);
  } else {
    url.searchParams.delete('lang');
  }
  history.replaceState(history.state, '', url);
}
