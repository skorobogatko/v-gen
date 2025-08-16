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
  .option("--fps <n>", "frames per second", "30")
  .option("--w <n>", "width", "1920")
  .option("--h <n>", "height", "1080")
  .option("--warm <n>", "warm-up frames to render (skip saving)", "5")
  .option(
    "--prefetch",
    "enable prefetching of remote assets into .prefetch (off by default)",
    false
  )
  .parse(process.argv);

const opts = program.opts();

const projectPath = path.resolve(__dirname, "..", opts.in);
const outPath = path.resolve(__dirname, "..", opts.out);
const framesDir = path.resolve(path.dirname(outPath), "frames");

const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

(async () => {
  const proj = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
  const fps = parseInt(opts.fps, 10);
  const width = parseInt(opts.w, 10);
  const height = parseInt(opts.h, 10);
  const warmFrames = Math.max(0, parseInt(opts.warm || "0", 10));

  // нормализуем размер
  proj.project.width = width;
  proj.project.height = height;
  proj.project.fps = fps;

  // длительность по последней сцене
  const totalSec = Math.max(...proj.videoTrack.map((s) => s.end), 0);
  const totalFrames = Math.ceil(totalSec * fps);

  ensureDir(path.dirname(outPath));
  ensureDir(framesDir);

  const projectRoot = path.resolve(__dirname, "..");

  // --- Prefetch remote assets into projectRoot/.prefetch to avoid network/CORS issues
  const prefetchDir = path.join(projectRoot, ".prefetch");
  let didPrefetch = false;
  // download a URL into prefetchDir using destBase (hash without ext).
  // Returns the final filename (with extension if inferred).
  async function downloadToFile(url, destBase) {
    return new Promise((resolve, reject) => {
      try {
        const u = new URL(url);
        const get = u.protocol === "https:" ? https.get : http.get;
        const req = get(u.href, (res) => {
          if (res.statusCode >= 400) {
            reject(new Error(`download ${url} failed: ${res.statusCode}`));
            return;
          }

          // try to infer extension: prefer path ext, otherwise content-type
          const urlExt = path.extname(u.pathname) || "";
          let ext = urlExt;
          if (!ext) {
            const ct = (res.headers["content-type"] || "").toLowerCase();
            if (ct.includes("jpeg") || ct.includes("jpg")) ext = ".jpg";
            else if (ct.includes("png")) ext = ".png";
            else if (ct.includes("gif")) ext = ".gif";
            else if (ct.includes("svg")) ext = ".svg";
            else if (ct.includes("webm")) ext = ".webm";
            else if (ct.includes("mp4")) ext = ".mp4";
            else if (
              ct.includes("mpeg") ||
              ct.includes("mp3") ||
              ct.includes("audio")
            )
              ext = ".mp3";
            else if (ct.includes("ogg")) ext = ".ogg";
            else ext = "";
          }

          const finalName = ext
            ? `${path.basename(destBase)}${ext}`
            : path.basename(destBase);
          const dest = path.join(path.dirname(destBase), finalName);
          const tmp = dest + ".tmp";

          // write to a temp file first, then rename
          const file = fs.createWriteStream(tmp);
          res.pipe(file);
          file.on("finish", () =>
            file.close(() => {
              try {
                fs.renameSync(tmp, dest);
                resolve(finalName);
              } catch (e) {
                // fallback: if rename fails, try to unlink tmp and reject
                try {
                  fs.unlinkSync(tmp);
                } catch (e2) {}
                reject(e);
              }
            })
          );
          file.on("error", (err) => {
            try {
              fs.unlinkSync(tmp);
            } catch (e) {}
            reject(err);
          });
        });
        req.on("error", reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  async function prefetchProjectAssets(projObj) {
    const urls = new Map();
    const collect = (s) => {
      if (!s) return;
      if (/^https?:\/\//i.test(s)) urls.set(s, null);
    };

    for (const sc of projObj.videoTrack || []) {
      for (const o of sc.objects || []) {
        collect(o.src);
      }
    }
    for (const ov of projObj.overlays || []) {
      collect(ov.src);
    }
    if (projObj.audio?.music?.src) collect(projObj.audio.music.src);

    if (!urls.size) return false;

    ensureDir(prefetchDir);

    for (const url of urls.keys()) {
      try {
        const hash = crypto
          .createHash("sha1")
          .update(url)
          .digest("hex")
          .slice(0, 12);
        const destBase = path.join(prefetchDir, hash);

        // if there's already a file that starts with the hash, reuse it
        let existing = fs
          .readdirSync(prefetchDir)
          .find((f) => f.startsWith(hash));
        if (existing) {
          const fp = path.join(prefetchDir, existing);
          try {
            const st = fs.statSync(fp);
            if (!st.isFile() || st.size < 16) {
              // corrupted/empty, try re-download
              try {
                fs.unlinkSync(fp);
              } catch (e) {}
              existing = null;
            } else {
              // if the cached name lacks an extension, try to infer one and rename
              const curExt = path.extname(existing);
              if (!curExt) {
                try {
                  const h = fs.openSync(fp, "r");
                  const buf = Buffer.alloc(16);
                  fs.readSync(h, buf, 0, 16, 0);
                  fs.closeSync(h);
                  let inferred = "";
                  if (
                    buf[0] === 0x89 &&
                    buf[1] === 0x50 &&
                    buf[2] === 0x4e &&
                    buf[3] === 0x47
                  )
                    inferred = ".png";
                  else if (
                    buf[0] === 0xff &&
                    buf[1] === 0xd8 &&
                    buf[2] === 0xff
                  )
                    inferred = ".jpg";
                  else if (buf.slice(4, 8).toString() === "ftyp")
                    inferred = ".mp4";
                  else if (buf.slice(0, 3).toString() === "ID3")
                    inferred = ".mp3";
                  else if (
                    buf[0] === 0x1a &&
                    buf[1] === 0x45 &&
                    buf[2] === 0xdf &&
                    buf[3] === 0xa3
                  )
                    inferred = ".webm";
                  if (inferred) {
                    const newName = `${existing}${inferred}`;
                    const newPath = path.join(prefetchDir, newName);
                    try {
                      fs.renameSync(fp, newPath);
                      existing = newName;
                    } catch (e) {
                      // ignore rename failure, keep existing
                    }
                  }
                } catch (e) {
                  // ignore inference errors
                }
              }
              urls.set(url, `/.prefetch/${existing}`);
              continue;
            }
          } catch (e) {
            existing = null;
          }
        }
        const finalName = await downloadToFile(url, destBase);
        if (!finalName) {
          console.warn(`Prefetch produced no file for ${url}`);
          urls.set(url, null);
          continue;
        }
        urls.set(url, `/.prefetch/${finalName}`);
      } catch (err) {
        console.warn(
          `Prefetch failed for ${url}:`,
          err && err.message ? err.message : err
        );
        urls.set(url, null);
      }
    }

    // rewrite proj references to local prefetch paths when available
    const replaceIfPrefetched = (s) => (urls.get(s) ? urls.get(s) : s);
    for (const sc of projObj.videoTrack || []) {
      for (const o of sc.objects || []) {
        if (o && typeof o.src === "string") o.src = replaceIfPrefetched(o.src);
      }
    }
    for (const ov of projObj.overlays || []) {
      if (ov && typeof ov.src === "string")
        ov.src = replaceIfPrefetched(ov.src);
    }
    if (projObj.audio?.music?.src) {
      const s = projObj.audio.music.src;
      if (urls.get(s)) projObj.audio.music.src = urls.get(s);
    }

    // normalize any files in prefetch dir that lack extensions: try to infer from magic bytes
    try {
      const prefFiles = fs.readdirSync(prefetchDir);
      for (const f of prefFiles) {
        const ext = path.extname(f);
        if (ext) continue; // has extension
        const fp = path.join(prefetchDir, f);
        try {
          const h = fs.openSync(fp, "r");
          const buf = Buffer.alloc(16);
          fs.readSync(h, buf, 0, 16, 0);
          fs.closeSync(h);
          let inferred = "";
          // PNG: 89 50 4E 47
          if (
            buf[0] === 0x89 &&
            buf[1] === 0x50 &&
            buf[2] === 0x4e &&
            buf[3] === 0x47
          )
            inferred = ".png";
          // JPG: FF D8 FF
          else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
            inferred = ".jpg";
          // MP4/ISOM: 'ftyp' at offset 4
          else if (buf.slice(4, 8).toString() === "ftyp") inferred = ".mp4";
          // MP3: ID3
          else if (buf.slice(0, 3).toString() === "ID3") inferred = ".mp3";
          // WEBM: 1A 45 DF A3
          else if (
            buf[0] === 0x1a &&
            buf[1] === 0x45 &&
            buf[2] === 0xdf &&
            buf[3] === 0xa3
          )
            inferred = ".webm";

          if (inferred) {
            const newName = `${f}${inferred}`;
            const newPath = path.join(prefetchDir, newName);
            try {
              fs.renameSync(fp, newPath);
              // update any mapping in urls if present
              for (const [k, v] of urls.entries()) {
                if (v === `/.prefetch/${f}`)
                  urls.set(k, `/.prefetch/${newName}`);
              }
            } catch (e) {}
          }
        } catch (e) {
          // ignore per-file errors
        }
      }
    } catch (e) {
      // ignore normalization errors
    }

    return true;
  }

  // prefetch is optional; keep disabled by default to preserve previous behavior
  if (opts.prefetch) {
    try {
      didPrefetch = await prefetchProjectAssets(proj);
    } catch (err) {
      console.warn(
        "Prefetch step failed:",
        err && err.message ? err.message : err
      );
      didPrefetch = false;
    }
  } else {
    didPrefetch = false;
  }

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

  // если указана музыка
  let haveAudio = false;
  if (proj.audio?.music?.src) {
    haveAudio = true;
    const a = proj.audio.music;
    // смещение и громкость
    if (a.offset && a.offset > 0) {
      // -itsoffset affects the next -i, so add before the input
      ff.push("-itsoffset", String(a.offset));
    }
    if (typeof a.src === "string" && a.src.startsWith("/.prefetch/")) {
      // prefetched into projectRoot/.prefetch — give ffmpeg the real filesystem path
      const local = path.join(projectRoot, a.src.slice(1));
      ff.push("-i", local);
    } else if (/^https?:\/\//i.test(a.src)) {
      ff.push("-i", a.src);
    } else {
      ff.push("-i", path.resolve(path.dirname(projectPath), a.src));
    }
  }

  // фильтры: громкость
  const filters = [];
  if (haveAudio && typeof proj.audio.music.gain === "number") {
    filters.push(
      `volume=${Math.pow(10, proj.audio.music.gain / 20).toFixed(3)}`
    );
  }

  if (haveAudio && filters.length) {
    ff.push("-filter:a", filters.join(","));
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
    ff.push("-an");
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
  // cleanup prefetch directory if we created it
  if (didPrefetch) {
    try {
      // remove files then directory
      const files = fs.readdirSync(prefetchDir);
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(prefetchDir, f));
        } catch (e) {}
      }
      fs.rmdirSync(prefetchDir);
    } catch (e) {
      console.warn(
        `Failed to clean prefetch dir: ${e && e.message ? e.message : e}`
      );
    }
  }
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
