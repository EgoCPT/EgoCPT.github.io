// Browser-level checks for playback, time-preserving changes, interruption and accessibility.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.env.FLOW_CHECK_DIR || join(site, '_local/flow-checks'));
const url = process.env.SITE_URL || 'http://127.0.0.1:8767/anonymous-preview/#process';
mkdirSync(dir, {recursive: true});
const profile = mkdtempSync(join(dir, 'chrome-'));
const chrome = spawn(process.env.CHROME || '/usr/bin/google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], {stdio: 'ignore'});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [], tourStages = [];
let socket, nextId = 1;
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Timeout: ${method}`));}, 20000);
    pending.set(id, {resolve: value => {clearTimeout(timer); resolve(value);}, reject: error => {clearTimeout(timer); reject(error);}});
    socket.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await sleep(80); }
  throw new Error(`Timed out: ${description}`);
}
async function click(selector) {
  const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  await call('Input.dispatchMouseEvent', {type:'mousePressed', ...point, button:'left',buttons:1,clickCount:1});
  await call('Input.dispatchMouseEvent', {type:'mouseReleased', ...point, button:'left',buttons:0,clickCount:1});
}
async function screenshot(name) {
  const {data} = await call('Page.captureScreenshot', {format:'png'});
  writeFileSync(join(dir,name),Buffer.from(data,'base64'));
}
const settled = `document.querySelector('.motion-flow').dataset.state !== 'loading' && document.querySelector('.flow-error').hidden`;
const frame = `(() => {const v=document.querySelector('.flow-view.is-active video');return {time:v.currentTime,paused:v.paused,stage:Number(document.querySelector('.motion-flow').dataset.stage),frames:v.getVideoPlaybackQuality().totalVideoFrames};})()`;

try {
  const portFile=join(profile,'DevToolsActivePort');
  for(let i=0;i<100&&!existsSync(portFile);i++)await sleep(100);
  assert(existsSync(portFile));
  const port=readFileSync(portFile,'utf8').split('\n')[0];
  const tab=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=({data})=>{
    const message=JSON.parse(data);
    if(message.id&&pending.has(message.id)) {const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(message.error):item.resolve(message.result);}
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);
    if(message.method==='Network.responseReceived'&&message.params.response.status>=400)errors.push({status:message.params.response.status,url:message.params.response.url});
  };
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1160,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url});
  await until(`document.readyState === 'complete'`, 'document');
  await evaluate(`document.querySelector('#process').scrollIntoView({behavior:'instant',block:'start'})`);
  await until(`document.querySelector('.motion-flow').dataset.state==='playing'`, 'autoplay on entering viewport');
  let first=await evaluate(frame);await sleep(450);let next=await evaluate(frame);
  assert(next.time>first.time+.2 && next.frames>first.frames,'Video playback must advance actual frames');
  await screenshot('flow-desktop-playing.png');
  await click('.flow-toggle');
  first=await evaluate(frame);await sleep(200);next=await evaluate(frame);
  assert(next.paused&&Math.abs(next.time-first.time)<.02,'Pause must hold the displayed moment');
  await evaluate(`(() => {const slider=document.querySelector('.flow-scrub');slider.value=95;slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(`${settled} && Math.abs(document.querySelector('.flow-view.is-active video').currentTime-95/30)<.04`, 'scrub to a common frame');
  const switches=[];
  for(const index of [1,2,3,0]) {
    await click(`#flow-tab-${index}`);
    await until(`${settled} && document.querySelector('#flow-panel-${index}').classList.contains('is-active')`, 'switch stage');
    const state=await evaluate(frame);assert(state.paused&&Math.abs(state.time-95/30)<.04,'A paused stage switch changed time');switches.push(state);
    await sleep(280);await screenshot(`flow-stage-${index}.png`);
  }
  await evaluate(`for(const i of [3,1,2,0,3])document.querySelector('#flow-tab-'+i).click()`);
  await until(`${settled} && document.querySelector('#flow-panel-3').classList.contains('is-active')`, 'rapid interrupted switches');
  assert(Math.abs((await evaluate(frame)).time-95/30)<.04);
  await evaluate(`document.querySelector('#flow-tab-3').focus()`);
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  await until(`${settled} && document.querySelector('#flow-panel-2').classList.contains('is-active')`, 'keyboard stage navigation');
  assert.equal(await evaluate('document.activeElement.id'),'flow-tab-2');
  await click('.flow-toggle');
  await until(`document.querySelector('.motion-flow').dataset.state==='playing'`, 'manual resume');
  await evaluate(`document.querySelector('#abstract').scrollIntoView({behavior:'instant'})`);
  await sleep(300);assert(await evaluate(`[...document.querySelectorAll('.flow-video')].every(v=>v.paused)`),'Offscreen videos must pause');
  await evaluate(`document.querySelector('#process').scrollIntoView({behavior:'instant'})`);
  await until(`document.querySelector('.motion-flow').dataset.state==='playing'`, 'resume after returning');
  await click('.flow-replay');
  const deadline=Date.now()+35000;
  while(Date.now()<deadline) {
    const state=await evaluate(`({stage:Number(document.querySelector('.motion-flow').dataset.stage),state:document.querySelector('.motion-flow').dataset.state})`);
    if(tourStages.at(-1)!==state.stage)tourStages.push(state.stage);
    if(state.state==='complete')break;
    await sleep(180);
  }
  assert.deepEqual(tourStages,[0,1,2,3],'The tour must show all four full stages in order');
  assert.equal(await evaluate(`document.querySelector('.motion-flow').dataset.state`),'complete');
  await screenshot('flow-desktop-complete.png');
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await click('#flow-tab-0');await until(settled,'reduced-motion switch');
  assert(await evaluate(`[...document.querySelectorAll('.flow-video')].every(v=>v.paused)`));
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.flow-view')).transitionDuration`),'0s');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  await evaluate(`document.querySelector('#process').scrollIntoView({behavior:'instant'})`);await sleep(300);
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Mobile horizontal overflow');
  const touch=await evaluate(`(()=>{const r=document.querySelector('#flow-tab-3').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});
  await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await until(`${settled} && document.querySelector('#flow-panel-3').classList.contains('is-active')`,'touch stage selection');
  const layout=await evaluate(`(()=>{const s=document.querySelector('.flow-selection').getBoundingClientRect(),t=document.querySelector('#flow-tab-3').getBoundingClientRect();return{dx:Math.abs(s.left-t.left),dy:Math.abs(s.top-t.top),dw:Math.abs(s.width-t.width),dh:Math.abs(s.height-t.height)};})()`);
  assert(Object.values(layout).every(value=>value<1),'The spring indicator must fit the mobile stage button');
  await screenshot('flow-mobile.png');
  assert.deepEqual(errors,[],'Browser errors');
  const result={passed:true,checked_at:new Date().toISOString(),url,desktop_width:1440,mobile_width:390,actual_video_playback:true,paused_same_time_switches:switches,rapid_interruption:true,keyboard:true,touch:true,mobile_indicator:layout,tour_stages:tourStages,offscreen_pause:true,reduced_motion:true,errors};
  writeFileSync(join(dir,'flow_validation.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} finally {socket?.close();chrome.kill('SIGTERM');}
