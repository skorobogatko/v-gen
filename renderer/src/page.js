// page.js
// ==================
// Файл: page.js
// Назначение: Отрисовщик сцены на HTML5 Canvas для рендера кадров.
// Описание: страница содержит функции загрузки ресурсов, построение списка
// активных объектов на текущем кадре, и функции рисования (фрейм, субтитры,
// новостной баннер). Скрипт экспортирует через `window.__renderer` метод
// `renderFrame(ms)` который Puppeteer вызывает для рендера конкретного кадра.
// Этот файл содержит много утилитарных функций и сложных блоков; для
// удобства начинающего программиста везде добавлены поясняющие комментарии.

// Ожидается, что ресурсы указаны полными URL или абсолютными путями; локальный
// резолвер путей не требуется.
// Отключить шумные логи в продакшн-режиме. Установите в false для включения предупреждений/ошибок при отладке.
const QUIET = true;

/**
 * Загрузить изображение по URL.
 * Возвращает Promise, который разрешается с объектом Image при успешной загрузке.
 * Пояснения для начинающих:
 * - Используем `crossOrigin = 'anonymous'` чтобы браузер мог запросить ресурс с CORS
 *   и потом позволить использовать его в canvas (иначе getImageData/toDataURL будет заблокирован).
 * - Мы оборачиваем событие onload/onerror в Promise, чтобы удобно ожидать загрузку.
 */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // важно для доступа к пикселям после drawImage
    img.onload = () => {
      res(img);
    };
    img.onerror = (e) => {
      // Выводим ошибку в консоль и отклоняем промис
      if (!QUIET) console.error(`[Image Load Error] src: ${src}`, e);
      rej(e);
    };
    img.src = src; // запуск загрузки
  });
}

/**
 * Загрузить видео как HTMLVideoElement.
 * Возвращает Promise, который разрешается, когда видео готово к проигрыванию.
 * Важные моменты для новичка:
 * - Устанавливаем crossOrigin и muted до присвоения src, чтобы CORS действовал и
 *   чтобы браузер позволил автоматически воспроизвести/предзагрузить видео (часто требуется muted).
 * - События onloadeddata и oncanplaythrough сигнализируют, что можно безопасно рисовать кадр видео.
 * - Таймаут предотвращает вечное ожидание при проблемах с сетью.
 */
function loadVideo(src, muted = true) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    // задаём свойства ДО назначения src
    v.crossOrigin = "anonymous";
    v.muted = muted;
    v.preload = "auto";
    v.playsInline = true;
    // Если источник локальный в /assets/, предпочитаем прямое присвоение src,
    // чтобы сервер мог обрабатывать Range-запросы. Для удалённых URL по-прежнему
    // пробуем fetch->blob когда это уместно (остаются резервные пути).
    (async () => {
      try {
        if (typeof src === "string" && src.startsWith("/assets/")) {
          v.src = src;
        } else {
          // Удалённый ресурс: пробуем получить полный blob (для некоторых серверов/безголовых
          // сборок декодеры работают корректнее с blob). Если fetch неудачен — используем fallback.
          try {
            const resp = await fetch(src);
            if (resp.ok) {
              const blob = await resp.blob();
              const blobUrl = URL.createObjectURL(blob);
              v.src = blobUrl;
              v.__blobUrl = blobUrl;
              return;
            }
          } catch (e) {
            // игнорируем и продолжаем (fallback)
          }
          v.src = src;
        }
      } catch (e) {
        try {
          v.src = src;
        } catch (e) {}
      }
    })();

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
      if (!QUIET) console.error(`[Video Load Error] src: ${src}`, e);
      onDone(false);
    };

    // если ничего не произошло за 8 секунд — считаем загрузку неуспешной
    const timer = setTimeout(() => onDone(false), 8000);

    // Иногда помогает попытка краткого воспроизведения (muted) — это "разогревает" декодер
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

// простые easing (функции плавности для анимаций)
const Easings = {
  linear: (t) => t,
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  // ease-out cubic
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
};

/**
 * Линейная интерполяция между a и b по параметру t в диапазоне [0..1].
 * Используется для плавного перехода числовых значений.
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// вычисляем альфу для fade in/out
/**
 * Вычислить альфу (прозрачность) для эффектов fade-in / fade-out.
 * localT - текущее локальное время анимации в миллисекундах,
 * durMs - полная длительность, fade - объект { in, out } в секундах.
 */
function fadeAlpha(localT, durMs, fade) {
  if (!fade) return 1;
  const fi = (fade.in || 0) * 1000,
    fo = (fade.out || 0) * 1000;
  if (fi > 0 && localT < fi) return localT / fi; // в пределах fade-in — линейно растём
  if (fo > 0 && localT > durMs - fo) return Math.max(0, (durMs - localT) / fo); // fade-out
  return 1; // иначе полностью непрозрачный
}

// Загрузить и проиндексировать все ресурсы, упомянутые в проекте.
// Возвращает объект { images, logos, videos }, где каждое значение — Map(src -> element).
/**
 * Загрузить все ресурсы, упомянутые в `project` (изображения, лого, видео).
 * Возвращает объект { images: Map, logos: Map, videos: Map }.
 * Мы используем Map(src -> element) чтобы быстро доставать загруженный ресурс по URL.
 */
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
        else {
          if (!QUIET)
            console.warn(
              "[Resource Load Warning] image",
              r?.src,
              "failed:",
              r?.error
            );
        }
      }
    }
    if (settled[1] && settled[1].status === "fulfilled") {
      for (const r of settled[1].value) {
        if (r && r.value) res.logos.set(r.src, r.value);
        else {
          if (!QUIET)
            console.warn(
              "[Resource Load Warning] logo",
              r?.src,
              "failed:",
              r?.error
            );
        }
      }
    }
    if (settled[2] && settled[2].status === "fulfilled") {
      for (const r of settled[2].value) {
        if (r && r.value) res.videos.set(r.src, r.value);
        else {
          if (!QUIET)
            console.warn(
              "[Resource Load Warning] video",
              r?.src,
              "failed:",
              r?.error
            );
        }
      }
    }
  } catch (err) {
    if (!QUIET)
      console.error(
        "[Resource Load Error] unexpected error processing results",
        err
      );
  }

  return res;
}

// Перемотать видео до целевого времени и дождаться готовности нового кадра (с резервными вариантами).
// По возможности используем requestVideoFrameCallback; иначе откатываемся к onseeked + таймаут.
function seekVideoAndWait(v, target) {
  return new Promise((resolve) => {
    let settled = false;
    let method = "timeout";
    const finish = (m) => {
      if (settled) return;
      settled = true;
      method = method || m;
      try {
        v.onseeked = null;
      } catch (e) {}
      try {
        clearTimeout(timer);
      } catch (e) {}
      resolve();
    };

    // Пытаемся «подтолкнуть» декодер кратким воспроизведением (в некоторых headless-сборках
    // декодирование происходит только при play)
    try {
      const p = v.play();
      if (p && p.then) p.catch(() => {});
    } catch (e) {}

    // Защитный таймаут на случай, если события не сработают (даём дополнительное время для софт-декодинга)
    const timer = setTimeout(() => {
      method = "timeout";
      finish(method);
    }, 2500);

    // Вспомогательная функция: проверяет, близко ли currentTime к целевому времени
    const closeEnough = () => Math.abs((v.currentTime || 0) - target) <= 0.05;

    // register seeked fallback
    try {
      v.onseeked = () => {
        // slight delay to allow decoder to present frame
        setTimeout(() => {
          if (closeEnough()) {
            finish(method);
          }
        }, 40);
      };
    } catch (e) {}

    // Предпочитаем requestVideoFrameCallback, когда он доступен, и используем metadata.mediaTime/presentedFrames
    try {
      if (typeof v.requestVideoFrameCallback === "function") {
        let lastPresented = -1;
        const cb = (now, metadata) => {
          try {
            // Если metadata содержит mediaTime, проверяем, близко ли оно к целевому времени
            if (metadata && typeof metadata.mediaTime === "number") {
              if (Math.abs(metadata.mediaTime - target) <= 0.05)
                return finish("rvfc");
            }
            // Если metadata содержит presentedFrames, убеждаемся, что счётчик кадров продвинулся
            if (metadata && typeof metadata.presentedFrames === "number") {
              if (lastPresented === -1)
                lastPresented = metadata.presentedFrames;
              else if (metadata.presentedFrames > lastPresented)
                return finish("rvfc");
            }
          } catch (e) {}
          try {
            v.requestVideoFrameCallback(cb);
          } catch (e) {
            // игнорируем и откатываемся к обработчику onseeked
          }
        };
        try {
          v.requestVideoFrameCallback(cb);
        } catch (e) {}
      }
    } catch (e) {}

    // Выполняем seek
    try {
      v.currentTime = target;
    } catch (e) {
      // игнорируем
    }

    // Если уже на целевом времени — резолвим немедленно
    try {
      if (closeEnough()) {
        clearTimeout(timer);
        try {
          v.pause();
        } catch (e) {}
        finish(method);
      }
    } catch (e) {}
  });
}

// Построить плоский список активных объектов на заданном времени (ms). НЕ выполняет отрисовку.
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
          // (seek-хелпер удалён отсюда и вынесен в верхний уровень)
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

/**
 * Построить плоский список объектов, которые активны на заданном времени (ms).
 * Возвращаемый формат подходит для рендерера: каждый объект содержит
 * геометрию (x,y,w,h), тип (image|video|text), z-индекс, альфу и трансформации.
 * Пояснение для новичка:
 * - Проект описан как набор сцен (`videoTrack`), каждая сцена имеет start/end в секундах.
 * - Мы вычисляем local = ms - scene.start и применяем анимации по типу (zoom/move/fade).
 */

// Внутренний рендерер, используемый обёрткой renderFrame. Поведение сохранено.
async function renderFrameInternal(
  ctx,
  project,
  res,
  ms,
  width,
  height,
  background
) {
  // Служебный список для активных объектов
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

  // Проверяем, есть ли активный субтитр для текущего времени
  const sub = (project.subtitles || []).find(
    (s) => ms / 1000 >= s.start && ms / 1000 < s.end
  );

  const anyHas = activeListDebug.some((a) => a.has);
  // Если нет визуальных ресурсов и нет субтитра, заранее завершаем рендеринг.
  // Это позволяет избежать внезапных чёрных кадров во время переходов
  // (например, когда видео перекладывается на нужное время). Мы сохраняем
  // предыдущий содержимое canvas, если оно есть; очищаем только при первом кадре.
  if (!anyHas && !sub) {
    if (!window.__lastRendered) {
      ctx.fillStyle = background || "#000";
      ctx.fillRect(0, 0, width, height);
    }
    return;
  }

  // Подготавливаем канву к рисованию нового кадра: заливаем фоном, чтобы
  // избежать артефактов от предыдущих кадров. Отмечаем, что уже есть
  // отрисованный кадр, чтобы последующие пустые кадры могли сохранить его.
  ctx.fillStyle = background || "#000";
  ctx.fillRect(0, 0, width, height);
  window.__lastRendered = true;

  // Находим оверлей с новостным заголовком и желаемый z-уровень (по умолчанию 100)
  const newsOverlay = (project.overlays || []).find(
    (o) => typeof o.newsTitle === "string"
  );
  const newsZ = newsOverlay
    ? typeof newsOverlay.z === "number"
      ? newsOverlay.z
      : 100
    : null;

  // Рисуем активные объекты и вставляем новостной заголовок, когда встречаем объект с более высоким z
  let newsDrawn = false;
  for (const o of activeObjects) {
    // Если новость ещё не нарисована и текущий объект имеет z больше newsZ — рисуем новость
    if (newsOverlay && !newsDrawn && (o.z || 0) > (newsZ ?? 0)) {
      try {
        drawNewsTitle(ctx, project, ms, width, height);
      } catch (e) {
        // Если здесь происходит ошибка — мы ловим её, чтобы рендер не падал.
        // Для начинающего: всегда оборачивайте потенциально хрупкие вызовы в try/catch
        // если хотите, чтобы основной процесс продолжил работу при ошибке вспомогательного кода.
        if (!QUIET) console.warn("drawNewsTitle failed", e);
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
          if (!QUIET) console.error("[Draw Error] image", o.src, e);
        }
      }
    } else if (o.type === "video") {
      const v = res.videos.get(o.src);
      if (v) {
        const scene = project.videoTrack.find(
          (sc) => ms >= sc.start * 1000 && ms < sc.end * 1000
        );
        const localMs = ms - ((scene && scene.start * 1000) || 0);
        // compute target by frame index to avoid rounding collisions when using ms
        const timeSec = Math.max(0, localMs / 1000);
        const fps = 30; // предполагаем номинальные 30fps; можно сделать динамическим позже
        const frameIndex = Math.round(timeSec * fps);
        const target = frameIndex / fps;
        // если текущее время отличается более чем на полкадра — выполняем seek
        if (Math.abs((v.currentTime || 0) - target) > 1 / (fps * 2)) {
          try {
            await seekVideoAndWait(v, target);
          } catch (e) {}
        }
        const cx = o.x + o.w / 2,
          cy = o.y + o.h / 2;
        ctx.translate(cx + (o.tx || 0), cy + (o.ty || 0));
        ctx.scale(o.scale || 1, o.scale || 1);
        try {
          ctx.drawImage(v, -o.w / 2, -o.h / 2, o.w, o.h);
        } catch (e) {
          if (!QUIET) console.error("[Draw Error] video", o.src, e);
        }
      }
    } else if (o.type === "text") {
      const text = o.text || "";
      const style = o.style || {};
      const font = style.font || "600 42px YSText";
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

  // Если новостной оверлей ещё не отрисован (например, у него z выше всех объектов), рисуем его здесь
  if (newsOverlay && !newsDrawn) {
    try {
      drawNewsTitle(ctx, project, ms, width, height);
    } catch (e) {
      if (!QUIET) console.warn("drawNewsTitle failed", e);
    }
  }

  // В конце рисуем субтитры поверх всего
  if (sub) drawSubtitle(ctx, width, height, sub.text);
}

// Рисует новостной заголовок с анимацией по таймлайну, описанному в требованиях проекта.
function drawNewsTitle(ctx, project, ms, W, H) {
  if (!project || !Array.isArray(project.overlays)) return;
  const ov = project.overlays.find((o) => typeof o.newsTitle === "string");
  if (!ov || !ov.newsTitle) return;

  // Временные параметры анимации (в мс)
  // значения по умолчанию согласно спецификации
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

  // Поля start/end в оверлее заданы в секундах (project.json).
  // start — начало анимации; end — момент, к которому должна завершиться исчезающая часть.
  // Если end не указан — используем start + defaultTotal.
  const startMs =
    typeof ov.start === "number" ? Math.round(ov.start * 1000) : 1000;
  const endMs =
    typeof ov.end === "number"
      ? Math.round(ov.end * 1000)
      : startMs + defaultTotal;

  // clamp endMs >= startMs + minimal (1ms)
  const available = Math.max(1, endMs - startMs);

  // если доступное время меньше чем defaultTotal — масштабируем длительности пропорционально
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

  // Относительные тайминги (в миллисекундах) относительно startMs
  const textStartRel = growDur + textDelay;
  const textVisibleAtRel = textStartRel + textDur;
  const disappearStartRel = textVisibleAtRel + holdAfterText;
  const textOutStartRel = disappearStartRel;
  const barCollapseStartRel = textOutStartRel + textOutDur;
  const totalDurationRel = barCollapseStartRel + collapseDur;

  const local = ms - startMs;
  if (local < 0 || local > totalDurationRel) return;

  // Геометрия полосы (баннера)
  const barW = 804;
  const barInitH = 146;
  const barFinalH = 473;
  const radius = 73;
  // Низ полосы фиксирован; входные координаты ориентированы на верх в свернутом состоянии
  const initTop = 1396; // начальная координата top
  const barBottom = initTop + barInitH; // фиксированная координата bottom

  // Вычисляем текущую высоту полосы и её прозрачность (alpha)
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

  // Рисуем полосу с рассчитанной прозрачностью
  ctx.save();
  ctx.globalAlpha = barAlpha;
  roundRect(ctx, barX, barY, barW, Math.max(1, Math.round(barH)), radius);
  ctx.fillStyle = "#F8604A";
  ctx.fill();
  ctx.restore();

  // Плавность появления/исчезновения текста (fade in/out)
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

  // Рисуем блок с текстом (заголовком)
  const text = ov.newsTitle;
  const fontSize = 70;
  const lineHeight = Math.round(fontSize * 1.1); // 77
  const textW = 704;
  // Центрируем контейнер текста по горизонтали, но внутри оставляем текст выровненным по левому краю
  const containerX = Math.round((W - textW) / 2);
  const textX = containerX; // начало рисования текста, выровненного по левому краю
  const textTopOffset = 50; // отступ сверху внутри полосы (в пикселях)
  const textY = barY + textTopOffset;

  ctx.save();
  ctx.globalAlpha = textAlpha;
  ctx.fillStyle = "#ffffff";
  ctx.font = `400 ${fontSize}px YSText, system-ui`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  // Простая развертка слов на строки так, чтобы они помещались в ширину textW
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

  // Ограничиваем число строк, чтобы не выйти за пределы баннера
  const maxLines = Math.floor((barFinalH - textTopOffset) / lineHeight);
  const drawLines = lines.slice(0, Math.max(1, maxLines));

  for (let i = 0; i < drawLines.length; i++) {
    const ly = textY + i * lineHeight;
    ctx.fillText(drawLines[i], textX, ly);
  }

  ctx.restore();
}

/**
 * Инициализация рендера: настройка canvas, загрузка ресурсов и экспонирование API
 * Пояснение для новичка:
 * - Эта функция вызывается после того как Puppeteer через window.__PROJECT__ вставит объект проекта.
 * - Мы создаём canvas, загружаем все ресурсы и формируем объект window.__renderer с методом renderFrame(ms).
 */

// Инициализация рендера: настроить canvas, загрузить ресурсы и экспонировать API, используемое Puppeteer.
async function init() {
  const project = window.__PROJECT__;
  const { width, height, background } = project.project;
  const canvas = document.getElementById("c");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });

  const res = await loadResources(project);

  // Убедиться, что video-элементы добавлены в DOM (вне экрана), чтобы декодирование и
  // requestVideoFrameCallback работали корректно в headless режиме.
  try {
    for (const [src, v] of res.videos.entries()) {
      // если элемент уже в DOM — пропускаем
      if (!v || !v.tagName) continue;
      if (!document.body.contains(v)) {
        v.style.position = "absolute";
        v.style.left = "-9999px";
        v.style.top = "-9999px";
        v.style.width = "1px";
        v.style.height = "1px";
        v.playsInline = true;
        v.muted = true;
        document.body.appendChild(v);
      }
    }
    // Короткий play/pause разогрев для всех видео
    try {
      const vids = Array.from(document.querySelectorAll("video"));
      for (const vv of vids) {
        try {
          const p = vv.play();
          if (p && p.then) await p.catch(() => {});
          vv.pause();
        } catch (e) {}
      }
    } catch (e) {}
  } catch (e) {
    // игнорируем ошибки DOM
  }

  // Additional warm-seek: briefly seek each video to a near-start time and back
  // to prompt decoders to produce frames on subsequent seeks during render.
  try {
    const vids = Array.from(document.querySelectorAll("video"));
    for (const vv of vids) {
      try {
        // small bump forward and wait for a frame
        vv.currentTime = Math.max(0.02, 0.05);
        // wait for rVFC or seeked
        await new Promise((resolve) => {
          let done = false;
          const tmr = setTimeout(() => {
            if (done) return;
            done = true;
            resolve();
          }, 600);
          try {
            if (typeof vv.requestVideoFrameCallback === "function") {
              vv.requestVideoFrameCallback(() => {
                if (done) return;
                done = true;
                clearTimeout(tmr);
                resolve();
              });
            } else {
              vv.onseeked = () => {
                if (done) return;
                done = true;
                clearTimeout(tmr);
                resolve();
              };
            }
          } catch (e) {
            clearTimeout(tmr);
            resolve();
          }
        });
        // return to near-zero so render starts from frame 0
        try {
          vv.currentTime = Math.max(0.001, 0);
        } catch (e) {}
      } catch (e) {}
    }
  } catch (e) {}

  // попытка инициализировать опциональный аудиоконтроллер, если модуль доступен
  let audioController = null;
  try {
    // динамический импорт: страница продолжит работать, даже если файл отсутствует или изменён
    const mod = await import("./audio.js");
    if (mod && typeof mod.createAudioController === "function") {
      try {
        audioController = await mod.createAudioController(project);
        // попытка автозапуска: в некоторых окружениях это может не разрешиться (ошибка будет подавлена)
        try {
          audioController.play();
        } catch (e) {}
      } catch (e) {
        if (!QUIET) console.warn("audio controller init failed", e);
      }
    }
  } catch (e) {
    // модуль не найден или импорт не удался — аудио будет отключено
  }

  // экспонируем API для Puppeteer — сохраняем интерфейс: renderFrame(ms) и getPNG()
  window.__renderer = {
    async renderFrame(ms) {
      await renderFrameInternal(
        ctx,
        project,
        res,
        ms,
        width,
        height,
        background
      );
    },
    getPNG() {
      return document.getElementById("c").toDataURL("image/png");
    },
    // экспонируем контроллер аудио для Puppeteer — удобно для тестов или ручного управления
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
    if (!QUIET) console.warn("failed to attach resource index", e);
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
    font = "54px YSText, system-ui";
  ctx.save();
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const tw = ctx.measureText(text).width;
  const bw = 796,
    bh = 138;
  const x = (W - bw) / 2,
    y = 1400;

  // Простая логика размытия: если доступен нативный ctx.filter — используем его, иначе — fallback через заливку.
  const blurPx = 64; // поменяйте при необходимости

  try {
    const off = document.createElement("canvas");
    // ограничиваем значение размытия в безопасном диапазоне
    const safe = Math.max(0, Math.min(80, Math.round(blurPx)));
    // добавочный отступ вокруг области, чтобы учесть распространение размытия (при необходимости настройте множитель)
    const pad = Math.ceil(safe * 2);
    off.width = Math.max(1, Math.floor(bw + pad * 2));
    off.height = Math.max(1, Math.floor(bh + pad * 2));
    const oc = off.getContext("2d");

    if (oc && typeof oc.filter !== "undefined") {
      oc.filter = `blur(${safe}px)`;
      // координаты источника: стараемся начать с x-pad, но ограничиваем в границах canvas
      const sx = Math.max(0, Math.floor(x - pad));
      const sy = Math.max(0, Math.floor(y - pad));
      const sw = Math.max(0, Math.min(ctx.canvas.width - sx, off.width));
      const sh = Math.max(0, Math.min(ctx.canvas.height - sy, off.height));
      // отрисовываем расширенную область в offscreen и применяем размытие
      oc.clearRect(0, 0, off.width, off.height);
      oc.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);

      // обрезаем по скруглённому прямоугольнику и накладываем размытый offscreen так,
      // чтобы была видна только внутренняя область
      ctx.save();
      roundRect(ctx, x, y, bw, bh, radius);
      ctx.clip();
      // размещаем размытый offscreen таким образом, чтобы его (pad,pad) совпадал с (x,y)
      ctx.drawImage(off, Math.floor(x - pad), Math.floor(y - pad));
      ctx.restore();
    } else {
      // лёгкий и надёжный fallback — полупрозрачная заливка
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      roundRect(ctx, x, y, bw, bh, radius);
      ctx.fill();
    }
  } catch (e) {
    if (!QUIET)
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

// Примечание: здесь нет локальной заглушки проекта. Puppeteer должен вставить `window.__PROJECT__`.

// Ожидаем, пока в `window.__PROJECT__` будет вставлен реальный объект проекта (этот шаг выполняет Puppeteer)
(async function waitForInjectedProjectAndInit() {
  try {
    const timeoutMs = 10000; // 10s timeout waiting for injected project
    const start = Date.now();
    while (typeof window.__PROJECT__ === "undefined") {
      if (Date.now() - start > timeoutMs) {
        if (!QUIET)
          console.error(
            "Timed out waiting for window.__PROJECT__ to be injected. Make sure the caller injects the project (Puppeteer)."
          );
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // продолжаем инициализацию рендера с внедрённым объектом проекта
    await init();
  } catch (err) {
    if (!QUIET) console.error(err);
  }
})();
