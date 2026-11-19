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
  languages: [{ code: 'en', label: 'English' }, { code: 'cy', label: 'Cymraeg' }],
  captions: [{ srclang: 'en', cues: [{ startTime: 0, endTime: 60000, text: 'Control test captions' }] }],
  timelineSections: [
    { startTime: 0, endTime: 30000, label: { en: 'First chapter', cy: 'Pennod gyntaf' } },
    { startTime: 30000, endTime: 60000, label: { en: 'Second chapter', cy: 'Ail bennod' } },
  ],
  scenes: [{
    id: 'controls', tool: '/__controls-tool.html', startTime: 0, endTime: 60000,
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
  assert.equal(await captions.getAttribute('aria-pressed'), 'false', 'Captions start disabled');
  assert.equal(await captions.locator('rect').getAttribute('fill'), 'none', 'Disabled CC uses the outline icon');
  await captions.click();
  assert.equal(await captions.getAttribute('aria-pressed'), 'true');
  assert.equal(await captions.locator('rect').count(), 0, 'Enabled CC uses the filled icon');
  await captions.press('Enter');
  assert.equal(await captions.getAttribute('aria-pressed'), 'false', 'Keyboard toggling turns captions off');
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
          playerText: { [locale]: { captions: 'LongLocalizedCaptionSetting'.repeat(8) } },
        }), locale);
        await page.locator('dive-video [aria-controls="settings-drawer"]').click();
        const settings = page.locator('dive-video #settings-drawer');
        assert.ok(await settings.evaluate(element => {
          const label = element.querySelector('label');
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
        });
        const sizes = await player.evaluate(element => {
          const root = element.shadowRoot;
          const video = root.querySelector('.video-ratio-wrapper').getBoundingClientRect();
          const chrome = element.getAttribute('active-ui-mode') === 'inset'
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
  assert.deepEqual([...errors], [], 'Control interactions must not throw browser errors');
  console.log('Player controls: styles, languages, seeking, automatic aspect sizing, viewport caps and CSS overrides passed.');
} finally {
  await browser?.close();
  await server.close();
}
