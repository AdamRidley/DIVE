import assert from 'node:assert/strict';
import { splitCaptionCue, joinCaptionChunks, captionWarnings, CAPTION_LINE_LENGTH } from './caption-authoring.mjs';

const original = {
  startTime: 500,
  endTime: 20500,
  text: 'A deliberately longer caption gives authors a way to prepare short readable phrases. Every original word and the complete sentence window must survive splitting into editable single line cues.',
};
const cues = splitCaptionCue(original);
assert.ok(cues.length > 1);
assert.deepEqual(joinCaptionChunks(cues), [original]);
let words = 0;
const total = original.text.split(/\s+/).length;
for (const cue of cues) {
  assert.ok(cue.text.length <= CAPTION_LINE_LENGTH && !cue.text.includes('\n'));
  assert.ok(cue.endTime > cue.startTime);
  assert.equal(cue.startTime, original.startTime + Math.round((original.endTime - original.startTime) * words / total));
  words += cue.text.split(/\s+/).length;
  assert.equal(cue.endTime, original.startTime + Math.round((original.endTime - original.startTime) * words / total));
}
const afterGap = { startTime: 21000, endTime: 24000, text: 'A separate sentence after a gap.' };
assert.deepEqual(joinCaptionChunks([...cues, afterGap]), [original, afterGap]);
assert.ok(captionWarnings([{ startTime: 0, endTime: 1000, text: 'word '.repeat(30) }]).some(item => item.includes('180')));
assert.ok(captionWarnings([{ startTime: 0, endTime: 7000, text: 'word '.repeat(30) }]).some(item => item.includes('one line')));
assert.ok(captionWarnings([{ startTime: 0, endTime: 3000, text: 'Two short\nlines' }]).some(item => item.includes('one line')));
assert.deepEqual(captionWarnings([{ startTime: 0, endTime: 3000, text: 'A short readable cue.' }]), []);
assert.throws(() => splitCaptionCue({ startTime: 5, endTime: 5, text: 'Invalid' }), /positive time window/);
console.log('caption-authoring: exact words, single lines, proportional timing, gaps and advisories passed');
