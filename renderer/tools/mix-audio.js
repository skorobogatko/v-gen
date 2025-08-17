#!/usr/bin/env node
import fs from "fs";
import path from "path";

// tools/mix-audio.js
// ==================
// Небольшой CLI-скрипт для генерации команды ffmpeg, которая смешивает несколько
// аудиотреков из project.json в один файл. Этот скрипт полезен при отладке смешивания
// аудио локально (вне основного рендера).

// Преобразует децибелы в процент (0..100)
function dbToPercent(db) {
  return Math.pow(10, db / 20) * 100;
}

// Преобразует процент в дробь, отформатированную для ffmpeg (6 знаков после запятой)
function percentToFrac(p) {
  return (Math.max(0, p) / 100).toFixed(6);
}

// Если путь до project.json передан как аргумент — используем его, иначе берем ./project.json
const projectPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve("./project.json");
const QUIET = true;

if (!fs.existsSync(projectPath)) {
  if (!QUIET) console.error("project.json not found at", projectPath);
  process.exit(2);
}

const pj = JSON.parse(fs.readFileSync(projectPath, "utf8"));
const audioDef = pj.audio || {};
let defs = [];

// Поддерживаем две формы описания аудио в проекте: tracks (новая) и music (устаревшая)
if (Array.isArray(audioDef.tracks)) {
  defs = audioDef.tracks.map((t, i) => ({
    src: t.src,
    offset: t.offset || 0,
    volFrac:
      typeof t.volumePercent === "number"
        ? percentToFrac(t.volumePercent)
        : "1.000000",
  }));
} else if (audioDef.music && audioDef.music.src) {
  const m = audioDef.music;
  let vp = 100;
  if (typeof m.volumePercent === "number") vp = m.volumePercent;
  else if (typeof m.gain === "number") vp = dbToPercent(m.gain);
  defs = [{ src: m.src, offset: m.offset || 0, volFrac: percentToFrac(vp) }];
}

if (defs.length === 0) {
  if (!QUIET) console.error("No audio tracks found in project.json");
  process.exit(3);
}

// Собираем команду ffmpeg: входы (-i) + filter_complex с adelay/volume и amix
const inputs = defs.map((d) => `-i "${d.src}"`).join(" ");
const filters = defs
  .map(
    (d, idx) =>
      `[${idx}:a]adelay=${Math.round(d.offset * 1000)}|${Math.round(
        d.offset * 1000
      )},volume=${d.volFrac}[a${idx}]`
  )
  .join(";");
const amixInputs = defs.map((_, idx) => `[a${idx}]`).join("");
const filterComplex = `${filters};${amixInputs}amix=inputs=${defs.length}:normalize=0:duration=longest[out]`;

const cmd = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[out]" -c:a aac out_mixed.mp3`;
if (!QUIET) console.log(cmd);
