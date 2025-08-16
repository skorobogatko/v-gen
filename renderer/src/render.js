// render.js
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

const program = new Command();
program
  .requiredOption("--in <file>", "project json")
  .requiredOption("--out <file>", "output mp4")
  .option("--fps <n>", "frames per second")
  .option("--w <n>", "width")
  .option("--h <n>", "height")
  .option("--warm <n>", "warm-up frames to render (skip saving)")
  // prefetch option removed — assets are expected to be reachable by URL or project-local paths
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

  const projectRoot = path.resolve(__dirname, "..");

  // prefetch functionality removed: assets are used directly from URLs or project-local paths

  // prefetch removed — no action taken

  // start a small static server serving project root so ES modules load over HTTP
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(
        new URL(req.url, `http://localhost`).pathname
      );
      // default to /src/page.html when requesting /
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
        // if file has no extension or unknown type, try to sniff magic bytes
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
        // allow CORS for crossOrigin='anonymous' loads
        res.writeHead(200, {
          "Content-Type": ct,
          "Access-Control-Allow-Origin": "*",
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
    console.error(
      "[Puppeteer Launch Error]",
      err && err.message ? err.message : err
    );
    throw err;
  }

  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  // Проксируем сообщения консоли браузера в терминал Node.js
  page.on("console", (msg) => {
    const args = msg.args();
    Promise.all(args.map((a) => a.jsonValue())).then((vals) => {
      console.log(`[browser]`, msg.type(), ...vals);
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

  // ждём инициализации рендера
  await page.waitForFunction("window.__renderer && true", { timeout: 10000 });

  // fetch resource index from the page for debugging
  try {
    await page.evaluate(() => {
      /* noop: resource index can be polled by caller if needed */
      return true;
    });
  } catch (e) {
    console.warn("Failed to contact page for resource index check");
  }

  // wait until the page reports at least one available resource (to avoid fallback frames)
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
      console.warn(
        `→ timeout waiting for resources on page (${timeoutMs}ms). Rendering may show fallback frames.`
      );
    }
  } catch (e) {
    console.warn(
      "Error while waiting for page resource index:",
      e && e.message ? e.message : e
    );
  }

  // starting render

  // Warm-up: prime video decoders and render a few frames without saving to
  // avoid initial stutter (network/video decoder warm-up, SwiftShader)
  if (warmFrames > 0) {
    // warm-up frames (not saved)
    // try to play/pause videos in page to prime decoders
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
      // small wait to allow internal video seeks/paints to settle
      await new Promise((r) => setTimeout(r, 40));
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
  console.log("\n✔ Frames ready.");

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
    // multiple tracks: add each as input and build a filter_complex that applies adelay and volume, then amix
    haveAudio = true;
    const tracks = proj.audio.tracks;
    // add inputs for each track (note: first input (index 0) is the image sequence)
    for (const t of tracks) {
      if (/^https?:\/\//i.test(t.src)) {
        ff.push("-i", t.src);
      } else {
        ff.push("-i", path.resolve(path.dirname(projectPath), t.src));
      }
    }

    // build filter_complex: for inputs 1..N (because 0 is frames)
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
        // after volume, pad each track so it can be mixed to project length
        return `[${inIndex}:a]adelay=${offsetMs}|${offsetMs},volume=${volFrac},apad[a${idx}]`;
      })
      .join(";");

    const amixInputs = tracks.map((_, idx) => `[a${idx}]`).join("");
    // trim final mixed audio to project duration (in seconds) to avoid longer audio
    const projectDuration = totalSec; // seconds
    const filterComplex = `${trackFilters};${amixInputs}amix=inputs=${tracks.length}:normalize=0:duration=longest,atrim=0:${projectDuration}[out]`;

    // attach complex filter and map video (0) and mixed audio ([out])
    ff.push("-filter_complex", filterComplex);
    ff.push("-map", "0:v", "-map", "[out]");
  } else if (proj.audio?.music?.src) {
    // legacy single music entry — keep old behaviour
    haveAudio = true;
    const a = proj.audio.music;
    // смещение и громкость
    if (a.offset && a.offset > 0) {
      // -itsoffset affects the next -i, so add before the input
      ff.push("-itsoffset", String(a.offset));
    }
    if (/^https?:\/\//i.test(a.src)) {
      // remote URL: pass as-is to ffmpeg
      ff.push("-i", a.src);
    } else {
      // local path relative to project JSON
      ff.push("-i", path.resolve(path.dirname(projectPath), a.src));
    }

    // фильтры: громкость (legacy gain in dB) and pad/trim to project duration
    const projectDuration = totalSec; // seconds
    const singleFilters = [];
    if (haveAudio && typeof a.gain === "number") {
      singleFilters.push(`volume=${Math.pow(10, a.gain / 20).toFixed(3)}`);
    }
    // pad audio and trim to project duration
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

  // If audio is present, ensure ffmpeg stops at the shortest input (the rendered frames)
  // so a longer audio file doesn't extend the final video past the intended project duration.
  if (haveAudio) {
    ff.push("-shortest");
  }

  ff.push(outPath);

  console.log("→ ffmpeg:", ff.join(" "));
  await execFFmpeg(ff);
  console.log(`✔ MP4 written: ${outPath}`);
  // prefetch removed — nothing to clean up
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
