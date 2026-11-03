import assert from 'node:assert/strict';
import {
  configurePlayer,
  resolveLanguageToggle,
  resolvePauseOnInteract,
  themeCss,
} from '../src/core/config.ts';
import { playerCopy } from '../src/core/locale.ts';

const scene = (pauseOnInteract) => ({ id: 's', tool: 't', startTime: 0, endTime: 1, keyframes: [], overlays: [], pauseOnInteract });
const story = (extra = {}) => ({ title: 'x', duration: 1, scenes: [], ...extra });

assert.equal(resolvePauseOnInteract(story(), scene(), {}), false);
assert.equal(resolvePauseOnInteract(story({ pauseOnInteract: true }), scene(), {}), true);
assert.equal(resolvePauseOnInteract(story({ pauseOnInteract: true }), scene(false), {}), false);
assert.equal(resolvePauseOnInteract(story({ pauseOnInteract: true }), scene(false), { pauseOnInteract: true }), true);
assert.equal(resolvePauseOnInteract(story(), scene(true), { pauseOnInteract: false }), false);

assert.equal(resolveLanguageToggle(1, story({ languageToggle: 'inline' })), 'none');
assert.equal(resolveLanguageToggle(2, story()), 'menu');
assert.equal(resolveLanguageToggle(2, story({ languageToggle: 'auto' })), 'inline');
assert.equal(resolveLanguageToggle(3, story({ languageToggle: 'auto' })), 'menu');
assert.equal(resolveLanguageToggle(2, story({ languageToggle: 'menu' }), 'inline'), 'inline');
assert.equal(resolveLanguageToggle(2, story({ languageToggle: 'none' })), 'none');

configurePlayer({ pauseOnInteract: true, languageToggle: 'auto', theme: { '--dive-accent': '#123456', '--bad': 'x; color: red', color: 'red' } });
assert.equal(resolvePauseOnInteract(story(), scene(), {}), true);
assert.equal(resolvePauseOnInteract(story({ pauseOnInteract: false }), scene(), {}), false);
assert.equal(resolveLanguageToggle(2, story()), 'inline');
assert.equal(resolveLanguageToggle(2, story({ languageToggle: 'menu' })), 'menu');
assert.equal(themeCss(), ':host { --dive-accent: #123456; }');

assert.equal(playerCopy('cy').play, 'Chwarae');
assert.equal(playerCopy('cy-GB').play, 'Chwarae');
assert.equal(playerCopy('fr').play, 'Play');
const fr = playerCopy('fr', { fr: { play: 'Lire', bogus: 'x' } }, { fr: { pause: 'Pause (story)' } });
assert.equal(fr.play, 'Lire');
assert.equal(fr.pause, 'Pause (story)');
assert.equal(fr.retry, 'Retry');
assert.equal('bogus' in fr, false);
assert.equal(playerCopy('cy', { cy: { play: 'A' } }, { cy: { play: 'B' } }).play, 'B');

console.log('player-config: ok');
