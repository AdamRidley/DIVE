export const CAPTION_LINE_LENGTH = 42;

const wordsOf = text => text.trim().split(/\s+/).filter(Boolean);

function linesFor(words) {
  const lines = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last && last.length + word.length + 1 <= CAPTION_LINE_LENGTH) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** Authoring only: keep every word and original sentence window, never split at playback. */
export function splitCaptionCue(cue) {
  const words = wordsOf(cue.text);
  if (!words.length || !(cue.endTime > cue.startTime)) throw new Error('Caption text and a positive time window are required');
  const secondsPerWord = (cue.endTime - cue.startTime) / 1000 / words.length;
  const costs = Array(words.length + 1).fill(Infinity);
  const next = Array(words.length).fill(0);
  costs[words.length] = 0;
  for (let start = words.length - 1; start >= 0; start--) {
    for (let end = start + 1; end <= words.length; end++) {
      if (linesFor(words.slice(start, end)).length > 1) break;
      const duration = (end - start) * secondsPerWord;
      const boundary = end === words.length || /[,;:.!?]$/.test(words[end - 1]) ? 0 : 2;
      const cost = costs[end] + 2 + (duration - 4) ** 2 / 4 + boundary
        + (duration < 1 ? 1000 : 0) + Math.max(0, duration - 7) * 100;
      if (cost < costs[start]) {
        costs[start] = cost;
        next[start] = end;
      }
    }
  }
  const groups = [];
  let start = 0;
  while (start < words.length) {
    const end = next[start];
    if (end <= start) throw new Error('Caption cannot be split into single-line groups');
    groups.push(words.slice(start, end));
    start = end;
  }
  let consumed = 0;
  return groups.map(group => {
    const startTime = cue.startTime + Math.round((cue.endTime - cue.startTime) * consumed / words.length);
    consumed += group.length;
    return {
      startTime,
      endTime: cue.startTime + Math.round((cue.endTime - cue.startTime) * consumed / words.length),
      text: linesFor(group).join('\n'),
    };
  });
}

/** Recover sentence windows for narration checks; chunk boundaries have no gap. */
export function joinCaptionChunks(cues) {
  const joined = [];
  for (const cue of cues) {
    const text = wordsOf(cue.text).join(' ');
    const previous = joined.at(-1);
    if (previous?.endTime === cue.startTime) {
      previous.text += ` ${text}`;
      previous.endTime = cue.endTime;
    } else joined.push({ ...cue, text });
  }
  return joined;
}

export function captionWarnings(cues) {
  return cues.flatMap((cue, index) => {
    const warnings = [];
    const lines = cue.text.split(/\r?\n/);
    const wrapped = lines.flatMap(line => linesFor(wordsOf(line)));
    if (wrapped.length > 1 || lines.length > 1 || lines.some(line => line.length > CAPTION_LINE_LENGTH)) {
      warnings.push('aim for one line of at most 42 characters; split this cue at a natural phrase');
    }
    const duration = (cue.endTime - cue.startTime) / 1000;
    const wpm = wordsOf(cue.text).length * 60 / duration;
    if (wpm > 180) warnings.push(`${Math.round(wpm)} words/minute exceeds the advisory 180; review timing against the narration`);
    if (duration > 7) warnings.push('over 7 seconds on screen; consider shorter authored cues');
    if (duration < 1) warnings.push('under 1 second on screen; review whether there is enough reading time');
    return warnings.map(message => `cue ${index + 1} (${cue.startTime}ms): ${message}`);
  });
}
