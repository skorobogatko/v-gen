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
  // clear
  ctx.fillStyle = background || "#000";
  ctx.fillRect(0, 0, width, height);

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

  const anyHas = activeListDebug.some((a) => a.has);
  if (!anyHas) {
    ctx.fillStyle = "#0a0";
    ctx.fillRect(
      50,
      50,
      Math.min(600, width - 100),
      Math.min(300, height - 100)
    );
    ctx.fillStyle = "#fff";
    ctx.font = "48px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("TEST RENDER — resources missing", 70, 140);
    ctx.fillText(`t=${ms}ms`, 70, 200);
    return;
  }

  for (const o of activeObjects) {
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

  const sub = (project.subtitles || []).find(
    (s) => ms / 1000 >= s.start && ms / 1000 < s.end
  );
  if (sub) drawSubtitle(ctx, width, height, sub.text);
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

  // экспонируем API для Puppeteer — keep same surface: renderFrame(ms) and getPNG()
  window.__renderer = {
    async renderFrame(ms) {
      renderFrameInternal(ctx, project, res, ms, width, height, background);
    },
    getPNG() {
      return document.getElementById("c").toDataURL("image/png");
    },
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
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  roundRect(ctx, x, y, bw, bh, radius);
  ctx.fill();
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
