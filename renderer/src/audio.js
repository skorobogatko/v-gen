// audio.js
// ==================
// Файл: audio.js
// Назначение: Утилиты для работы с WebAudio в браузере — помогает управлять
// несколькими аудиотреками, устанавливать громкость в процентах и создавать
// контроллер воспроизведения, который используется на странице рендера.
// Экспортирует: dbToPercent, percentToGain, createAudioController

export function dbToPercent(db) {
  // Преобразовать уровень в децибелах (dB) в процент амплитуды (0-100).
  // Формула: амплитуда пропорциональна 10^(dB/20).
  return Math.pow(10, db / 20) * 100;
}

export function percentToGain(percent) {
  // Преобразовать процент громкости в коэффициент усиления (0..1) для WebAudio GainNode.
  return Math.max(0, percent) / 100;
}

/**
 * Создать контроллер аудио на основе объекта project.json.
 * Поддерживает старую форму (audio.music с gain) и новую (audio.tracks с volumePercent).
 * Возвращает объект: { ctx, tracks, play, pause, setVolume(id,percent), setVolumeAll(percent) }
 */
export async function createAudioController(project) {
  if (typeof window === "undefined")
    throw new Error("createAudioController must be used in a browser");

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();

  const audioDef = project.audio || {};
  let defs = [];

  if (Array.isArray(audioDef.tracks)) {
    defs = audioDef.tracks.map((t, i) => ({
      id: t.id || `track-${i}`,
      src: t.src,
      offset: t.offset || 0,
      volumePercent:
        typeof t.volumePercent === "number" ? t.volumePercent : 100,
    }));
  } else if (audioDef.music && audioDef.music.src) {
    const m = audioDef.music;
    let vp = 100;
    if (typeof m.volumePercent === "number") vp = m.volumePercent;
    else if (typeof m.gain === "number") vp = dbToPercent(m.gain);
    defs = [
      { id: "music", src: m.src, offset: m.offset || 0, volumePercent: vp },
    ];
  }

  const tracks = [];

  for (const d of defs) {
    const el = new Audio(d.src);
    el.crossOrigin = "anonymous";
    el.preload = "auto";

    // Создаём MediaElementSource и узел усиления (GainNode)
    let srcNode;
    try {
      srcNode = ctx.createMediaElementSource(el);
    } catch (e) {
      // Некоторые браузеры запрещают создавать несколько MediaElementSource для одного элемента;
      // в этом случае используем fallback — управлять громкостью через property element.volume
      srcNode = null;
    }

    const gain = ctx.createGain();
    gain.gain.value = percentToGain(d.volumePercent);

    if (srcNode) {
      srcNode.connect(gain).connect(ctx.destination);
    } else {
      // Фоллбек: управляем громкостью непосредственно через HTMLAudioElement.volume
      el.volume = percentToGain(d.volumePercent);
    }

    tracks.push({
      id: d.id,
      element: el,
      srcNode,
      gainNode: gain,
      offset: d.offset,
      volumePercent: d.volumePercent,
    });
  }

  // Методы контроллера: play/pause/setVolume/setVolumeAll
  // play(): попытается возобновить контекст и запустить все аудиотреки.
  function play() {
    if (ctx.state === "suspended") ctx.resume();
    for (const t of tracks) {
      try {
        if (!t.element.paused) continue;
        if (t.offset && t.element.currentTime < 0.01) {
          try {
            t.element.currentTime = t.offset;
          } catch (e) {
            /* ignore */
          }
        }
        // play() возвращает промис — смягчаем ошибки catch-ом
        t.element.play().catch(() => {});
      } catch (e) {}
    }
  }

  function pause() {
    for (const t of tracks) {
      try {
        t.element.pause();
      } catch (e) {}
    }
  }

  function setVolume(id, percent) {
    const t = tracks.find((x) => x.id === id);
    if (!t) return false;
    t.volumePercent = percent;
    if (t.gainNode) t.gainNode.gain.value = percentToGain(percent);
    else t.element.volume = percentToGain(percent);
    return true;
  }

  function setVolumeAll(percent) {
    for (const t of tracks) setVolume(t.id, percent);
  }

  return { ctx, tracks, play, pause, setVolume, setVolumeAll };
}
