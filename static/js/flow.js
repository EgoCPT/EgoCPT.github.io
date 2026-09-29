/* One shared clock, four actual videos. Switching views preserves that clock. */
(() => {
  "use strict";
  const root = document.querySelector(".motion-flow");
  if (!root) return;
  const screen = root.querySelector(".flow-screen");
  const panels = [...root.querySelectorAll(".flow-view")];
  const clips = [...root.querySelectorAll(".flow-video")];
  const tabs = [...root.querySelectorAll(".flow-tab")];
  const tablist = root.querySelector(".flow-tabs");
  const indicator = root.querySelector(".flow-selection");
  const scrub = root.querySelector(".flow-scrub");
  const toggle = root.querySelector(".flow-toggle");
  const replay = root.querySelector(".flow-replay");
  const error = root.querySelector(".flow-error");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const fps = 30, lastFrame = 189, endTime = lastFrame / fps;
  const metadata = new WeakMap();
  let selected = 0, displayed = 0, cursor = 0;
  let visible = false, wantsPlay = false, touring = true, complete = false;
  let started = motion.matches, loading = false, generation = 0, seekController;
  let raf = 0, previousTick = 0, seekRaf = 0;
  // Independent, critically damped X/Y springs retain velocity on interruption.
  const spring = {x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, moving: false};

  clips.forEach(clip => { clip.controls = false; clip.muted = true; clip.loop = false; });
  const clampTime = value => Math.max(0, Math.min(endTime, Number(value) || 0));
  const currentTime = () => loading ? cursor : clampTime(clips[displayed].currentTime);

  function waitFor(clip, predicate, events, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        events.forEach(name => clip.removeEventListener(name, check));
        clip.removeEventListener("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const check = () => { if (predicate()) { clean(); resolve(); } };
      const failed = () => { clean(); reject(new Error("Video unavailable")); };
      const aborted = () => { clean(); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(failed, 12000);
      events.forEach(name => clip.addEventListener(name, check));
      clip.addEventListener("error", failed, {once: true});
      signal?.addEventListener("abort", aborted, {once: true});
    });
  }

  function loadMetadata(clip) {
    if (clip.readyState >= 1) return Promise.resolve();
    if (metadata.has(clip)) return metadata.get(clip);
    const pending = waitFor(clip, () => clip.readyState >= 1, ["loadedmetadata"])
      .catch(reason => { metadata.delete(clip); throw reason; });
    metadata.set(clip, pending);
    clip.preload = "auto";
    clip.load();
    return pending;
  }

  async function prepareFrame(clip, time, signal) {
    await loadMetadata(clip);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const ready = () => clip.readyState >= 2 && !clip.seeking && Math.abs(clip.currentTime - time) < 0.045;
    if (ready()) return;
    const frame = waitFor(clip, ready, ["seeked", "loadeddata", "canplay"], signal);
    clip.currentTime = time;
    await frame;
  }

  function paintTime(time) {
    const bounded = clampTime(time), progress = bounded / endTime;
    scrub.value = Math.round(bounded * fps);
    scrub.style.setProperty("--played", `${progress * 100}%`);
    scrub.setAttribute("aria-valuetext", `${bounded.toFixed(1)} of 6.3 seconds`);
    root.querySelector(".flow-current-time").textContent = bounded.toFixed(1);
    tabs.forEach((tab, index) => {
      const amount = index === selected ? progress : touring && index < selected ? 1 : 0;
      tab.querySelector(".flow-tab-progress i").style.transform = `scaleX(${amount})`;
    });
  }

  function paintControls() {
    root.classList.toggle("is-playing", wantsPlay);
    toggle.setAttribute("aria-label", wantsPlay ? "Pause flow" : complete ? "Replay flow" : "Play flow");
    root.dataset.state = loading ? "loading" : complete ? "complete" :
      wantsPlay && (!visible || document.hidden) ? "suspended" :
      wantsPlay && !clips[displayed].paused ? "playing" : "paused";
    root.dataset.mode = touring ? "tour" : "compare";
  }

  function queueTick() { if (!raf) raf = requestAnimationFrame(tick); }
  function tick(now) {
    raf = 0;
    const dt = Math.min(0.032, Math.max(0.001, (now - (previousTick || now - 16)) / 1000));
    previousTick = now;
    if (spring.moving) {
      const omega = 2 * Math.PI / 0.36;
      for (const axis of ["x", "y"]) {
        const velocity = "v" + axis, target = "t" + axis;
        // Closed-form critical spring: stable across slow or dropped frames.
        const offset = spring[axis] - spring[target];
        const term = spring[velocity] + omega * offset;
        const decay = Math.exp(-omega * dt);
        spring[axis] = spring[target] + (offset + term * dt) * decay;
        spring[velocity] = (spring[velocity] - omega * term * dt) * decay;
      }
      spring.moving = Math.abs(spring.x - spring.tx) + Math.abs(spring.y - spring.ty) > .08 ||
        Math.abs(spring.vx) + Math.abs(spring.vy) > .12;
      if (!spring.moving) { spring.x = spring.tx; spring.y = spring.ty; spring.vx = spring.vy = 0; }
      indicator.style.transform = `translate3d(${spring.x}px, ${spring.y}px, 0)`;
    }
    const playing = visible && !document.hidden && !loading && !clips[displayed].paused;
    if (playing) { cursor = currentTime(); paintTime(cursor); }
    if (spring.moving || playing) queueTick();
    else previousTick = 0;
  }

  function positionIndicator(immediate = false) {
    const box = tabs[selected].getBoundingClientRect(), parent = tablist.getBoundingClientRect();
    indicator.style.width = `${box.width}px`;
    indicator.style.height = `${box.height}px`;
    spring.tx = box.left - parent.left;
    spring.ty = box.top - parent.top;
    if (immediate || motion.matches) {
      spring.x = spring.tx; spring.y = spring.ty; spring.vx = spring.vy = 0; spring.moving = false;
      indicator.style.transform = `translate3d(${spring.x}px, ${spring.y}px, 0)`;
    } else { spring.moving = true; queueTick(); }
  }

  function paintSelection(manual) {
    root.dataset.stage = selected;
    tabs.forEach((tab, index) => {
      tab.setAttribute("aria-selected", String(index === selected));
      tab.tabIndex = index === selected ? 0 : -1;
    });
    root.querySelector(".flow-stage-number").textContent = String(selected + 1).padStart(2, "0");
    root.querySelector(".flow-stage-label").textContent = tabs[selected].dataset.label;
    if (manual) root.querySelector(".flow-announcement").textContent =
      `${tabs[selected].dataset.label}, ${cursor.toFixed(1)} seconds.`;
    positionIndicator();
    paintTime(cursor);
  }

  function pauseClips() { clips.forEach(clip => clip.pause()); }

  async function resume() {
    if (!wantsPlay || !visible || document.hidden || loading) { paintControls(); return; }
    const index = displayed, ticket = generation;
    try {
      await clips[index].play();
      if (ticket !== generation || !wantsPlay || !visible || document.hidden) clips[index].pause();
      else queueTick();
    } catch (reason) {
      if (ticket === generation && reason.name !== "AbortError") wantsPlay = false;
    }
    paintControls();
  }

  async function show(index, time, manual = false) {
    const ticket = ++generation;
    seekController?.abort();
    seekController = new AbortController();
    selected = index; cursor = clampTime(time); loading = true; complete = false;
    if (manual) { touring = false; started = true; }
    pauseClips();
    error.hidden = true;
    screen.setAttribute("aria-busy", "true");
    paintSelection(manual); paintControls();
    try {
      await prepareFrame(clips[index], cursor, seekController.signal);
      if (ticket !== generation) return;
      displayed = index; loading = false;
      panels.forEach((panel, number) => {
        panel.classList.toggle("is-active", number === index);
        panel.setAttribute("aria-hidden", String(number !== index));
        panel.inert = number !== index;
      });
      screen.setAttribute("aria-busy", "false");
      paintTime(cursor); paintControls();
      await resume();
      // Warm only the next stage, after the current frame is visible.
      if (visible && touring && index < clips.length - 1) loadMetadata(clips[index + 1]).catch(() => {});
    } catch (reason) {
      if (ticket !== generation || reason.name === "AbortError") return;
      loading = false; wantsPlay = false;
      screen.setAttribute("aria-busy", "false");
      error.hidden = false; paintControls();
    }
  }

  function replayFlow() {
    touring = true; started = true; wantsPlay = true; complete = false;
    show(0, 0);
  }

  tabs.forEach((tab, index) => tab.addEventListener("click", () => {
    const time = currentTime();
    show(index, time, true);
  }));
  tablist.addEventListener("keydown", event => {
    const next = {ArrowLeft: Math.max(0, selected - 1), ArrowRight: Math.min(3, selected + 1), Home: 0, End: 3}[event.key];
    if (next === undefined) return;
    event.preventDefault(); tabs[next].focus(); show(next, currentTime(), true);
  });
  toggle.addEventListener("click", () => {
    started = true;
    if (complete) { replayFlow(); return; }
    wantsPlay = !wantsPlay;
    if (!wantsPlay) { cursor = currentTime(); pauseClips(); paintControls(); }
    else if (loading) paintControls();
    else show(selected, currentTime() >= endTime - .015 ? 0 : currentTime());
  });
  replay.addEventListener("click", replayFlow);
  root.querySelector(".flow-retry").addEventListener("click", () => {
    metadata.delete(clips[selected]); clips[selected].load(); show(selected, cursor);
  });
  scrub.addEventListener("input", () => {
    cursor = Number(scrub.value) / fps;
    wantsPlay = false; touring = false; started = true; complete = false;
    pauseClips(); paintTime(cursor); paintControls();
    if (!seekRaf) seekRaf = requestAnimationFrame(() => {
      seekRaf = 0; show(selected, cursor, true);
    });
  });

  clips.forEach((clip, index) => {
    clip.addEventListener("play", () => { if (index === displayed) { paintControls(); queueTick(); } });
    clip.addEventListener("pause", () => { if (index === displayed) paintControls(); });
    clip.addEventListener("ended", () => {
      if (index !== selected || loading || !wantsPlay) return;
      if (touring && index < clips.length - 1) show(index + 1, 0);
      else { wantsPlay = false; complete = touring; cursor = endTime; paintTime(cursor); paintControls(); }
    });
  });

  function visibilityChanged() {
    if (!visible || document.hidden) { pauseClips(); paintControls(); }
    else if (!started && !motion.matches) { started = true; wantsPlay = true; show(selected, cursor); }
    else resume();
  }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting && entries[0].intersectionRatio >= .25;
      visibilityChanged();
    }, {threshold: [0, .25]}).observe(screen);
  } else { visible = true; visibilityChanged(); }
  document.addEventListener("visibilitychange", visibilityChanged);
  motion.addEventListener("change", () => {
    if (motion.matches) {
      started = true; wantsPlay = false; touring = false; pauseClips(); paintControls(); positionIndicator(true);
    }
  });
  new ResizeObserver(() => positionIndicator(true)).observe(tablist);
  positionIndicator(true); paintTime(0); paintControls();
})();
