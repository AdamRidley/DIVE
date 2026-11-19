import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const channel = process.argv.find(argument => argument.startsWith('--channel='))?.split('=')[1];
const theme = {
  '--dive-play-button-label-display': 'inline',
  '--dive-play-button-min-width': '120px',
  '--dive-play-button-height': '48px',
  '--dive-play-button-padding': '10px 16px',
  '--dive-play-button-gap': '10px',
  '--dive-play-button-border': '2px solid currentColor',
  '--dive-play-button-radius': '6px',
  '--dive-play-button-bg': '#444',
  '--dive-play-button-hover-bg': '#666',
  '--dive-play-button-font-size': '18px',
  '--dive-play-button-font-weight': '700',
  '--dive-play-button-order': '-2',
  '--dive-time-display-order': '-1',
};
const story = {
  title: 'Control regression fixture',
  duration: 60000,
  aspectRatio: '16:9',
  pauseOnInteract: true,
  languages: [{ code: 'en', label: 'English' }, { code: 'cy', label: 'Cymraeg' }],
  audio: [{ src: '/__controls-audio.wav', role: 'narration' }],
  settingsLinks: [{ label: 'Download fixture', href: '/__controls-download.txt', download: 'fixture.txt' }],
  captions: [
    { srclang: 'en', cues: [{ startTime: 0, endTime: 60000, text: 'Control test captions' }] },
    { kind: 'descriptions', cues: [{ startTime: 0, endTime: 60000, text: 'Description test' }] },
  ],
  timelineSections: [
    { startTime: 0, endTime: 30000, label: { en: 'First chapter', cy: 'Pennod gyntaf' } },
    { startTime: 30000, endTime: 60000, label: { en: 'Second chapter', cy: 'Ail bennod' } },
  ],
  scenes: [{
    id: 'controls', label: { en: 'Control introduction', cy: 'Cyflwyniad rheolyddion' },
    tool: '/__controls-tool.html', startTime: 0, endTime: 60000,
    keyframes: [{ time: 0, state: {} }], overlays: [],
  }],
};
const server = await createServer({
  root, configFile: false,
  server: { host: '127.0.0.1', port: 0, hmr: false, forwardConsole: false },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = new Set();
  page.on('pageerror', error => errors.add(error.stack || error.message));
  await page.route('**/__controls-test', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="en"><style>
      body { margin: 0; }
      dive-video { width: 100%; height: 700px; }
    </style><dive-video src="/__controls-story.json"></dive-video>
    <script type="module">
      import { configure } from '/src/index.ts';
      window.configureControls = configure;
    </script></html>`,
  }));
  await page.route('**/__controls-story.json', route => route.fulfill({ json: story }));
  await page.route('**/__controls-download.txt', route => route.fulfill({ contentType: 'text/plain', body: 'Transcript fixture' }));
  await page.route('**/__controls-audio.wav', route => {
    const wav = Buffer.alloc(44 + 60000 * 8, 128);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
    wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    return route.fulfill({ contentType: 'audio/wav', body: wav });
  });
  await page.route('**/__controls-tool.html', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><p>Interactive tool</p><script>parent.postMessage({type:"DIVE_READY"},"*")</script>',
  }));
  await page.goto(`${server.resolvedUrls.local[0]}__controls-test`);
  await page.waitForFunction(() => window.configureControls && document.querySelector('dive-video')?.sceneReady);
  const play = page.locator('dive-video [part="play-button"]');
  const label = play.locator('.play-label');
  const slider = page.locator('dive-video [role="slider"]');
  const time = page.locator('dive-video [part="time-display"]');

  const appearance = () => play.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      width: style.width, height: style.height, padding: style.padding,
      border: style.borderWidth, background: style.backgroundColor, order: style.order,
      label: getComputedStyle(element.querySelector('.play-label')).display,
    };
  });
  await page.mouse.move(0, 0);
  const original = await appearance();
  assert.deepEqual(original, {
    width: '40px', height: '40px', padding: '0px', border: '0px',
    background: 'rgba(0, 0, 0, 0)', order: '0', label: 'none',
  }, 'Unconfigured public player must retain its compact icon-only style');
  assert.equal(await page.locator('dive-video .progress-percent, dive-video [role="progressbar"]').count(), 0);
  assert.equal((await time.textContent()).trim(), '0:00 / 1:00');
  const captions = page.locator('dive-video .captions-btn');
  assert.equal(await captions.getAttribute('aria-pressed'), 'true', 'Available captions start enabled, as before');
  assert.equal(await captions.locator('rect').count(), 0, 'Enabled CC uses the filled icon');
  await captions.click();
  assert.equal(await captions.getAttribute('aria-pressed'), 'false');
  assert.equal(await captions.locator('rect').getAttribute('fill'), 'none', 'Disabled CC uses the outline icon');
  await captions.press('Enter');
  assert.equal(await captions.getAttribute('aria-pressed'), 'true', 'Keyboard toggling turns captions on');
  assert.ok(await page.locator('dive-video .section-band').first().evaluate(element =>
    getComputedStyle(element).borderRightColor === 'rgb(255, 255, 255)'),
  'Timeline section boundaries must stay solid white');
  await page.locator('dive-video').evaluate(player => {
    const root = player.shadowRoot;
    const marker = document.createElement('div');
    marker.className = 'scene-marker';
    root.querySelector('.scrubber').appendChild(marker);
  });
  assert.ok(await page.locator('dive-video .scene-marker').last().evaluate(element => {
    const style = getComputedStyle(element);
    const label = getComputedStyle(element.getRootNode().querySelector('.section-label'));
    return style.backgroundColor === 'rgba(255, 255, 255, 0.3)' && Number(style.zIndex) < Number(label.zIndex);
  }), 'Scene markers must be faded and behind labels');
  await page.locator('dive-video .scene-marker').last().evaluate(element => element.remove());
  await page.locator('dive-video').evaluate(player => player.setAttribute('language-toggle', 'inline'));
  const pill = page.locator('dive-video [part="lang-toggle"]');
  assert.ok(await pill.locator('.language-name').first().evaluate(element => getComputedStyle(element).display === 'none'));
  assert.ok(await pill.locator('.language-code').first().isVisible(), 'Public pill uses compact language codes by default');
  for (const locale of ['cy', 'en']) {
    await pill.locator(`button[lang="${locale}"]`).click();
    await page.waitForTimeout(280);
    const indicator = await pill.evaluate(element => {
      const style = getComputedStyle(element, '::before');
      return { x: new DOMMatrixReadOnly(style.transform).m41, width: parseFloat(style.width) };
    });
    assert.ok(Math.abs(indicator.x - (locale === 'cy' ? indicator.width : 0)) < 1,
      'The underline must align with the selected language');
    assert.equal(await pill.locator('button[aria-current="true"]').getAttribute('lang'), locale);
  }
  await page.locator('dive-video').evaluate(player => {
    player.style.setProperty('--dive-language-name-display', 'inline');
    player.style.setProperty('--dive-language-code-display', 'none');
  });
  assert.ok(await pill.locator('.language-name').first().isVisible(), 'Full names must be an opt-in theme choice');
  assert.equal(await pill.locator('.language-code').first().isVisible(), false);
  await page.locator('dive-video').evaluate(player => player.removeAttribute('language-toggle'));
  for (const [locale, text] of [['en', { play: 'Play', pause: 'Pause' }], ['cy', { play: 'Chwarae', pause: 'Oedi' }]]) {
    await page.evaluate(locale => document.querySelector('dive-video').setLanguage(locale), locale);
    await page.evaluate(theme => window.configureControls({ theme }), theme);
    await page.mouse.move(0, 0);
    const styled = await appearance();
    assert.ok(parseFloat(styled.width) >= 120, 'Labelled button must meet its configured minimum width');
    assert.equal(styled.height, '48px');
    assert.equal(styled.border, '2px');
    assert.equal(styled.background, 'rgb(68, 68, 68)');
    assert.equal(styled.order, '-2');
    assert.notEqual(styled.label, 'none');
    assert.equal(await label.textContent(), text.play);
    assert.equal(await label.getAttribute('aria-hidden'), 'true');
    await play.click();
    await page.waitForFunction(() => document.querySelector('dive-video').isPlaying);
    assert.equal(await label.textContent(), text.pause);
    assert.equal(await play.getAttribute('aria-label'), text.pause);
    await play.click();
    assert.equal(await label.textContent(), text.play);

    for (const mode of ['inset', 'autohide']) {
      await page.locator('dive-video').evaluate((player, mode) => player.setAttribute('ui-mode', mode), mode);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await slider.boundingBox();
        assert.ok(bounds && bounds.width > 0, 'Timeline must remain visible on narrow screens');
        const y = bounds.y + bounds.height / 2;
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.mouse.move(bounds.x + bounds.width * 0.1, y);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width * 0.75, y, { steps: 15 });
        await page.mouse.up();
        const current = Number(await slider.getAttribute('aria-valuenow'));
        assert.ok(Math.abs(current - 45) <= 1, `${locale} ${mode} ${width}px: dragging must seek to 75%`);
        assert.equal(await page.evaluate(() => getSelection().toString()), '', 'Scrubbing must not select chapter text');
        assert.ok(await slider.evaluate(element => element.getRootNode().activeElement === element),
          'Pointer seeking must focus the slider for subsequent keyboard seeking');
        await slider.press('Home');
        assert.equal(await slider.getAttribute('aria-valuenow'), '0', 'Keyboard seeking must remain available');
        await time.dblclick();
        assert.equal(await page.evaluate(() => getSelection().toString()), '', 'Elapsed/total time must not be selectable');
        assert.equal(await time.evaluate(element => getComputedStyle(element).userSelect), 'none');
        assert.equal(await slider.evaluate(element => getComputedStyle(element).userSelect), 'none');
        assert.equal(await slider.evaluate(element => getComputedStyle(element).touchAction), 'none');
        await play.dblclick();
        assert.equal(await page.evaluate(() => getSelection().toString()), '', 'Play button text must not be selectable');
        assert.equal(await label.evaluate(element => getComputedStyle(element).userSelect), 'none');
        await page.evaluate(() => {
          const player = document.querySelector('dive-video');
          if (player.isPlaying) player.togglePlay();
        });
        for (const drawer of ['settings', 'chapters']) {
          await page.locator(`dive-video [aria-controls="${drawer}-drawer"]`).click();
          const panel = page.locator(`dive-video #${drawer}-drawer`);
          assert.ok(await panel.evaluate(element => element.contains(element.getRootNode().activeElement)),
            'Opening a drawer must move focus inside');
          assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth),
            `${locale} ${mode} ${width}px: ${drawer} must not overflow horizontally`);
          await page.keyboard.press('Escape');
          assert.ok(await page.locator(`dive-video [aria-controls="${drawer}-drawer"]`).evaluate(element =>
            element.getRootNode().activeElement === element), 'Escape must restore drawer-trigger focus');
        }
        await page.evaluate(locale => window.configureControls({
          playerText: { [locale]: { audioDescription: 'LongLocalizedDescriptionSetting'.repeat(8) } },
        }), locale);
        await page.locator('dive-video [aria-controls="settings-drawer"]').click();
        const settings = page.locator('dive-video #settings-drawer');
        assert.ok(await settings.evaluate(element => {
          const label = element.querySelector('input').closest('label');
          return element.scrollWidth <= element.clientWidth &&
            label.getBoundingClientRect().right <= element.getBoundingClientRect().right;
        }), `${locale} ${mode} ${width}px: long settings labels must wrap inside the drawer`);
        await settings.locator('input').check();
        assert.equal(await settings.locator('input').isChecked(), true);
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.locator('dive-video').evaluate(player => player.style.setProperty('--dive-play-button-bg', 'rgb(12, 34, 56)'));
  await page.mouse.move(0, 0);
  assert.equal((await appearance()).background, 'rgb(12, 34, 56)', 'Page CSS must override configured themes');
  await page.locator('dive-video').evaluate(player => player.style.removeProperty('--dive-play-button-bg'));
  await page.evaluate(() => window.configureControls({ theme: {} }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.mouse.move(0, 0);
  assert.deepEqual(await appearance(), original, 'Clearing the optional theme must restore the public defaults');
  await page.evaluate(() => {
    const rule = [...document.querySelector('style').sheet.cssRules]
      .find(rule => rule.selectorText === 'dive-video');
    rule.style.removeProperty('height');
  });
  const player = page.locator('dive-video');
  await player.evaluate(element => element.setAttribute('ui-mode', 'inset'));
  const chapterTrigger = player.locator('[aria-controls="chapters-drawer"]');
  const languageTrigger = player.locator('[aria-controls="languages-drawer"]');
  assert.equal(await chapterTrigger.locator('.dropdown-label').isVisible(), false);
  assert.equal(await chapterTrigger.locator('.dropdown-chevron').isVisible(), false);
  assert.equal(await player.locator('.chrome-help').textContent().then(text => text.trim()), 'Oedwch y fideo i archwilio.');
  await player.evaluate(element => {
    element.style.setProperty('--dive-header-label-display', 'inline');
    element.style.setProperty('--dive-header-chevron-display', 'block');
  });
  assert.ok(await chapterTrigger.locator('.dropdown-label').isVisible());
  assert.ok(await chapterTrigger.locator('.dropdown-chevron').isVisible());
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await chapterTrigger.locator('.dropdown-label').isVisible(), false,
    'Narrow players must hide labels even when enabled in the theme');
  await page.setViewportSize({ width: 1280, height: 900 });
  await chapterTrigger.click();
  await languageTrigger.click();
  assert.equal(await chapterTrigger.getAttribute('aria-expanded'), 'false');
  const languagesPanel = player.locator('#languages-drawer');
  assert.ok(await languagesPanel.locator('[aria-current="true"]').evaluate(node => node === node.getRootNode().activeElement));
  await languagesPanel.locator('[lang="en"]').click();
  assert.equal(await languageTrigger.getAttribute('aria-expanded'), 'false');
  assert.ok(await languageTrigger.evaluate(node => node === node.getRootNode().activeElement));
  await chapterTrigger.click();
  await time.click();
  assert.equal(await chapterTrigger.getAttribute('aria-expanded'), 'false');
  await player.evaluate(element => {
    const help = document.createElement('span');
    help.slot = 'player-help';
    help.textContent = 'Custom author help';
    element.appendChild(help);
  });
  assert.equal(await player.locator('slot[name="player-help"]').evaluate(slot => slot.assignedElements()[0].textContent), 'Custom author help');
  await player.locator('[slot="player-help"]').evaluate(node => { node.textContent = 'Custom wrapping author help. '.repeat(16); });
  const fullscreen = player.locator('button[title="Toggle Fullscreen"]');
  await fullscreen.click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  assert.ok(await player.locator('.chrome-help').evaluate(node => {
    const help = node.getBoundingClientRect();
    const header = node.parentElement.getBoundingClientRect();
    return help.top >= header.top && help.bottom <= header.bottom && header.height > 52;
  }), 'Fullscreen header must grow to contain wrapped author help');
  await fullscreen.click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await player.locator('[slot="player-help"]').evaluate(node => node.remove());
  for (const property of ['--dive-header-label-display', '--dive-header-chevron-display']) {
    await player.evaluate((element, property) => element.style.removeProperty(property), property);
  }
  const volume = player.locator('.volume-slider');
  const setVolume = value => volume.evaluate((node, value) => {
    node.value = String(value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  const volumeButton = player.locator('.volume-button');
  const timelineBefore = await slider.boundingBox();
  await volumeButton.hover();
  await volume.waitFor({ state: 'visible' });
  const volumeBounds = await volume.boundingBox();
  const timelineAfter = await slider.boundingBox();
  assert.ok(volumeBounds.height > volumeBounds.width * 3, 'Volume slider must render vertically');
  assert.equal(timelineBefore.width, timelineAfter.width, 'Volume popup must not shrink the timeline');
  await volume.focus();
  await volume.press('ArrowDown');
  assert.equal(await volume.inputValue(), '0.99', 'Vertical down arrow must lower volume');
  for (const [level, waves] of [[0, 0], [0.01, 1], [0.33, 1], [0.34, 2], [0.66, 2], [0.67, 3], [1, 3]]) {
    await setVolume(level);
    await player.evaluate(element => element.updateComplete);
    assert.equal(await volumeButton.locator('.volume-wave').count(), waves, `${level}: volume icon must show ${waves} waves`);
    assert.equal(await volumeButton.locator('.volume-muted').count(), level === 0 ? 1 : 0,
      'Zero volume must show the muted icon');
    assert.ok(await volumeButton.locator('.volume-stroke').evaluateAll(paths => paths.every(path => {
      const bounds = path.getBoundingClientRect();
      const box = path.getBBox();
      const stroke = parseFloat(getComputedStyle(path).strokeWidth) / 2;
      const view = path.ownerSVGElement.viewBox.baseVal;
      return path instanceof SVGPathElement && bounds.width > 0 && bounds.height > 0
        && getComputedStyle(path).stroke !== 'none'
        && box.x - stroke >= view.x && box.y - stroke >= view.y
        && box.x + box.width + stroke <= view.x + view.width
        && box.y + box.height + stroke <= view.y + view.height;
    })), `${level}: changing icon paths must be actual visible SVG, not HTML elements`);
  }
  await setVolume(0.4);
  assert.equal(await player.evaluate(element => element.audioEngine.clips[0].element.volume), 0.4);
  await volumeButton.click();
  assert.equal(await volumeButton.getAttribute('aria-pressed'), 'true');
  assert.equal(await volumeButton.locator('.volume-muted').count(), 1, 'Muting a non-zero volume must show the muted icon');
  assert.equal(await volumeButton.locator('.volume-wave').count(), 0);
  await volumeButton.click();
  assert.equal(await volume.inputValue(), '0.4', 'Unmute must restore previous non-zero volume');
  assert.equal(await volumeButton.locator('.volume-wave').count(), 2, 'Unmuting must restore the matching volume icon');
  await setVolume(0);
  assert.equal(await volumeButton.getAttribute('aria-pressed'), 'true');
  await volumeButton.click();
  assert.equal(await volume.inputValue(), '0.4');
  await setVolume(0.6);
  assert.equal(await volumeButton.getAttribute('aria-pressed'), 'false');
  await player.locator('[aria-controls="settings-drawer"]').click();
  const downloadEvent = page.waitForEvent('download');
  await player.locator('#settings-drawer a').click();
  assert.equal((await downloadEvent).suggestedFilename(), 'fixture.txt');
  await page.keyboard.press('Escape');
  await slider.press('ArrowRight');
  const progress = await player.locator('.progress').evaluate(node => {
    const style = getComputedStyle(node);
    return { width: node.getBoundingClientRect().width, parent: node.parentElement.getBoundingClientRect().width, clip: style.clipPath };
  });
  assert.equal(progress.width, progress.parent, 'Progress fill must always cover the full track before clipping');
  assert.ok(progress.clip.startsWith('inset('), 'Progress must use a vertical clipping edge, not a rounded moving end');
  assert.equal(await player.locator('.chapter-marker').count(), story.timelineSections.length);
  await chapterTrigger.click();
  assert.equal(await player.locator('#chapters-drawer button').first().textContent(), 'Control introduction');
  await page.keyboard.press('Escape');
  await player.evaluate(element => {
    const scene = element.story.scenes[0];
    element.story = { ...element.story, scenes: [
      { ...scene, endTime: 20000 },
      { ...scene, id: 'detail', label: { en: 'More detail', cy: 'Rhagor o fanylion' }, startTime: 20000 },
    ] };
  });
  const sectionBounds = await player.locator('.section-band').last().boundingBox();
  await page.mouse.move(sectionBounds.x + sectionBounds.width / 2, sectionBounds.y + sectionBounds.height / 2);
  assert.ok(await player.locator('.timeline-tooltip').isVisible(),
    'Hovering anywhere in a section must show its tooltip');
  const scrubberBounds = await slider.boundingBox();
  for (const [time, heading, subheading] of [
    [10000, 'First chapter', 'Control introduction'],
    [19900, 'First chapter', 'Control introduction'],
    [20100, 'First chapter', 'More detail'],
    [29900, 'First chapter', 'More detail'],
    [30100, 'Second chapter', 'More detail'],
    [45000, 'Second chapter', 'More detail'],
  ]) {
    const x = scrubberBounds.x + time / story.duration * scrubberBounds.width;
    await page.mouse.move(x, scrubberBounds.y + scrubberBounds.height / 2);
    await page.waitForFunction(({ heading, subheading }) => {
      const root = document.querySelector('dive-video').shadowRoot;
      return root.querySelector('.timeline-tooltip-heading')?.textContent === heading
        && root.querySelector('.timeline-tooltip-subheading')?.textContent === subheading;
    }, { heading, subheading });
    const tooltip = await player.locator('.timeline-tooltip').boundingBox();
    assert.ok(Math.abs(tooltip.x + tooltip.width / 2 - x) <= 1,
      'Tooltip centre must follow the mouse, not snap to scene dots or section centres');
  }
  assert.ok(await player.evaluate(element => {
    const bands = [...element.shadowRoot.querySelectorAll('.section-band')];
    return [...element.shadowRoot.querySelectorAll('.chapter-marker')].every((marker, index) => {
      const dot = marker.getBoundingClientRect();
      const line = getComputedStyle(bands[index], '::before');
      const lineCentre = bands[index].getBoundingClientRect().left + parseFloat(line.left)
        + parseFloat(line.width) / 2 + new DOMMatrixReadOnly(line.transform).m41;
      return Math.abs(dot.left + dot.width / 2 - lineCentre) < 0.1
        && Number(line.zIndex) > Number(getComputedStyle(element.shadowRoot.querySelector('.progress')).zIndex);
    });
  }), 'Boundary lines must stay above progress and share an exact horizontal centre with main dots');
  assert.ok(await player.evaluate(element => {
    const root = element.shadowRoot;
    const track = root.querySelector('.scrubber');
    const mask = root.querySelector('.timeline-sections');
    const bounds = track.getBoundingClientRect();
    const style = getComputedStyle(mask);
    const corners = [
      [bounds.left + 0.25, bounds.top + 0.25],
      [bounds.right - 0.25, bounds.bottom - 0.25],
    ];
    return style.overflow === 'hidden'
      && style.borderRadius === getComputedStyle(track).borderRadius
      && corners.every(([x, y]) => !root.elementFromPoint(x, y)?.closest('.timeline-sections'))
      && [...root.querySelectorAll('.scene-marker, .timeline-tooltip')].every(node => !mask.contains(node))
      && getComputedStyle(track).overflow === 'visible';
  }), 'Round-track masking must clip section boundaries at the corners without clipping dots or tooltips');
  await player.evaluate(element => element.setLanguage('cy'));
  await page.waitForFunction(() => document.querySelector('dive-video').shadowRoot
    .querySelector('.timeline-tooltip-subheading')?.textContent === 'Rhagor o fanylion');
  assert.equal(await player.locator('.timeline-tooltip-heading').textContent(), 'Ail bennod');
  await player.evaluate((element, scenes) => {
    element.setLanguage('en');
    element.story = { ...element.story, scenes };
  }, story.scenes);
  await page.mouse.move(100, 100);
  assert.equal(await player.locator('.timeline-tooltip').count(), 0, 'Leaving the timeline must dismiss the tooltip');
  await slider.press('Home');
  await player.evaluate(element => element.setAttribute('ui-mode', 'autohide'));
  assert.ok(await player.locator('.top-scrim').evaluate(node => {
    const style = getComputedStyle(node);
    const button = node.getRootNode().querySelector('.chapter-button');
    const buttonStyle = getComputedStyle(button);
    return style.backgroundImage.startsWith('linear-gradient(') && style.pointerEvents === 'none'
      && Math.abs(node.getBoundingClientRect().height - node.getRootNode().querySelector('.controls').getBoundingClientRect().height) < 1
      && getComputedStyle(node.getRootNode().querySelector('.controls')).backgroundImage
        .replace(/^linear-gradient\((?:to top|0deg), /, 'linear-gradient(') === style.backgroundImage
      && node.getBoundingClientRect().height >= button.getBoundingClientRect().bottom - node.getBoundingClientRect().top
      && Number(style.zIndex) < Number(getComputedStyle(button.parentElement).zIndex)
      && buttonStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
      && buttonStyle.borderColor === 'rgba(0, 0, 0, 0)'
      && buttonStyle.backdropFilter === 'none';
  }), 'Autohide must provide a non-interactive fading top scrim behind transparent header buttons');
  await play.click();
  await page.waitForFunction(() => document.querySelector('dive-video').isPlaying);
  await player.evaluate(async element => {
    element.setAttribute('ui-mode', 'inset');
    await element.updateComplete;
    element.isUIHidden = false;
    element.shadowRoot.querySelector('.play-catcher').dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, composed: true, pointerType: 'touch',
    }));
  });
  assert.equal(await player.evaluate(element => element.isPlaying), false,
    'A stage tap in inset mode must pause because controls are always visible');
  await play.click();
  await page.waitForFunction(() => document.querySelector('dive-video').isPlaying);
  const tapState = await player.evaluate(async element => {
    element.setAttribute('ui-mode', 'autohide');
    await element.updateComplete;
    element.isUIHidden = true;
    element.shadowRoot.querySelector('.play-catcher').dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, composed: true, pointerType: 'touch',
    }));
    await element.updateComplete;
    return { hidden: element.isUIHidden, playing: element.isPlaying };
  });
  assert.equal(tapState.hidden, false,
    'The first stage tap in autohide mode must reveal controls');
  assert.equal(tapState.playing, true,
    'The first stage tap in autohide mode must reveal controls without pausing');
  await page.mouse.move(100, 100);
  await page.mouse.move(100, 850);
  await page.waitForFunction(() => document.querySelector('dive-video').isUIHidden, null, { timeout: 1000 });
  assert.ok(await player.locator('.top-scrim').evaluate(node => node.classList.contains('hidden')),
    'Top scrim must hide with the controls');
  await page.mouse.move(100, 100);
  await page.waitForFunction(() => !document.querySelector('dive-video').isUIHidden);
  await player.dispatchEvent('pointerleave', { pointerType: 'touch' });
  assert.equal(await player.evaluate(element => element.isUIHidden), false,
    'Touch release must not hide controls immediately');
  for (const drawer of ['settings', 'chapters']) {
    await player.locator(`[aria-controls="${drawer}-drawer"]`).click();
    await page.mouse.move(100, 850);
    assert.equal(await player.evaluate(element => element.isUIHidden), false,
      'Leaving an open drawer must keep controls visible');
    await player.locator(`[aria-controls="${drawer}-drawer"]`).click();
  }
  await play.focus();
  await page.keyboard.press('Tab');
  await page.mouse.move(100, 100);
  await page.mouse.move(100, 850);
  assert.equal(await player.evaluate(element => element.isUIHidden), false,
    'Mouse leave must preserve keyboard-focused controls');
  await play.click();
  await page.mouse.move(100, 850);
  assert.equal(await player.evaluate(element => element.isUIHidden), false,
    'Paused controls must remain visible after mouse leave');
  await player.evaluate(element => element.setAttribute('ui-mode', 'inset'));
  assert.equal(await player.locator('.top-scrim').count(), 0, 'Inset header must not paint a gradient over the picture');
  await play.click();
  await page.mouse.move(100, 850);
  assert.equal(await player.evaluate(element => element.isUIHidden), false,
    'Inset controls must remain visible after mouse leave');
  await play.click();
  assert.equal(await player.locator('#canvas-container').evaluate(element =>
    getComputedStyle(element).transitionProperty), 'opacity',
  'Content scaling must fit instantly; only scene opacity may transition');
  await player.evaluate(element => {
    element.style.width = '720px';
    element.setAttribute('ui-mode', 'inset');
    element.captionsBelow = true;
    element.captionsEnabled = false;
  });
  for (const enabled of [true, false, true]) {
    await page.locator('dive-video .captions-btn').click();
    assert.equal(await page.locator('dive-video .captions-btn').getAttribute('aria-pressed'), String(enabled));
    await page.waitForFunction(() => {
      const root = document.querySelector('dive-video').shadowRoot;
      const area = root.querySelector('.picture-area').getBoundingClientRect();
      const wrap = root.querySelector('.video-ratio-wrapper').getBoundingClientRect();
      const canvas = root.querySelector('#canvas-container').getBoundingClientRect();
      return Math.abs(area.width - wrap.width) < 1 && Math.abs(area.height - wrap.height) < 1
        && Math.abs(canvas.width - wrap.width) < 1 && Math.abs(canvas.height - wrap.height) < 1;
    }, null, { timeout: 5000 });
  }
  for (const width of [320, 720]) {
    await player.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
    await page.waitForTimeout(100);
    let baseline;
    for (const text of ['A short caption.', 'W'.repeat(42), 'An authored line\nwith a second line', '']) {
      await player.evaluate((element, text) => {
        element.activeCues = text ? [{ startTime: 0, endTime: 60000, text }] : [];
      }, text);
      await page.waitForTimeout(50);
      const dimensions = await player.evaluate(element => {
        const band = element.shadowRoot.querySelector('.captions.below');
        const cue = band.querySelector('.caption-cue');
        const style = getComputedStyle(band);
        const picture = element.shadowRoot.querySelector('.picture-area').getBoundingClientRect();
        return {
          pictureHeight: picture.height, bandHeight: band.getBoundingClientRect().height,
          cueWidth: cue.getBoundingClientRect().width, cueHeight: cue.getBoundingClientRect().height,
          availableWidth: band.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          lineHeight: parseFloat(getComputedStyle(cue).lineHeight),
          whitespace: getComputedStyle(cue).whiteSpace,
        };
      });
      baseline ||= dimensions;
      assert.equal(dimensions.whitespace, 'nowrap');
      assert.ok(dimensions.cueWidth <= dimensions.availableWidth + 0.5,
        `${width}px: complete captions must fit without clipping or wrapping`);
      assert.ok(dimensions.cueHeight <= dimensions.lineHeight + 0.5, 'Captions must remain one rendered line');
      assert.equal(dimensions.bandHeight, baseline.bandHeight, 'Cue changes and gaps must not resize the caption band');
      assert.equal(dimensions.pictureHeight, baseline.pictureHeight, 'Cue changes and gaps must not resize the picture');
    }
  }
  await player.evaluate(element => element.syncMedia(element.currentTime));
  for (const mode of ['autohide', 'inset']) {
    for (const below of [false, true]) {
      for (const [width, aspectRatio] of [[320, '16:9'], [720, '4:3'], [320, '9:16']]) {
        await player.evaluate((element, { mode, below, width, aspectRatio }) => {
          element.setAttribute('ui-mode', mode);
          element.captionsBelow = below;
          element.style.width = `${width}px`;
          element.story = { ...element.story, aspectRatio };
        }, { mode, below, width, aspectRatio });
        await page.waitForFunction(() => {
          const element = document.querySelector('dive-video');
          const picture = element.shadowRoot.querySelector('.picture-area').getBoundingClientRect();
          const video = element.shadowRoot.querySelector('.video-ratio-wrapper').getBoundingClientRect();
          return Math.abs(picture.width - video.width) < 1 && Math.abs(picture.height - video.height) < 1;
        }, null, { timeout: 5000 }).catch(async error => {
          console.error({ mode, below, width, aspectRatio }, await player.evaluate(element => ({
            height: getComputedStyle(element).height,
            boxes: [...element.shadowRoot.querySelectorAll('.picture-area, .video-ratio-wrapper, .chrome-top, .controls, .captions.below')]
              .map(node => ({ class: node.className, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
          })));
          throw error;
        });
        const sizes = await player.evaluate(element => {
          const root = element.shadowRoot;
          const video = root.querySelector('.video-ratio-wrapper').getBoundingClientRect();
          const chrome = element.matches(':state(inset)')
            ? [...root.querySelectorAll('.chrome-top, .controls')].reduce((sum, item) => sum + item.getBoundingClientRect().height, 0) : 0;
          const captions = root.querySelector('.captions.below')?.getBoundingClientRect().height || 0;
          return { host: element.getBoundingClientRect().height, width: video.width, video: video.height, chrome, captions };
        });
        const [aw, ah] = aspectRatio.split(':').map(Number);
        assert.ok(Math.abs(sizes.width - width) < 1, 'Uncapped video must fill its available width');
        assert.ok(Math.abs(sizes.video - width * ah / aw) < 1, 'Video height must preserve the story aspect');
        assert.ok(Math.abs(sizes.host - sizes.video - sizes.chrome - sizes.captions) < 1,
          `${mode}, captions-below=${below}: automatic height must include chrome and captions without black bars`);
      }
    }
    await player.evaluate(element => {
      element.style.width = '100%';
      element.story = { ...element.story, aspectRatio: '9:16' };
    });
    await page.waitForFunction(() => Math.abs(document.querySelector('dive-video').getBoundingClientRect().height - innerHeight) < 1);
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.waitForFunction(() => Math.abs(document.querySelector('dive-video').getBoundingClientRect().height - 600) < 1);
    await player.evaluate(element => element.style.height = '1100px');
    assert.equal(await player.evaluate(element => element.getBoundingClientRect().height), 1100,
      'Explicit CSS height must override both automatic sizing and its viewport cap');
    await player.evaluate(element => element.style.maxHeight = '450px');
    assert.equal(await player.evaluate(element => element.getBoundingClientRect().height), 450,
      'CSS max-height must still be respected');
    await player.evaluate(element => {
      element.style.removeProperty('height');
      element.style.removeProperty('max-height');
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await player.evaluate(element => {
    element.removeAttribute('ui-mode');
    element.story = { ...element.story, uiMode: 'autohide' };
    element.story.scenes[0].uiMode = 'inset';
  });
  await page.waitForFunction(() => document.querySelector('dive-video').matches(':state(inset)'));
  await player.evaluate(element => element.setAttribute('ui-mode', 'autohide'));
  await page.waitForFunction(() => !document.querySelector('dive-video').matches(':state(inset)'));
  await player.evaluate(element => {
    element.setAttribute('language-toggle', 'menu');
    element.removeAttribute('captions-below');
    element.style.height = '480px';
  });
  const hostInputs = await player.evaluate(element => ({
    style: element.getAttribute('style'),
    mode: element.getAttribute('ui-mode'),
    language: element.getAttribute('language-toggle'),
    captions: element.hasAttribute('captions-below'),
  }));
  await play.click();
  await page.waitForFunction(() => document.querySelector('dive-video').isPlaying);
  await page.waitForTimeout(100);
  await play.click();
  assert.deepEqual(await player.evaluate(element => ({
    style: element.getAttribute('style'),
    mode: element.getAttribute('ui-mode'),
    language: element.getAttribute('language-toggle'),
    captions: element.hasAttribute('captions-below'),
  })), hostInputs, 'Playback must not rewrite author attributes or inline CSS');
  assert.equal(await player.getAttribute('active-ui-mode'), null, 'Resolved mode must not be stored in a host attribute');
  await player.evaluate(element => {
    element.removeAttribute('ui-mode');
    element.captionsBelow = true;
    element.isMuted = true;
  });
  await page.waitForFunction(() => {
    const element = document.querySelector('dive-video');
    return element.matches(':state(inset)') && element.matches(':state(captions-below)');
  });
  assert.equal(await player.getAttribute('captions-below'), null, 'JS caption configuration must not write an attribute');
  assert.equal(await player.getAttribute('muted'), null, 'Mute state must not write author configuration');
  assert.equal(await player.evaluate(element => element.getBoundingClientRect().height), 480,
    'Explicit author height must survive playback and mode changes');
  await player.evaluate(element => {
    element.captionsBelow = false;
    element.captionsEnabled = true;
    element.syncMedia(element.currentTime);
  });
  assert.ok(await player.locator('.captions:not(.below)').evaluate(node => {
    const bottom = parseFloat(getComputedStyle(node).bottom);
    return bottom <= node.parentElement.clientHeight * 0.021;
  }), 'Inset overlaid captions must sit near the bottom of the picture');
  await player.evaluate(element => {
    element.activeToolId = 'menu-14';
    element.currentTime = 59000;
    element.story = { ...element.story, scenes: Array.from({ length: 15 }, (_, index) => ({
      ...element.story.scenes[0], id: `menu-${index}`, startTime: index * 4000, endTime: (index + 1) * 4000,
    })) };
  });
  await chapterTrigger.click();
  assert.ok(await player.locator('#chapters-drawer').evaluate(node => node.scrollTop > 0),
    'Opening the chapter menu must scroll to the current scene');
  assert.ok(await player.locator('#chapters-drawer [aria-current="true"]').evaluate(node => {
    const panel = node.parentElement.getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    return node === node.getRootNode().activeElement && bounds.top >= panel.top && bounds.bottom <= panel.bottom;
  }), 'The current chapter must be visible and keyboard focused');
  await page.keyboard.press('Escape');
  await player.evaluate(element => {
    const scene = element.story.scenes[0];
    element.story = { ...element.story, timelineSections: [], scenes: [
      { ...scene, id: 'plain-label', label: 'Plain scene label', startTime: 0, endTime: 30000 },
      { ...scene, id: 'legacy-id', label: undefined, startTime: 30000, endTime: 60000 },
    ] };
  });
  await chapterTrigger.click();
  assert.deepEqual(await player.locator('#chapters-drawer button').allTextContents(), ['Plain scene label', 'legacy-id'],
    'Scene labels must support plain strings and fall back to ids for older stories');
  assert.deepEqual(await player.locator('.section-label').allTextContents(), ['Plain scene label', 'legacy-id'],
    'Generated timeline sections must use the same scene label fallback');
  await page.keyboard.press('Escape');
  await player.evaluate(element => {
    element.story = { ...element.story, uiMode: 'autohide' };
    element.story.scenes[0].uiMode = 'inset';
    element.activeToolId = element.story.scenes[0].id;
    element.removeAttribute('ui-mode');
    element.captionsBelow = true;
    element.captionsEnabled = true;
    element.activeCues = [{ startTime: 0, endTime: 60000, text: 'Layout setting caption' }];
  });
  const settingsTrigger = player.locator('[aria-controls="settings-drawer"]');
  await settingsTrigger.click();
  const layoutSetting = player.locator('.layout-setting');
  const captionSetting = player.locator('.caption-location-setting');
  assert.equal(await layoutSetting.inputValue(), 'default');
  assert.equal(await captionSetting.inputValue(), 'below');
  assert.ok(await layoutSetting.evaluate(node => node === node.getRootNode().activeElement),
    'Opening Settings must focus its first layout control');
  assert.ok(await player.evaluate(element => element.matches(':state(inset)')),
    'Default layout must respect scene-specific layout');
  await layoutSetting.selectOption('autohide');
  assert.ok(await player.evaluate(element => !element.matches(':state(inset)')),
    'Viewer autohide choice must override an inset scene');
  await layoutSetting.selectOption('inset');
  await player.evaluate(element => {
    element.story = { ...element.story, scenes: element.story.scenes.map(scene => ({ ...scene, uiMode: 'autohide' })) };
  });
  assert.ok(await player.evaluate(element => element.matches(':state(inset)')),
    'Explicit viewer layout must survive changing scene defaults');
  await layoutSetting.selectOption('default');
  assert.ok(await player.evaluate(element => !element.matches(':state(inset)')),
    'Default must restore authored scene resolution');
  await player.evaluate(element => element.setAttribute('ui-mode', 'inset'));
  await player.evaluate(element => element.updateComplete);
  assert.ok(await player.evaluate(element => element.matches(':state(inset)')),
    'Default must also follow authored attribute changes');
  await captionSetting.selectOption('overlaid');
  assert.equal(await player.locator('.captions.below').count(), 0);
  assert.equal(await player.locator('.captions:not(.below)').count(), 1);
  assert.equal(await player.evaluate(element => element.captionsBelow), true,
    'Viewer caption location must not rewrite the author property');
  await captionSetting.selectOption('below');
  assert.equal(await player.locator('.captions.below').count(), 1);
  assert.equal(await player.getAttribute('captions-below'), null,
    'Viewer caption choices must not write host attributes');
  assert.equal(await player.getAttribute('ui-mode'), 'inset',
    'Viewer layout choices must not rewrite authored layout attributes');
  await player.evaluate(element => element.setLanguage('cy'));
  await player.evaluate(element => element.updateComplete);
  assert.equal(await layoutSetting.getAttribute('aria-label'), null, 'Native labels must name settings controls');
  assert.equal(await layoutSetting.evaluate(node => node.labels[0].querySelector('span').textContent), 'Cynllun y chwaraewr');
  assert.equal(await captionSetting.evaluate(node => node.labels[0].querySelector('span').textContent), 'Lleoliad isdeitlau');
  await page.keyboard.press('Escape');
  assert.ok(await settingsTrigger.evaluate(node => node === node.getRootNode().activeElement),
    'Escape from settings must return focus to its trigger');
  await page.evaluate(() => window.configureControls({ showUiModeSetting: false, showCaptionLocationSetting: false }));
  await settingsTrigger.click();
  assert.equal(await layoutSetting.count(), 0);
  assert.equal(await captionSetting.count(), 0);
  await page.keyboard.press('Escape');
  await player.evaluate(element => {
    element.story = { ...element.story, showUiModeSetting: true, showCaptionLocationSetting: true };
  });
  await settingsTrigger.click();
  assert.equal(await layoutSetting.count(), 1, 'Story visibility must override configured false');
  assert.equal(await captionSetting.count(), 1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.configureControls({ showUiModeSetting: true, showCaptionLocationSetting: true }));
  await player.evaluate(element => {
    element.story = { ...element.story, showUiModeSetting: false, showCaptionLocationSetting: false };
  });
  await settingsTrigger.click();
  assert.equal(await layoutSetting.count(), 0, 'Story false must override configured true');
  assert.equal(await captionSetting.count(), 0);
  await page.keyboard.press('Escape');
  await player.evaluate(element => {
    element.story = { ...element.story, settingsLinks: [] };
    element.allAudioSpecs = element.allAudioSpecs.filter(clip => clip.role !== 'descriptions');
    element.captionTracks = element.captionTracks.filter(track => track.kind !== 'descriptions');
  });
  assert.equal(await settingsTrigger.count(), 0, 'Hide empty Settings when both controls and other resources are absent');
  await player.evaluate(element => {
    element.story = { ...element.story, showUiModeSetting: true };
  });
  await settingsTrigger.click();
  assert.equal(await layoutSetting.count(), 1, 'Layout control must make Settings available even without resources');
  assert.equal(await captionSetting.count(), 0, 'Caption location visibility must be independently configurable');
  await page.keyboard.press('Escape');
  await page.goto(`${server.resolvedUrls.local[0]}__controls-test`);
  await page.waitForFunction(() => document.querySelector('dive-video')?.sceneReady);
  await slider.click({ position: { x: 20, y: 10 } });
  assert.equal(await slider.evaluate(node => getComputedStyle(node).outlineStyle), 'none',
    'First mouse seek after a fresh load must not show a keyboard focus outline');
  assert.ok(await slider.evaluate(node => node === node.getRootNode().activeElement),
    'Mouse seeking must retain focus for keyboard follow-up');
  await slider.press('ArrowRight');
  assert.notEqual(await slider.evaluate(node => getComputedStyle(node).outlineStyle), 'none',
    'Keyboard navigation after mouse seeking must restore the timeline focus indicator');
  await play.click();
  await page.waitForFunction(() => document.querySelector('dive-video').isUIHidden, null, { timeout: 3500 });
  assert.ok(await play.evaluate(node => node === node.getRootNode().activeElement),
    'Mouse-started playback must autohide without removing button focus');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => !document.querySelector('dive-video').isUIHidden);
  await page.waitForTimeout(2800);
  assert.equal(await player.evaluate(element => element.isUIHidden), false,
    'Active keyboard navigation must hold controls visible');
  await play.focus();
  await page.keyboard.press('Enter');
  assert.equal(await player.evaluate(element => element.isPlaying), false);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('dive-video').isUIHidden, null, { timeout: 3500 });
  assert.ok(await play.evaluate(node => node === node.getRootNode().activeElement),
    'Keyboard resume must allow autohide while preserving focus for further keyboard use');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => !document.querySelector('dive-video').isUIHidden);
  await player.locator('.captions-btn').click();
  await page.waitForFunction(() => document.querySelector('dive-video').isUIHidden, null, { timeout: 3500 });
  assert.ok(await player.locator('.captions-btn').evaluate(node => node === node.getRootNode().activeElement),
    'A mouse click after keyboard navigation must release the visibility hold without blurring');
  await page.mouse.move(100, 100);
  await slider.click({ position: { x: 20, y: 10 } });
  await page.waitForFunction(() => document.querySelector('dive-video').isUIHidden, null, { timeout: 3500 });
  assert.ok(await slider.evaluate(node => node === node.getRootNode().activeElement),
    'Pointer-focused scrubber must not prevent the countdown after scrubbing ends');
  await page.route('**/__controls-story.json', route => route.fulfill({ json: {
    ...story, uiMode: 'autohide',
    scenes: [
      { ...story.scenes[0], endTime: 1000 },
      { ...story.scenes[0], id: 'next-scene', startTime: 1000, tool: '/__delayed-controls-tool.html' },
    ],
  } }));
  await page.route('**/__delayed-controls-tool.html', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><p>Delayed tool</p><script>setTimeout(()=>parent.postMessage({type:"DIVE_READY"},"*"),3500)</script>',
  }));
  await page.goto(`${server.resolvedUrls.local[0]}__controls-test`);
  await page.waitForFunction(() => document.querySelector('dive-video')?.activeToolId === 'controls'
    && document.querySelector('dive-video')?.sceneReady);
  await play.click();
  await page.mouse.move(100, 100);
  await page.mouse.move(100, 850);
  await page.waitForFunction(() => document.querySelector('dive-video').isUIHidden);
  await player.evaluate(element => {
    element.chromeVisibilityChanges = [];
    element.chromeVisibilityObserver = new MutationObserver(() => {
      element.chromeVisibilityChanges.push(element.isUIHidden);
    });
    element.chromeVisibilityObserver.observe(element.shadowRoot.querySelector('.controls'), {
      attributes: true, attributeFilter: ['class'],
    });
  });
  await page.waitForFunction(() => {
    const element = document.querySelector('dive-video');
    return element.activeToolId === 'next-scene' && !element.sceneReady;
  });
  assert.equal(await player.evaluate(element => element.isUIHidden), true,
    'Automatic scene transitions must not reveal hidden controls while loading');
  await page.waitForFunction(() => document.querySelector('dive-video').sceneReady);
  assert.equal(await player.evaluate(element => element.isUIHidden), true,
    'DIVE_READY must not reveal hidden controls');
  assert.ok(await player.evaluate(element => element.chromeVisibilityChanges.every(Boolean)),
    'Controls must never flash visible during an automatic transition');
  await player.evaluate(element => {
    element.chromeVisibilityObserver.disconnect();
    element.togglePlay();
    element.sequencer.seek(0);
  });
  await page.waitForFunction(() => document.querySelector('dive-video').sceneReady);
  assert.equal(await player.evaluate(element => element.isUIHidden), false,
    'Explicit pause must still reveal controls');
  await player.evaluate(element => element.sequencer.seek(2000));
  await page.waitForFunction(() => document.querySelector('dive-video').sceneReady);
  assert.equal(await player.evaluate(element => element.isUIHidden), false,
    'A scene transition must also preserve visible controls');
  assert.deepEqual([...errors], [], 'Control interactions must not throw browser errors');
  console.log('Player controls: styles, languages, scene labels, mouse-centred tooltips, aligned markers, stable single-line captions, seeking and sizing passed.');
} finally {
  await browser?.close();
  await server.close();
}
