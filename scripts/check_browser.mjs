// Optional visual/interaction QA through Chrome's built-in DevTools protocol.
// Requires Chrome + Node 22+. No npm install; launches a separate headless profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(site, '_local'); mkdirSync(dir, {recursive: true});
const profile = mkdtempSync(join(dir, 'chrome-'));
const chrome = spawn(process.env.CHROME || '/usr/bin/google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], {stdio: 'ignore'});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = new Map(); let socket, nextId = 1;
const errors = [];
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 20000);
    pending.set(id, {resolve: (value) => {clearTimeout(timer); resolve(value);}, reject: (err) => {clearTimeout(timer); reject(err);}});
    socket.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function shot(name, full = false) {
  const args = {format: 'png', captureBeyondViewport: full};
  if (full) {
    const {cssContentSize: size} = await call('Page.getLayoutMetrics');
    args.clip = {x: 0, y: 0, width: size.width, height: size.height, scale: 1};
  }
  const {data} = await call('Page.captureScreenshot', args);
  writeFileSync(join(dir, name), Buffer.from(data, 'base64'));
}

async function checkDirectDragging() {
  const count = await evaluate('document.querySelectorAll(".image-comparison").length');
  for (let index = 0; index < count; index++) {
    const box = await evaluate(`(() => {
      const box = document.querySelectorAll('.image-comparison')[${index}];
      box.scrollIntoView({block: 'center', behavior: 'instant'});
      const input = box.querySelector('input');
      input.value = 50; input.dispatchEvent(new Event('input', {bubbles: true}));
      const r = box.getBoundingClientRect();
      return {x: r.left, y: r.top + r.height / 2, width: r.width};
    })()`);
    const state = () => evaluate(`(() => {
      const box = document.querySelectorAll('.image-comparison')[${index}];
      return {value: Number(box.querySelector('input').value), dragging: box.classList.contains('is-dragging')};
    })()`);
    await call('Input.dispatchMouseEvent', {type: 'mousePressed', x: box.x + box.width / 2 + 8, y: box.y, button: 'left', buttons: 1, clickCount: 1});
    assert.deepEqual(await state(), {value: 50, dragging: true}, 'Divider jumped on grab');
    for (const [fraction, expected] of [[.7, 70], [-.1, 0], [1.1, 100], [.25, 25]]) {
      await call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: box.x + box.width * fraction + 8, y: box.y, button: 'left', buttons: 1});
      // Chrome may coalesce protocol-injected pointer moves until the next frame.
      await evaluate('new Promise(resolve => requestAnimationFrame(() => resolve(true)))');
      assert.equal((await state()).value, expected, `Comparison ${index}: drag lost pointer capture or stopped following at ${fraction}`);
    }
    await call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: box.x + box.width * .25 + 8, y: box.y, button: 'left', clickCount: 1});
    assert.deepEqual(await state(), {value: 25, dragging: false}, 'Drag did not finish');
    await call('Input.dispatchKeyEvent', {type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39});
    await call('Input.dispatchKeyEvent', {type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39});
    assert.equal((await state()).value, 25.1, 'Keyboard slider navigation failed');
  }
  await evaluate(`document.querySelectorAll('.image-comparison input').forEach(input => {
    input.value = 50; input.dispatchEvent(new Event('input', {bubbles: true})); input.blur();
  })`);
}

async function checkTouchDragging(index = 0) {
  await call('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 1});
  const box = await evaluate(`(() => {
    const box = document.querySelectorAll('.image-comparison')[${index}];
    box.scrollIntoView({block: 'center', behavior: 'instant'});
    const input = box.querySelector('input');
    input.value = 50; input.dispatchEvent(new Event('input', {bubbles: true}));
    const r = box.getBoundingClientRect();
    return {x: r.left, y: r.top + r.height / 2, width: r.width};
  })()`);
  await call('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: box.x + box.width * .5, y: box.y}]});
  await call('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: box.x + box.width * .75, y: box.y}]});
  await call('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  const value = await evaluate(`Number(document.querySelectorAll('.image-comparison')[${index}].querySelector('input').value)`);
  assert(Math.abs(value - 75) < .3, `Touch drag failed: ${value}`);
  assert(await evaluate(`!document.querySelectorAll('.image-comparison')[${index}].classList.contains('is-dragging')`));
  await call('Emulation.setTouchEmulationEnabled', {enabled: false});
}

// Transparent PNGs must not reveal the other scene through the foreground.
// Compare the rendered slider with a reference where the underlying scene is
// explicitly clipped out of the foreground half. Test pixels, not just --split.
async function checkComparisonCompositing() {
  const count = await evaluate('document.querySelectorAll(".image-comparison").length');
  for (let index = 0; index < count; index++) {
    for (const value of [100, 0, 25, 50, 75]) {
      await evaluate(`(() => {
        const box = document.querySelectorAll('.image-comparison')[${index}];
        const slider = box.querySelector('input');
        slider.value = ${value}; slider.dispatchEvent(new Event('input', {bubbles: true}));
      })()`);
      const clip = await evaluate(`(() => {
        const r = document.querySelectorAll('.image-comparison')[${index}].getBoundingClientRect();
        return {x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height, scale: 1};
      })()`);
      const actual = await call('Page.captureScreenshot', {format: 'png', clip, captureBeyondViewport: true});
      await evaluate(`document.querySelectorAll('.image-comparison')[${index}].querySelector(':scope > img').style.clipPath = 'inset(0 0 0 var(--split))'`);
      const separated = await call('Page.captureScreenshot', {format: 'png', clip, captureBeyondViewport: true});
      await evaluate(`document.querySelectorAll('.image-comparison')[${index}].querySelector(':scope > img').style.removeProperty('clip-path')`);
      if (actual.data !== separated.data) {
        writeFileSync(join(dir, `comparison-${index}-${value}-actual.png`), Buffer.from(actual.data, 'base64'));
        writeFileSync(join(dir, `comparison-${index}-${value}-separated.png`), Buffer.from(separated.data, 'base64'));
        throw new Error(`Comparison ${index}, slider ${value}%: underlying image bleeds through transparent foreground`);
      }
      if (value === 0 || value === 100) writeFileSync(join(dir, `comparison-${index}-${value}-verified.png`), Buffer.from(actual.data, 'base64'));
    }
  }
  await evaluate(`document.querySelectorAll('.image-comparison input').forEach(slider => {
    slider.value = 50; slider.dispatchEvent(new Event('input', {bubbles: true}));
  })`);
}

try {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  assert(existsSync(portFile), 'Headless Chrome did not start');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: 'PUT'})).json();
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({data}) => {
    const result = JSON.parse(data);
    if (result.id && pending.has(result.id)) {
      const task = pending.get(result.id); pending.delete(result.id);
      result.error ? task.reject(new Error(JSON.stringify(result.error))) : task.resolve(result.result);
    }
    if (result.method === 'Runtime.exceptionThrown') errors.push(result.params.exceptionDetails);
    if (result.method === 'Network.responseReceived' && result.params.response.status >= 400) errors.push(result.params.response);
  };
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false});
  await call('Page.navigate', {url: process.env.SITE_URL || 'http://127.0.0.1:8767/anonymous-preview/'});
  await sleep(2500);
  assert(await evaluate('document.readyState === "complete"'), 'Document not ready');
  assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Desktop overflow');
  assert(await evaluate('document.querySelectorAll(".institution-logos, .publication-affiliations, .publication-authors a").length === 0'), 'Identifying header content remains');
  assert.equal(await evaluate('document.querySelector(".publication-authors").textContent.trim()'), 'Anonymous Authors');
  assert.equal(await evaluate('document.querySelector(".submission-note").textContent.trim()'), 'ICRA Submission');
  assert(await evaluate('document.querySelector(".paper-pending")?.disabled && document.querySelector(".paper-pending").textContent.includes("coming soon")'), 'Paper placeholder missing');
  assert.equal(await evaluate('document.querySelectorAll(".task-comparison").length'), 11);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".taco-contact-grid .task-comparison")].map(card => card.dataset.task)'),
    ['taco-pour', 'taco-ladle', 'taco-pick', 'taco-lint', 'taco-brush']);
  assert.equal(await evaluate('document.querySelectorAll(".featured-comparison").length'), 2);
  await shot('desktop.png');
  await evaluate('document.querySelector("#contacts").scrollIntoView()'); await sleep(500);
  await evaluate('for (const img of document.querySelectorAll(".image-comparison img")) img.loading = "eager"');
  await sleep(700);
  const sliderValue = await evaluate(`(() => {
    const slider = document.querySelector('.image-comparison input');
    slider.value = 25; slider.dispatchEvent(new Event('input', {bubbles: true}));
    return slider.closest('.image-comparison').style.getPropertyValue('--split');
  })()`);
  assert.equal(sliderValue, '25%');
  await checkDirectDragging();
  await checkComparisonCompositing();
  await evaluate('document.querySelector("#contacts").scrollIntoView({behavior: "instant"})');
  await shot('comparison.png');
  await evaluate('document.querySelector("#contacts .comparison-grid + .comparison-grid").scrollIntoView({behavior: "instant"})');
  await shot('task-comparisons.png');
  await evaluate('document.querySelector("#taco-contacts").scrollIntoView({behavior: "instant"})');
  const tacoClip = await evaluate(`(() => {
    const grid = document.querySelector('.taco-contact-grid').getBoundingClientRect();
    return {x: grid.left + scrollX, y: grid.top + scrollY, width: grid.width, height: grid.height, scale: 1};
  })()`);
  const tacoShot = await call('Page.captureScreenshot', {format: 'png', clip: tacoClip, captureBeyondViewport: true});
  writeFileSync(join(dir, 'taco-comparisons.png'), Buffer.from(tacoShot.data, 'base64'));
  await evaluate('document.querySelector("#results").scrollIntoView()'); await sleep(1800);
  assert(await evaluate('[...document.querySelectorAll("#results video")].some(v => v.readyState >= 2)'), 'Gallery video not loaded');
  const playing = await evaluate(`(() => {
    const v = [...document.querySelectorAll('#results video')].find(v => !v.paused && v.readyState >= 2);
    return v ? {src: v.currentSrc, time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames} : null;
  })()`);
  assert(playing, 'Gallery videos did not start');
  await sleep(400);
  assert(await evaluate(`(() => {
    const v = [...document.querySelectorAll('#results video')].find(v => v.currentSrc === ${JSON.stringify(playing.src)});
    return v && v.getVideoPlaybackQuality().totalVideoFrames > ${playing.frames};
  })()`), 'Gallery playback is frozen');
  await shot('results.png');
  const videoMetadata = await evaluate(`Promise.all([...document.querySelectorAll('video')].map(v => new Promise((resolve, reject) => {
    const done = () => resolve({src: v.currentSrc.split('/').pop(), width: v.videoWidth, height: v.videoHeight});
    if (v.readyState >= 1) return done();
    v.addEventListener('loadedmetadata', done, {once: true});
    v.addEventListener('error', () => reject(new Error('Cannot decode video')), {once: true});
    v.preload = 'metadata'; v.load();
  })))`);
  assert.equal(videoMetadata.length, 17);
  for (const v of videoMetadata.filter(v => !v.src.startsWith('real-'))) {
    assert.equal(v.width, 1920, v.src); assert.equal(v.height, 1080, v.src);
  }
  const copyButton = await evaluate(`(() => {
    const button = document.querySelector('#copy-bibtex');
    button.scrollIntoView({block: 'center', behavior: 'instant'});
    const r = button.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`);
  await call('Input.dispatchMouseEvent', {type: 'mouseMoved', ...copyButton});
  await call('Input.dispatchMouseEvent', {type: 'mousePressed', ...copyButton, button: 'left', buttons: 1, clickCount: 1});
  await call('Input.dispatchMouseEvent', {type: 'mouseReleased', ...copyButton, button: 'left', buttons: 0, clickCount: 1});
  await sleep(300);
  assert(await evaluate('document.querySelector("#copy-status").textContent.length > 0'), 'Copy button feedback missing');
  // Honor keyboard and OS motion preferences without removing native controls.
  await call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await sleep(300);
  assert(await evaluate('[...document.querySelectorAll(".auto-video")].every(v => v.paused)'), 'Reduced motion ignored');
  await call('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  await evaluate('window.scrollTo({top: 0, behavior: "instant"})'); await sleep(500);
  assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile overflow');
  await shot('mobile.png');
  await checkTouchDragging();
  await shot('mobile-comparison.png');
  for (const index of [9, 10]) await checkTouchDragging(index);
  await evaluate('document.querySelector("[data-task=taco-lint]").scrollIntoView({behavior: "instant"})');
  await shot('mobile-taco-comparisons.png');
  await evaluate('for (const img of document.images) img.loading = "eager"'); await sleep(500);
  const missing = await evaluate('[...document.images].filter(i => !i.complete || !i.naturalWidth).map(i=>i.src)');
  assert.deepEqual(missing, [], 'Broken images');
  assert.deepEqual(errors, [], 'Browser errors');
  const result = {passed: true, checked_at: new Date().toISOString(), desktop_width: 1440, mobile_width: 390, project_subpath: true,
    anonymous_header: true, affiliation_logos: false, comparison_slider: true, comparison_transparency: true,
    paper_coming_soon: true, task_comparisons: 11, taco_comparisons: 5, featured_contact_details: 2, direct_pointer_drag: true, keyboard_slider: true,
    touch_slider: true, native_video_metadata: videoMetadata,
    copy_feedback: true, gallery_playback: true, reduced_motion: true, browser_errors: errors,
    screenshots: ['desktop.png', 'comparison.png', 'task-comparisons.png', 'taco-comparisons.png', 'results.png', 'mobile.png', 'mobile-comparison.png', 'mobile-taco-comparisons.png']};
  writeFileSync(join(dir, 'browser_validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  socket?.close(); chrome.kill('SIGTERM');
}
