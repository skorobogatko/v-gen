// page.js

// minimal page renderer

// Assets are expected to be full URLs or absolute paths; no local resolution helper needed.

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      res(img);
    };
    img.onerror = (e) => {
      console.error(`[Image Load Error] src: ${src}`, e);
      rej(e);
    };
    img.src = src;
  });
}

function loadVideo(src, muted = true) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    // set crossOrigin and attributes before assigning src so CORS applies
    v.crossOrigin = "anonymous";
    v.muted = muted;
    v.preload = "auto";
    v.playsInline = true;
    v.src = src;

    let settled = false;
    const onDone = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.onloadeddata = null;
      v.oncanplaythrough = null;
      v.onerror = null;
      try {
        v.pause();
      } catch (e) {}
      if (ok) res(v);
      else rej(new Error(`video failed to load: ${src}`));
    };

    v.onloadeddata = () => onDone(true);
    v.oncanplaythrough = () => onDone(true);
    v.onerror = (e) => {
      console.error(`[Video Load Error] src: ${src}`, e);
      onDone(false);
    };

    // timeout to avoid hanging forever
    const timer = setTimeout(() => onDone(false), 8000);

    // try to play briefly (muted) to force decoder warm-up; many browsers allow muted autoplay
    try {
      const p = v.play();
      if (p && p.then) {
        p.then(() => {
          try {
            v.pause();
          } catch (e) {}
        }).catch(() => {});
      }
    } catch (e) {}
  });
}

// простые easing
const Easings = {
  linear: (t) => t,
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  // ease-out cubic
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
};

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// вычисляем альфу для fade in/out
function fadeAlpha(localT, durMs, fade) {
  if (!fade) return 1;
  const fi = (fade.in || 0) * 1000,
    fo = (fade.out || 0) * 1000;
  if (fi > 0 && localT < fi) return localT / fi;
  if (fo > 0 && localT > durMs - fo) return Math.max(0, (durMs - localT) / fo);
  return 1;
}

// Load and index all resources referenced by the project. Returns
// an object { images, logos, videos } where each is a Map(src -> element).
async function loadResources(project) {
  const res = { images: new Map(), videos: new Map(), logos: new Map() };

  const imgSrcs = new Set();
  const vidSrcs = new Set();
  const logoSrcs = new Set();

  for (const sc of project.videoTrack || []) {
    for (const o of sc.objects || []) {
      if (o.type === "image") imgSrcs.add(o.src);
      if (o.type === "video") vidSrcs.add(o.src);
    }
  }
  for (const ov of project.overlays || []) {
    if (ov.type === "logo" && ov.src) logoSrcs.add(ov.src);
  }

  const imgPromises = Array.from(imgSrcs).map((s) =>
    loadImage(s)
      .then((v) => ({ src: s, value: v }))
      .catch((e) => ({ src: s, error: e }))
  );
  const logoPromises = Array.from(logoSrcs).map((s) =>
    loadImage(s)
      .then((v) => ({ src: s, value: v }))
      .catch((e) => ({ src: s, error: e }))
  );
  const vidPromises = Array.from(vidSrcs).map((s) =>
    loadVideo(s, true)
      .then((v) => ({ src: s, value: v }))
      .catch((e) => ({ src: s, error: e }))
  );

  const settled = await Promise.allSettled([
    Promise.all(imgPromises),
    Promise.all(logoPromises),
    Promise.all(vidPromises),
  ]);

  try {
    if (settled[0] && settled[0].status === "fulfilled") {
      for (const r of settled[0].value) {
        if (r && r.value) res.images.set(r.src, r.value);
        else
          console.warn(
            "[Resource Load Warning] image",
            r?.src,
            "failed:",
            r?.error
          );
      }
    }
    if (settled[1] && settled[1].status === "fulfilled") {
      for (const r of settled[1].value) {
        if (r && r.value) res.logos.set(r.src, r.value);
        else
          console.warn(
            "[Resource Load Warning] logo",
            r?.src,
            "failed:",
            r?.error
          );
      }
    }
    if (settled[2] && settled[2].status === "fulfilled") {
      for (const r of settled[2].value) {
        if (r && r.value) res.videos.set(r.src, r.value);
        else
          console.warn(
            "[Resource Load Warning] video",
            r?.src,
            "failed:",
            r?.error
          );
      }
    }
  } catch (err) {
    console.error(
      "[Resource Load Error] unexpected error processing results",
      err
    );
  }

  return res;
}

// Build a flat list of active objects for a given time (ms). Does not render.
function buildActiveObjects(project, ms) {
  const activeObjects = [];

  for (const sc of project.videoTrack || []) {
    if (ms < sc.start * 1000 || ms >= sc.end * 1000) continue;
    const local = ms - sc.start * 1000;
    const dur = (sc.end - sc.start) * 1000;

    for (const o of sc.objects || []) {
      const base = {
        x: o.x,
        y: o.y,
        w: o.w,
        h: o.h,
        z: o.z || 0,
        a: 1,
        type: o.type,
        id: o.id,
        style: o.style,
        text: o.text,
      };
      let scale = 1,
        tx = 0,
        ty = 0,
        alpha = 1;

      for (const anim of o.animations || []) {
        if (anim.type === "zoom") {
          const t = Easings[anim.easing || "linear"](
            Math.min(1, Math.max(0, local / dur))
          );
          scale = lerp(anim.from || 1, anim.to || 1, t);
        }
        if (anim.type === "move") {
          const t = Easings[anim.easing || "linear"](
            Math.min(1, Math.max(0, local / dur))
          );
          tx = lerp(anim.from?.x || 0, anim.to?.x || 0, t);
          ty = lerp(anim.from?.y || 0, anim.to?.y || 0, t);
        }
        if (anim.type === "fade") {
          alpha *= fadeAlpha(local, dur, anim);
        }
      }

      activeObjects.push({
        ...base,
        src: o.src,
        scale,
        tx,
        ty,
        a: alpha,
      });
    }
  }

  for (const ov of project.overlays || []) {
    if (ms < ov.start * 1000 || ms >= ov.end * 1000) continue;
    activeObjects.push({
      type: "image",
      src: ov.src,
      x: ov.x,
      y: ov.y,
      w: ov.w,
      h: ov.h,
      z: ov.z || 100,
      a: ov.opacity ?? 1,
    });
  }

  activeObjects.sort((a, b) => (a.z || 0) - (b.z || 0));
  return activeObjects;
}

// Internal renderer used by the public renderFrame wrapper. Keeps behaviour unchanged.
function renderFrameInternal(ctx, project, res, ms, width, height, background) {
  // debug list
  const activeListDebug = [];
  const activeObjects = buildActiveObjects(project, ms);

  for (const ao of activeObjects) {
    const hasRes =
      (ao.type === "image" &&
        (res.images.get(ao.src) || res.logos.get(ao.src))) ||
      (ao.type === "video" && res.videos.get(ao.src));
    activeListDebug.push({
      id: ao.id,
      type: ao.type,
      src: ao.src,
      has: !!hasRes,
    });
  }

  // check if there's an active subtitle for this time
  const sub = (project.subtitles || []).find(
    (s) => ms / 1000 >= s.start && ms / 1000 < s.end
  );

  const anyHas = activeListDebug.some((a) => a.has);
  // if there are no visual resources AND no subtitle to draw, bail out early
  if (!anyHas && !sub) {
    // No visual resources and no subtitle. To avoid producing an unexpected
    // black frame during transitions (for example while a video seeks to the
    // target time), preserve the previously rendered canvas contents when
    // possible. Only clear to the background color if nothing has ever been
    // rendered yet.
    if (!window.__lastRendered) {
      ctx.fillStyle = background || "#000";
      ctx.fillRect(0, 0, width, height);
    }
    return;
  }

  // We are about to draw a new frame: clear the canvas to the background to
  // avoid visual artifacts from previous frames, then draw. Mark that we've
  // rendered at least one frame so future empty frames can preserve this
  // content instead of showing a black background.
  ctx.fillStyle = background || "#000";
  ctx.fillRect(0, 0, width, height);
  window.__lastRendered = true;

  // determine news overlay and its desired z (default 100)
  const newsOverlay = (project.overlays || []).find(
    (o) => typeof o.newsTitle === "string"
  );
  const newsZ = newsOverlay
    ? typeof newsOverlay.z === "number"
      ? newsOverlay.z
      : 100
    : null;

  // draw active objects and inject news title when reaching objects with higher z
  let newsDrawn = false;
  for (const o of activeObjects) {
    // if news not drawn yet and current object's z exceeds newsZ, draw news now
    if (newsOverlay && !newsDrawn && (o.z || 0) > (newsZ ?? 0)) {
      try {
        drawNewsTitle(ctx, project, ms, width, height);
      } catch (e) {
        console.warn("drawNewsTitle failed", e);
      }
      newsDrawn = true;
    }

    ctx.save();
    ctx.globalAlpha = o.a ?? 1;
    if (o.type === "image") {
      const img = res.images.get(o.src) || res.logos.get(o.src);
      if (img) {
        const cx = o.x + o.w / 2,
          cy = o.y + o.h / 2;
        ctx.translate(cx + (o.tx || 0), cy + (o.ty || 0));
        ctx.scale(o.scale || 1, o.scale || 1);
        try {
          ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
        } catch (e) {
          console.error("[Draw Error] image", o.src, e);
        }
      }
    } else if (o.type === "video") {
      const v = res.videos.get(o.src);
      if (v) {
        const scene = project.videoTrack.find(
          (sc) => ms >= sc.start * 1000 && ms < sc.end * 1000
        );
        const localMs = ms - ((scene && scene.start * 1000) || 0);
        const target = Math.max(0, localMs / 1000);
        if (Math.abs((v.currentTime || 0) - target) > 0.033) {
          try {
            v.currentTime = target;
          } catch (e) {}
        }
        const cx = o.x + o.w / 2,
          cy = o.y + o.h / 2;
        ctx.translate(cx + (o.tx || 0), cy + (o.ty || 0));
        ctx.scale(o.scale || 1, o.scale || 1);
        try {
          ctx.drawImage(v, -o.w / 2, -o.h / 2, o.w, o.h);
        } catch (e) {
          console.error("[Draw Error] video", o.src, e);
        }
      }
    } else if (o.type === "text") {
      const text = o.text || "";
      const style = o.style || {};
      const font = style.font || "600 42px Inter";
      const color = style.color || "#fff";
      const pad = style.pad || 10;
      const radius = style.radius || 12;
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.textAlign = o.anchor?.startsWith("center") ? "center" : "left";
      const metrics = ctx.measureText(text);
      const tw = metrics.width;
      const th = parseInt(font.match(/(\d+)px/)?.[1] || "42", 10) + pad * 1.5;
      if (style.bg) {
        const x = o.anchor?.startsWith("center") ? o.x - (tw / 2 + pad) : o.x;
        const y = o.anchor?.endsWith("bottom") ? o.y - th : o.y;
        roundRect(ctx, x, y, tw + pad * 2, th, radius);
        ctx.fillStyle = style.bg;
        ctx.fill();
      }
      if (style.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
      }
      ctx.fillStyle = color;
      const ty = o.anchor?.endsWith("bottom") ? o.y - th / 2 : o.y;
      ctx.fillText(text, o.anchor?.startsWith("center") ? o.x : o.x + pad, ty);
    }
    ctx.restore();
  }

  // if news overlay hasn't been drawn yet (e.g. its z is >= all objects), draw it now
  if (newsOverlay && !newsDrawn) {
    try {
      drawNewsTitle(ctx, project, ms, width, height);
    } catch (e) {
      console.warn("drawNewsTitle failed", e);
    }
  }

  // finally draw subtitles on top
  if (sub) drawSubtitle(ctx, width, height, sub.text);
}

// Draw news title overlay with animation timeline described in project requirements.
function drawNewsTitle(ctx, project, ms, W, H) {
  if (!project || !Array.isArray(project.overlays)) return;
  const ov = project.overlays.find((o) => typeof o.newsTitle === "string");
  if (!ov || !ov.newsTitle) return;

  // Animation timing (ms)
  // defaults per spec
  const DEF = {
    grow: 300,
    delay: 100,
    textFade: 200,
    hold: 4000,
    textOut: 200,
    collapse: 300,
  };
  const defaultTotal =
    DEF.grow + DEF.delay + DEF.textFade + DEF.hold + DEF.textOut + DEF.collapse;

  // overlay start/end are in seconds (project.json). Use start as begin of animation,
  // and end as the time when disappearance must finish. If end is missing, use start + defaultTotal.
  const startMs =
    typeof ov.start === "number" ? Math.round(ov.start * 1000) : 1000;
  const endMs =
    typeof ov.end === "number"
      ? Math.round(ov.end * 1000)
      : startMs + defaultTotal;

  // clamp endMs >= startMs + minimal (1ms)
  const available = Math.max(1, endMs - startMs);

  // if available is less than defaultTotal, scale durations proportionally
  const scale = available < defaultTotal ? available / defaultTotal : 1;
  // compute scaled durations and ensure they sum to available (adjust last)
  const growDur = Math.max(1, Math.round(DEF.grow * scale));
  const textDelay = Math.max(0, Math.round(DEF.delay * scale));
  const textDur = Math.max(1, Math.round(DEF.textFade * scale));
  const holdAfterText = Math.max(0, Math.round(DEF.hold * scale));
  const textOutDur = Math.max(1, Math.round(DEF.textOut * scale));
  // collapse will be adjusted to fill remainder
  let collapseDur = Math.max(1, Math.round(DEF.collapse * scale));

  // ensure total sums to available (fix rounding drift)
  const sumSoFar =
    growDur + textDelay + textDur + holdAfterText + textOutDur + collapseDur;
  if (sumSoFar !== available) {
    collapseDur += available - sumSoFar;
    if (collapseDur < 1) collapseDur = 1;
  }

  // relative times (ms) from startMs
  const textStartRel = growDur + textDelay;
  const textVisibleAtRel = textStartRel + textDur;
  const disappearStartRel = textVisibleAtRel + holdAfterText;
  const textOutStartRel = disappearStartRel;
  const barCollapseStartRel = textOutStartRel + textOutDur;
  const totalDurationRel = barCollapseStartRel + collapseDur;

  const local = ms - startMs;
  if (local < 0 || local > totalDurationRel) return;

  // Bar geometry
  const barW = 804;
  const barInitH = 146;
  const barFinalH = 473;
  const radius = 73;
  // bottom of bar is fixed; input specified Y=1404 as top when collapsed
  const initTop = 1396; // initial y (top)
  const barBottom = initTop + barInitH; // fixed bottom coordinate

  // compute bar height and alpha
  let barH = barInitH;
  let barAlpha = 0;
  if (local <= growDur) {
    const t = Easings.easeOut(Math.min(1, local / growDur));
    barH = lerp(barInitH, barFinalH, t);
    barAlpha = t;
  } else if (local >= barCollapseStartRel) {
    // collapsing
    const t2 = Math.min(1, (local - barCollapseStartRel) / collapseDur);
    const t = 1 - Easings.easeOut(t2); // reverse easing
    barH = lerp(barInitH, barFinalH, t);
    barAlpha = Math.max(0, 1 - t2);
  } else {
    // fully grown
    barH = barFinalH;
    barAlpha = 1;
  }

  const barX = Math.round((W - barW) / 2);
  const barY = Math.round(barBottom - barH);

  // draw bar with current alpha
  ctx.save();
  ctx.globalAlpha = barAlpha;
  roundRect(ctx, barX, barY, barW, Math.max(1, Math.round(barH)), radius);
  ctx.fillStyle = "#F8604A";
  ctx.fill();
  ctx.restore();

  // text fade in/out
  let textAlpha = 0;
  if (local < textStartRel) {
    textAlpha = 0;
  } else if (local >= textStartRel && local <= textStartRel + textDur) {
    const t = Math.min(1, (local - textStartRel) / textDur);
    textAlpha = Easings.easeInOut(t);
  } else if (local > textStartRel + textDur && local < textOutStartRel) {
    textAlpha = 1;
  } else if (
    local >= textOutStartRel &&
    local <= textOutStartRel + textOutDur
  ) {
    const t = Math.min(1, (local - textOutStartRel) / textOutDur);
    textAlpha = 1 - Easings.easeInOut(t);
  } else if (local > textOutStartRel + textOutDur) {
    textAlpha = 0;
  }

  if (textAlpha <= 0) return;

  // draw text block
  const text = ov.newsTitle;
  const fontSize = 70;
  const lineHeight = Math.round(fontSize * 1.1); // 77
  const textW = 704;
  // center the text container horizontally, but keep text left-aligned inside it
  const containerX = Math.round((W - textW) / 2);
  const textX = containerX; // left-aligned draw start
  const textTopOffset = 50; // from top of bar
  const textY = barY + textTopOffset;

  ctx.save();
  ctx.globalAlpha = textAlpha;
  ctx.fillStyle = "#ffffff";
  ctx.font = `400 ${fontSize}px Inter, system-ui`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  // simple word-wrap into lines that fit textW
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? cur + " " + w : w;
    const m = ctx.measureText(candidate).width;
    if (m <= textW || !cur) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);

  // clamp number of lines (avoid overflow)
  const maxLines = Math.floor((barFinalH - textTopOffset) / lineHeight);
  const drawLines = lines.slice(0, Math.max(1, maxLines));

  for (let i = 0; i < drawLines.length; i++) {
    const ly = textY + i * lineHeight;
    ctx.fillText(drawLines[i], textX, ly);
  }

  ctx.restore();
}

// Initialize renderer: setup canvas, load resources and expose API used by Puppeteer.
async function init() {
  const project = window.__PROJECT__;
  const { width, height, background } = project.project;
  const canvas = document.getElementById("c");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });

  const res = await loadResources(project);

  // try to initialize optional audio controller if module available
  let audioController = null;
  try {
    // dynamic import so page still works if file missing/modified
    const mod = await import("./audio.js");
    if (mod && typeof mod.createAudioController === "function") {
      try {
        audioController = await mod.createAudioController(project);
        // try to autoplay (will silently fail if not allowed)
        try {
          audioController.play();
        } catch (e) {}
      } catch (e) {
        console.warn("audio controller init failed", e);
      }
    }
  } catch (e) {
    // module not present or import failed — audio simply disabled
  }

  // экспонируем API для Puppeteer — keep same surface: renderFrame(ms) and getPNG()
  window.__renderer = {
    async renderFrame(ms) {
      renderFrameInternal(ctx, project, res, ms, width, height, background);
    },
    getPNG() {
      return document.getElementById("c").toDataURL("image/png");
    },
    // expose audio controller to puppeteer for tests or manual control
    audioController,
  };

  try {
    window.__renderer.getResourceIndex = function () {
      return {
        images: Array.from(res.images.keys()),
        logos: Array.from(res.logos.keys()),
        videos: Array.from(res.videos.keys()),
      };
    };
  } catch (e) {
    console.warn("failed to attach resource index", e);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSubtitle(ctx, W, H, text) {
  const pad = 14,
    radius = 69,
    font = "54px Inter, system-ui";
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const tw = ctx.measureText(text).width;
  const bw = 796,
    bh = 138;
  const x = (W - bw) / 2,
    y = 1400;

  // Простая логика blur: нативный ctx.filter если есть, иначе — fill fallback.
  const blurPx = 64; // поменяйте при необходимости

  try {
    const off = document.createElement("canvas");
    // clamp native blur to safe range
    const safe = Math.max(0, Math.min(80, Math.round(blurPx)));
    // pad around box to accommodate blur spread (tune multiplier if needed)
    const pad = Math.ceil(safe * 2);
    off.width = Math.max(1, Math.floor(bw + pad * 2));
    off.height = Math.max(1, Math.floor(bh + pad * 2));
    const oc = off.getContext("2d");

    if (oc && typeof oc.filter !== "undefined") {
      oc.filter = `blur(${safe}px)`;
      // source coords: try to start at x-pad, but clamp to canvas bounds
      const sx = Math.max(0, Math.floor(x - pad));
      const sy = Math.max(0, Math.floor(y - pad));
      const sw = Math.max(0, Math.min(ctx.canvas.width - sx, off.width));
      const sh = Math.max(0, Math.min(ctx.canvas.height - sy, off.height));
      // draw the larger area into offscreen, blurred
      oc.clearRect(0, 0, off.width, off.height);
      oc.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);

      // clip to rounded rect and draw the offscreen so only inner area is visible
      ctx.save();
      roundRect(ctx, x, y, bw, bh, radius);
      ctx.clip();
      // place blurred offscreen so its (pad,pad) aligns with (x,y)
      ctx.drawImage(off, Math.floor(x - pad), Math.floor(y - pad));
      ctx.restore();
    } else {
      // лёгкий и надёжный fallback — полупрозрачная заливка
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      roundRect(ctx, x, y, bw, bh, radius);
      ctx.fill();
    }
  } catch (e) {
    console.warn("subtitle blur failed, falling back to solid bg", e);
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    roundRect(ctx, x, y, bw, bh, radius);
    ctx.fill();
  }

  // tint + текст (как было)
  ctx.save();
  roundRect(ctx, x, y, bw, bh, radius);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "#fff";
  ctx.fillText(text, W / 2, y + bh / 2);
  ctx.restore();
}

// Note: no local stub here. The renderer (Puppeteer) must inject `window.__PROJECT__`.

// wait until the real project object is injected (Puppeteer will replace the stub)
(async function waitForInjectedProjectAndInit() {
  try {
    const timeoutMs = 10000; // 10s timeout waiting for injected project
    const start = Date.now();
    while (typeof window.__PROJECT__ === "undefined") {
      if (Date.now() - start > timeoutMs) {
        console.error(
          "Timed out waiting for window.__PROJECT__ to be injected. Make sure the caller injects the project (Puppeteer)."
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // proceed to initialize the renderer with the injected project
    await init();
  } catch (err) {
    console.error(err);
  }
})();
