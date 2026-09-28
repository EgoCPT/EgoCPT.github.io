/* Small, dependency-free interactions; no analytics or third-party scripts. */
"use strict";

document.querySelectorAll(".image-comparison input").forEach((slider) => {
  const comparison = slider.closest(".image-comparison");
  const beforeLabel = comparison.querySelector(".label-before").textContent.trim();
  const afterLabel = comparison.querySelector(".label-after").textContent.trim();
  slider.addEventListener("input", () => {
    comparison.style.setProperty("--split", `${slider.value}%`);
    slider.setAttribute("aria-valuetext", `${Math.round(slider.value)} percent ${beforeLabel}, ${Math.round(100 - Number(slider.value))} percent ${afterLabel}`);
  });
  // Direct manipulation: no easing or delayed animation between finger and divider.
  let pointer = null, grabOffset = 0;
  const track = (event) => {
    const rect = comparison.getBoundingClientRect();
    slider.value = Math.max(0, Math.min(100, (event.clientX - rect.left - grabOffset) / rect.width * 100));
    slider.dispatchEvent(new Event("input", {bubbles: true}));
  };
  // The wrapper owns pointer gestures; the native range retains keyboard and
  // assistive-technology control while sharing the same value and focus state.
  comparison.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    slider.focus({preventScroll: true});
    const rect = comparison.getBoundingClientRect();
    const offset = event.clientX - (rect.left + rect.width * Number(slider.value) / 100);
    grabOffset = Math.abs(offset) <= 24 ? offset : 0;
    pointer = event.pointerId;
    comparison.setPointerCapture(pointer);
    comparison.classList.add("is-dragging");
    track(event);
  });
  comparison.addEventListener("pointermove", (event) => {
    if (event.pointerId === pointer) track(event);
  });
  const finish = (event) => {
    if (event.pointerId !== pointer) return;
    pointer = null;
    comparison.classList.remove("is-dragging");
    if (comparison.hasPointerCapture(event.pointerId)) comparison.releasePointerCapture(event.pointerId);
  };
  comparison.addEventListener("pointerup", finish);
  comparison.addEventListener("pointercancel", finish);
  comparison.addEventListener("lostpointercapture", finish);
});

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const videos = [...document.querySelectorAll(".auto-video")];
const visible = new Set();
const userPaused = new WeakSet();
const programPaused = new WeakSet();

function loadVideo(video) {
  const source = video.querySelector("source[data-src]");
  if (source) {
    source.src = source.dataset.src;
    source.removeAttribute("data-src");
    video.load();
  }
}

function pauseVideo(video) {
  if (!video.paused) {
    programPaused.add(video);
    video.pause();
  }
}

function updateVideo(video) {
  if (visible.has(video) && !document.hidden) {
    loadVideo(video);
    if (!reducedMotion.matches && !userPaused.has(video)) {
      video.play().catch(() => { /* Native controls remain available. */ });
    }
  } else {
    pauseVideo(video);
  }
}

videos.forEach((video) => {
  // Let the observer manage playback, including reduced-motion preferences.
  video.autoplay = false;
  if (reducedMotion.matches) pauseVideo(video);
  video.addEventListener("pause", () => {
    if (programPaused.has(video)) programPaused.delete(video);
    else if (!video.ended) userPaused.add(video);
  });
  video.addEventListener("play", () => userPaused.delete(video));
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(({target, isIntersecting}) => {
      if (isIntersecting) visible.add(target);
      else visible.delete(target);
      updateVideo(target);
    });
  }, { threshold: 0.15 });
  videos.forEach((video) => observer.observe(video));
} else {
  videos.forEach((video) => { loadVideo(video); video.controls = true; });
}

document.addEventListener("visibilitychange", () => videos.forEach(updateVideo));
reducedMotion.addEventListener("change", () => {
  videos.forEach((video) => {
    if (reducedMotion.matches) pauseVideo(video);
    else updateVideo(video);
  });
});

document.getElementById("copy-bibtex").addEventListener("click", async () => {
  const code = document.getElementById("bibtex-code");
  const status = document.getElementById("copy-status");
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(code.textContent);
    status.textContent = "Citation copied.";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = "Citation selected. Press Ctrl+C or ⌘C to copy.";
  }
});
