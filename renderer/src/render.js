// render.js
// ==================
// Файл: render.js
// Назначение: CLI-утилита для рендера видео из JSON-проекта.
// Описание: этот скрипт читает `project.json`, запускает локальную страницу
// на базе Puppeteer, прокидывает проект в страницу и последовательно делает
// скриншоты кадров. Затем собирает кадры и аудиодорожки в итоговый mp4
// с помощью ffmpeg.
// Основные функции/блоки:
// - парсинг аргументов командной строки
// - запуск локального HTTP сервера (чтобы страница могла загружать модули/ресурсы)
// - запуск Puppeteer и взаимодействие со страницей (вызов renderFrame)
// - тёплый прогрев декодеров видео (warm-up)
// - сохранение кадров и сборка ffmpeg

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { spawn } from "child_process";
import puppeteer from "puppeteer";
import http from "http";
import https from "https";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// set QUIET to true to reduce console noise during batch renders
const QUIET = true;

const program = new Command();
program
  .requiredOption("--in <file>", "project json")
  .requiredOption("--out <file>", "output mp4")
  .option("--fps <n>", "frames per second")
  .option("--w <n>", "width")
  .option("--h <n>", "height")
  .option("--warm <n>", "warm-up frames to render (skip saving)")
  // опция prefetch удалена — ассеты ожидаются доступными по URL или по путям внутри проекта
  .parse(process.argv);

const opts = program.opts();

const projectPath = path.resolve(__dirname, "..", opts.in);
const outPath = path.resolve(__dirname, "..", opts.out);
const framesDir = path.resolve(path.dirname(outPath), "frames");

const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

(async () => {
  const proj = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
  // prefer CLI arguments when provided, otherwise fall back to values from project.json
  const fps = opts.fps
    ? parseInt(opts.fps, 10)
    : parseInt(proj.project?.fps || "30", 10);
  const width = opts.w
    ? parseInt(opts.w, 10)
    : parseInt(proj.project?.width || "1920", 10);
  const height = opts.h
    ? parseInt(opts.h, 10)
    : parseInt(proj.project?.height || "1080", 10);
  const warmFrames = Math.max(
    0,
    parseInt(opts.warm || String(proj.project?.warm || "0"), 10)
  );

  // нормализуем размер
  proj.project.width = width;
  proj.project.height = height;
  proj.project.fps = fps;

  // длительность: используем proj.project.videoLength если задана, иначе по последней сцене
  const lastSceneSec = Math.max(...proj.videoTrack.map((s) => s.end), 0);
  const totalSec =
    typeof proj.project?.videoLength === "number" &&
    proj.project.videoLength > 0
      ? proj.project.videoLength
      : lastSceneSec;
  const totalFrames = Math.ceil(totalSec * fps);

  ensureDir(path.dirname(outPath));
  ensureDir(framesDir);
  // ensure assets directory exists
  const assetsDir = path.resolve(path.dirname(projectPath), "assets");
  ensureDir(assetsDir);

  // Helper: download a URL to a local file if it doesn't exist
  async function downloadTo(url, destPath) {
    if (fs.existsSync(destPath)) return; // skip existing
    await new Promise((resolve, reject) => {
      try {
        const client = url.startsWith("https://") ? https : http;
        client
          .get(url, (res) => {
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              // follow redirect
              downloadTo(res.headers.location, destPath)
                .then(resolve)
                .catch(reject);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Failed to download ${url}: ${res.statusCode}`));
              return;
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on("finish", () => file.close(resolve));
            file.on("error", (err) => reject(err));
          })
          .on("error", (err) => reject(err));
      } catch (e) {
        reject(e);
      }
    });
  }

  // Collect all asset URLs from project (videos, images, audio, overlays)
  function collectAssetUrls(proj) {
    const urls = new Set();
    for (const sc of proj.videoTrack || []) {
      for (const o of sc.objects || []) {
        if (o.src && /^https?:\/\//i.test(o.src)) urls.add(o.src);
      }
    }
    for (const ov of proj.overlays || []) {
      if (ov.src && /^https?:\/\//i.test(ov.src)) urls.add(ov.src);
    }
    if (Array.isArray(proj.audio?.tracks)) {
      for (const t of proj.audio.tracks)
        if (t.src && /^https?:\/\//i.test(t.src)) urls.add(t.src);
    }
    if (proj.audio?.music?.src && /^https?:\/\//i.test(proj.audio.music.src))
      urls.add(proj.audio.music.src);
    return Array.from(urls);
  }

  // Download all external assets into local assetsDir and rewrite project.src to local '/assets/<name>' paths
  const externalUrls = collectAssetUrls(proj);
  if (externalUrls.length > 0) {
    console.log(
      `→ prefetching ${externalUrls.length} external assets to ${assetsDir} ...`
    );
    for (const u of externalUrls) {
      try {
        const parsed = new URL(u);
        const name = path.basename(parsed.pathname);
        const localPath = path.join(assetsDir, name);
        await downloadTo(u, localPath);
        // rewrite project sources that referenced this URL to local /assets/ path
        for (const sc of proj.videoTrack || []) {
          for (const o of sc.objects || []) {
            if (o.src === u) o.src = `/assets/${name}`;
          }
        }
        for (const ov of proj.overlays || []) {
          if (ov.src === u) ov.src = `/assets/${name}`;
        }
        if (Array.isArray(proj.audio?.tracks)) {
          for (const t of proj.audio.tracks)
            if (t.src === u) t.src = `/assets/${name}`;
        }
        if (proj.audio?.music?.src === u)
          proj.audio.music.src = `/assets/${name}`;
      } catch (e) {
        console.warn(
          `prefetch failed for ${u}:`,
          e && e.message ? e.message : e
        );
      }
    }
    console.log(`→ prefetch complete`);
  }

  const projectRoot = path.resolve(__dirname, "..");

  // prefetch functionality removed: assets are used directly from URLs or project-local paths
  // функциональность prefetch удалена: ресурсы используются напрямую из URL или путей внутри проекта

  // prefetch удалён — действий не требуется

  // запускаем небольшой статический сервер, раздающий корень проекта, чтобы ES-модули загружались по HTTP
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(
        new URL(req.url, `http://localhost`).pathname
      );
      // по умолчанию возвращаем /src/page.html при запросе /
      const relPath = urlPath === "/" ? "/src/page.html" : urlPath;
      const filePath = path.join(projectRoot, relPath);
      if (!filePath.startsWith(projectRoot)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const types = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".mp4": "video/mp4",
          ".mp3": "audio/mpeg",
          ".json": "application/json",
        };
        let ct = types[ext] || "application/octet-stream";
        // если файл без расширения или тип неизвестен, пытаемся определить по сигнатуре (magic bytes)
        if (!ext || ct === "application/octet-stream") {
          try {
            const h = fs.openSync(filePath, "r");
            const buf = Buffer.alloc(16);
            fs.readSync(h, buf, 0, 16, 0);
            fs.closeSync(h);
            // PNG
            if (
              buf[0] === 0x89 &&
              buf[1] === 0x50 &&
              buf[2] === 0x4e &&
              buf[3] === 0x47
            )
              ct = "image/png";
            // JPG
            else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
              ct = "image/jpeg";
            // GIF
            else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
              ct = "image/gif";
            // MP4/ISOBMFF
            else if (buf.slice(4, 8).toString() === "ftyp") ct = "video/mp4";
            // WEBM (EBML)
            else if (
              buf[0] === 0x1a &&
              buf[1] === 0x45 &&
              buf[2] === 0xdf &&
              buf[3] === 0xa3
            )
              ct = "video/webm";
            // MP3 (ID3)
            else if (buf.slice(0, 3).toString() === "ID3") ct = "audio/mpeg";
            // OGG
            else if (buf.slice(0, 4).toString() === "OggS")
              ct = "application/ogg";
            // SVG (starts with '<')
            else if (buf[0] === 0x3c) ct = "image/svg+xml";
          } catch (e) {
            // ignore sniffing errors
          }
        }

        // Support Range requests for media files (important for seeking video)
        const range = req.headers && req.headers.range;
        if (range && /bytes=\d*-\d*/.test(range)) {
          const total = st.size;
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parts[0] ? parseInt(parts[0], 10) : 0;
          const end =
            parts[1] && parts[1].length ? parseInt(parts[1], 10) : total - 1;
          const chunkEnd = Math.min(end, total - 1);
          const chunkSize = chunkEnd - start + 1;
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${chunkEnd}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": ct,
            "Access-Control-Allow-Origin": "*",
          });
          const stream = fs.createReadStream(filePath, {
            start,
            end: chunkEnd,
          });
          stream.on("error", () => {
            try {
              res.end();
            } catch (e) {}
          });
          stream.pipe(res);
          return;
        }

        // Default: send full file
        res.writeHead(200, {
          "Content-Type": ct,
          "Content-Length": st.size,
          "Access-Control-Allow-Origin": "*",
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(filePath).pipe(res);
      });
    } catch (e) {
      res.writeHead(500);
      res.end("Server error");
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const serverPort = server.address().port;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--use-gl=swiftshader", // стабильный софт-рендер
      ],
    });
  } catch (err) {
    if (!QUIET)
      console.error(
        "[Puppeteer Launch Error]",
        err && err.message ? err.message : err
      );
    throw err;
  }

  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // Проксируем сообщения консоли браузера в терминал Node.js (only errors/warnings)
  page.on("console", (msg) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const args = msg.args();
    Promise.all(args.map((a) => a.jsonValue())).then((vals) => {
      if (!QUIET) console.log(`[browser]`, msg.type(), ...vals);
    });
  });

  const pageUrl = `http://127.0.0.1:${serverPort}/src/page.html`;

  // загружаем страницу и прокидываем проект
  await page.goto(pageUrl, { waitUntil: "load" });
  await page.exposeFunction("__getProject", () => proj);
  await page.evaluate(async () => {
    const p = await window.__getProject();
    window.__PROJECT__ = p;
  });
  // enable page-side debug hooks for this run (diagnostics for seeks/rvfc)
  await page.evaluate(() => {
    try {
      window.__RENDER_DEBUG = true;
    } catch (e) {}
  });

  // ждём инициализации рендера
  await page.waitForFunction("window.__renderer && true", { timeout: 10000 });

  // fetch resource index from the page for debugging
  try {
    await page.evaluate(() => {
      /* noop: индекс ресурсов может быть опрошен вызывающей стороной при необходимости */
      return true;
    });
  } catch (e) {
    if (!QUIET) console.warn("Failed to contact page for resource index check");
  }

  // ждём, пока страница сообщит хотя бы один доступный ресурс (чтобы избежать кадров с fallback-ами)
  try {
    const start = Date.now();
    const timeoutMs = 8000;
    let haveAny = false;
    while (Date.now() - start < timeoutMs) {
      const idx = await page.evaluate(() => {
        try {
          return window.__renderer && window.__renderer.getResourceIndex
            ? window.__renderer.getResourceIndex()
            : null;
        } catch (e) {
          return null;
        }
      });
      if (idx) {
        const total =
          (idx.images?.length || 0) +
          (idx.logos?.length || 0) +
          (idx.videos?.length || 0);
        if (total > 0) {
          haveAny = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!haveAny) {
      if (!QUIET)
        console.warn(
          `→ timeout waiting for resources on page (${timeoutMs}ms). Rendering may show fallback frames.`
        );
    }
  } catch (e) {
    if (!QUIET)
      console.warn(
        "Error while waiting for page resource index:",
        e && e.message ? e.message : e
      );
  }

  // начинаем рендер

  // Прогрев: подготовить декодеры видео и отрендерить несколько кадров без сохранения,
  // чтобы избежать начальных подтормаживаний (нагрев декодеров, сетевые задержки, SwiftShader)
  if (warmFrames > 0) {
    // прогревочные кадры (не сохраняются)
    // попытаться воспроизвести/поставить на паузу видео на странице, чтобы прогреть декодеры
    await page.evaluate(async () => {
      const vids = Array.from(document.querySelectorAll("video"));
      for (const v of vids) {
        try {
          v.muted = true;
          // attempt to play briefly to force decoder warm-up
          const p = v.play();
          if (p && p.then) await p.catch(() => {});
          v.pause();
        } catch (e) {}
      }
    });
    // render warm-up frames (do not save them)
    for (let w = 0; w < warmFrames; w++) {
      const ms = Math.round((w * 1000) / fps);
      await page.evaluate((t) => window.__renderer.renderFrame(t), ms);
      // небольшая пауза, чтобы внутренние seek/paint для видео успели завершиться
      await new Promise((r) => setTimeout(r, 200));
      process.stdout.write(`\r   warm ${w + 1}/${warmFrames}`);
    }
    // warm-up done
  }

  for (let f = 0; f < totalFrames; f++) {
    const ms = Math.round((f * 1000) / fps);
    await page.evaluate((t) => window.__renderer.renderFrame(t), ms);
    // снимаем только canvas, чтобы исключить хромослойки
    const buf = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
    const fname = path.join(
      framesDir,
      `frame_${String(f).padStart(6, "0")}.png`
    );
    fs.writeFileSync(fname, buf);
    if (f % Math.max(1, Math.floor(fps)) === 0) {
      process.stdout.write(`\r   frame ${f + 1}/${totalFrames}`);
    }
  }
  process.stdout.write("\nFrames ready.\n");

  await browser.close();
  server.close();

  // собираем видео в ffmpeg
  const ff = [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(framesDir, "frame_%06d.png"),
  ];

  // если указана музыка: поддерживаем две формы в project.json
  // 1) audio.tracks = [ { id, src, offset, volumePercent } ]
  // 2) audio.music = { src, offset, gain }
  let haveAudio = false;

  if (Array.isArray(proj.audio?.tracks) && proj.audio.tracks.length > 0) {
    // несколько дорожек: добавить каждую как вход и собрать filter_complex с adelay и volume, затем amix
    haveAudio = true;
    const tracks = proj.audio.tracks;
    // add inputs for each track (note: first input (index 0) is the image sequence)
    for (const t of tracks) {
      if (/^https?:\/\//i.test(t.src)) {
        ff.push("-i", t.src);
      } else {
        // if src starts with '/' it is project-root-relative (e.g. /assets/...),
        // resolve it relative to the project.json directory by prefixing a dot
        const localPath = t.src.startsWith("/")
          ? path.resolve(path.dirname(projectPath), `.${t.src}`)
          : path.resolve(path.dirname(projectPath), t.src);
        ff.push("-i", localPath);
      }
    }

    // собрать filter_complex для входов 1..N (0 — кадры)
    const trackFilters = tracks
      .map((t, idx) => {
        const inIndex = idx + 1; // audio input index in ffmpeg
        const offsetMs = Math.round((t.offset || 0) * 1000);
        const volFrac =
          typeof t.volumePercent === "number"
            ? (Math.max(0, t.volumePercent) / 100).toFixed(6)
            : t.gain && typeof t.gain === "number"
            ? Math.pow(10, t.gain / 20).toFixed(6)
            : "1.000000";
        // после volume добавить apad для каждой дорожки, чтобы можно было смешать до длины проекта
        return `[${inIndex}:a]adelay=${offsetMs}|${offsetMs},volume=${volFrac},apad[a${idx}]`;
      })
      .join(";");

    const amixInputs = tracks.map((_, idx) => `[a${idx}]`).join("");
    // обрезать итоговый микс по длительности проекта (в секундах), чтобы избежать удлинения
    const projectDuration = totalSec; // seconds
    const filterComplex = `${trackFilters};${amixInputs}amix=inputs=${tracks.length}:normalize=0:duration=longest,atrim=0:${projectDuration}[out]`;

    // подключить complex filter и замапить видео (0) и смешанное аудио ([out])
    ff.push("-filter_complex", filterComplex);
    ff.push("-map", "0:v", "-map", "[out]");
  } else if (proj.audio?.music?.src) {
    // устаревшая одиночная музыка — сохраняем прежнее поведение
    haveAudio = true;
    const a = proj.audio.music;
    // смещение и громкость
    if (a.offset && a.offset > 0) {
      // -itsoffset влияет на следующий -i, поэтому добавляем его перед соответствующим входом
      ff.push("-itsoffset", String(a.offset));
    }
    if (/^https?:\/\//i.test(a.src)) {
      // удалённый URL: передать как есть в ffmpeg
      ff.push("-i", a.src);
    } else {
      const localPath = a.src.startsWith("/")
        ? path.resolve(path.dirname(projectPath), `.${a.src}`)
        : path.resolve(path.dirname(projectPath), a.src);
      ff.push("-i", localPath);
    }

    // фильтры: громкость (legacy gain in dB) and pad/trim to project duration
    const projectDuration = totalSec; // seconds
    const singleFilters = [];
    if (haveAudio && typeof a.gain === "number") {
      singleFilters.push(`volume=${Math.pow(10, a.gain / 20).toFixed(3)}`);
    }
    // pad аудио и обрезать по длительности проекта
    singleFilters.push("apad");
    singleFilters.push(`atrim=0:${projectDuration}`);
    if (singleFilters.length) {
      ff.push(
        "-filter_complex",
        `[0:v]null[v];[1:a]${singleFilters.join(",")}[out]`
      );
      ff.push("-map", "[v]", "-map", "[out]");
    }
  }

  ff.push(
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-crf",
    "18",
    "-preset",
    "medium"
  );

  if (haveAudio) {
    ff.push("-c:a", "aac", "-b:a", "192k");
  } else {
    // no audio tracks: add a silent audio input so output contains silence of project duration
    // insert lavfi anullsrc as an additional input (it will become input index 1)
    ff.push(
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100"
    );
    // map video (0:v) and the silent audio (1:a)
    ff.push("-map", "0:v", "-map", "1:a");
    ff.push("-c:a", "aac", "-b:a", "192k");
  }

  // Если есть аудио, убедиться что ffmpeg остановится на самом коротком входе (рендерные кадры)
  // чтобы более длинный аудиофайл не удлинял итоговое видео сверх заданной длительности.
  if (haveAudio) {
    ff.push("-shortest");
  }

  ff.push(outPath);

  // ffmpeg command assembled
  await execFFmpeg(ff);
  console.log(`MP4 written: ${outPath}`);
  // prefetch удалён — нечего чистить
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function execFFmpeg(args) {
  return new Promise((res, rej) => {
    const p = spawn("ffmpeg", args, { stdio: "inherit" });
    p.on("exit", (code) =>
      code === 0 ? res() : rej(new Error("ffmpeg exit " + code))
    );
  });
}
