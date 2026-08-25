import { CaptionCue, CaptionTrack, StoryCaptions } from './types';

export interface ResolvedCaptionTrack {
  id: string;
  label: string;
  srclang?: string;
  kind: 'subtitles' | 'captions' | 'descriptions';
  cues: CaptionCue[];
}

export function parseVttTimestamp(value: string): number | null {
  const token = value.trim().split(/\s+/)[0];
  const match = token.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) {
    return null;
  }

  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4].padEnd(3, '0');
  const ms = Number(fraction);
  if (![hours, minutes, seconds, ms].every(Number.isFinite)) {
    return null;
  }

  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

export function parseVtt(source: string): CaptionCue[] {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const blocks = text.split(/\n\n+/);
  const cues: CaptionCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
    if (lines.length === 0) {
      continue;
    }

    const header = lines[0].toUpperCase();
    if (header.startsWith('WEBVTT') || header.startsWith('NOTE') || header.startsWith('STYLE') || header.startsWith('REGION')) {
      continue;
    }

    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) {
      continue;
    }

    const [startRaw, endPart] = lines[timeIndex].split('-->');
    const startTime = parseVttTimestamp(startRaw || '');
    const endTime = parseVttTimestamp(endPart || '');
    if (startTime === null || endTime === null || endTime <= startTime) {
      continue;
    }

    const cueText = lines.slice(timeIndex + 1).join('\n').trim();
    if (!cueText) {
      continue;
    }

    cues.push({ startTime, endTime, text: cueText });
  }

  return cues;
}

export function cuesAtTime(cues: CaptionCue[], timeMs: number): CaptionCue[] {
  return cues.filter((cue) => timeMs >= cue.startTime && timeMs < cue.endTime);
}

export function captionTracksForLocale(
  tracks: ResolvedCaptionTrack[],
  lang: string,
  options: { captions: boolean; descriptions: boolean },
): ResolvedCaptionTrack[] {
  return tracks.filter((track) => {
    if (track.kind === 'descriptions') {
      return options.descriptions;
    }
    if (!options.captions) {
      return false;
    }
    if (track.srclang && track.srclang !== lang) {
      return false;
    }
    return true;
  });
}

function isCueArray(value: unknown): value is CaptionCue[] {
  return Array.isArray(value) && value.every((item) => (
    item
    && typeof item === 'object'
    && typeof (item as CaptionCue).startTime === 'number'
    && typeof (item as CaptionCue).endTime === 'number'
    && typeof (item as CaptionCue).text === 'string'
  ));
}

export async function resolveCaptionTracks(
  input: StoryCaptions | undefined,
  baseUrl: string,
): Promise<ResolvedCaptionTrack[]> {
  if (!input) {
    return [];
  }

  const tracks: CaptionTrack[] = [];
  if (typeof input === 'string') {
    tracks.push({ src: input, default: true });
  } else if (isCueArray(input)) {
    tracks.push({ cues: input, default: true, label: 'Captions' });
  } else if (Array.isArray(input)) {
    tracks.push(...input);
  } else {
    tracks.push(input);
  }

  const resolved: ResolvedCaptionTrack[] = [];
  for (const [index, track] of tracks.entries()) {
    let cues = track.cues ? [...track.cues] : [];
    if (track.src) {
      try {
        const src = new URL(track.src, baseUrl).href;
        const response = await fetch(src);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        cues = parseVtt(await response.text());
      } catch (error) {
        console.error(`Failed to load captions: ${track.src}`, error);
      }
    }

    if (cues.length === 0) {
      continue;
    }

    resolved.push({
      id: `${track.srclang || 'und'}-${index}`,
      label: track.label || track.srclang || 'Captions',
      srclang: track.srclang,
      kind: track.kind || 'captions',
      cues,
    });
  }

  return resolved;
}
