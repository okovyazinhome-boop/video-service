const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  console.warn(`[smart-focus] sharp is not available: ${error.message}`);
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const BASE_URL = process.env.BASE_URL || 'https://video.uraltrackpro.ru';

const jobs = new Map();

const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 2;
const JOB_TTL_MS = Number(process.env.JOB_TTL_HOURS || 24) * 60 * 60 * 1000;
let activeJobs = 0;

// Автоочистка завершённых задач и файлов (каждые 15 минут)
setInterval(async () => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (['done', 'fail'].includes(job.status) &&
        (now - new Date(job.createdAt).getTime()) > JOB_TTL_MS) {
      await fs.remove(path.join('storage', 'jobs', jobId)).catch(() => {});
      await fs.remove(path.join('storage', 'output', `${jobId}.mp4`)).catch(() => {});
      await fs.remove(path.join('storage', 'output', `${jobId}.jpg`)).catch(() => {});
      jobs.delete(jobId);
      console.log(`[TTL] Cleaned up job ${jobId}`);
    }
  }
}, 15 * 60 * 1000);

async function sendWebhook(job) {
  if (!job.payload.webhookUrl) return;
  try {
    await axios.post(job.payload.webhookUrl, {
      jobId: job.jobId,
      status: job.status,
      videoUrl: job.videoUrl || null,
      thumbnailUrl: job.thumbnailUrl || null,
      error: job.error || null
    }, { timeout: 10000 });
  } catch (e) {
    console.error(`Webhook failed for job ${job.jobId}:`, e.message);
  }
}

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '50mb' }));

fs.ensureDirSync('storage/jobs');
fs.ensureDirSync('storage/temp');
fs.ensureDirSync('storage/output');
fs.ensureDirSync('storage/fonts');

app.use('/output', express.static(path.join(process.cwd(), 'storage/output')));

function authMiddleware(req, res, next) {
  if (!API_KEY) return next();

  const authHeader = req.headers.authorization || '';
  const expected = `Bearer ${API_KEY}`;

  if (authHeader !== expected) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  next();
}

function getExtFromUrl(fileUrl, fallback) {
  try {
    const urlObj = new URL(fileUrl);
    const ext = path.extname(urlObj.pathname);
    return ext || fallback;
  } catch (e) {
    return fallback;
  }
}

function parseResolution(resolution) {
  const fallback = { width: 1080, height: 1920 };

  if (!resolution || typeof resolution !== 'string') {
    return fallback;
  }

  const match = resolution.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    return fallback;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return fallback;
  }

  return { width, height };
}

function parseFps(fps) {
  const allowed = [24, 25, 30, 50, 60];
  const parsed = Number(fps);
  return allowed.includes(parsed) ? parsed : 25;
}

function getResolutionFromFormat({ videoPreset, orientation, quality, resolution }) {
  const presets = {
    reels_1080_30: { orientation: '9:16', quality: 'full-hd' },
    reels_1080_60: { orientation: '9:16', quality: 'full-hd' },
    reels_2k_30: { orientation: '9:16', quality: '2k' },
    youtube_2k_30: { orientation: '16:9', quality: '2k' },
    square_1080_30: { orientation: '1:1', quality: 'full-hd' }
  };

  const preset = presets[String(videoPreset || '').trim()];
  const finalOrientation = String(orientation || preset?.orientation || '').trim() || null;
  const finalQuality = String(quality || preset?.quality || '').trim() || null;

  if (finalOrientation && finalQuality) {
    const byQuality = {
      'full-hd': {
        '9:16': { width: 1080, height: 1920 },
        '16:9': { width: 1920, height: 1080 },
        '1:1': { width: 1080, height: 1080 }
      },
      '2k': {
        '9:16': { width: 1440, height: 2560 },
        '16:9': { width: 2560, height: 1440 },
        '1:1': { width: 1440, height: 1440 }
      }
    };

    const found = byQuality[finalQuality]?.[finalOrientation];
    if (found) return found;
  }

  return parseResolution(resolution);
}

function parseVideoSettings(payload = {}) {
  const videoSettings = payload.videoSettings || {};
  const videoPreset = payload.videoPreset || videoSettings.videoPreset;
  const presetFps = {
    reels_1080_30: 30,
    reels_1080_60: 60,
    reels_2k_30: 30,
    youtube_2k_30: 30,
    square_1080_30: 30
  }[String(videoPreset || '').trim()];

  const resolution = getResolutionFromFormat({
    videoPreset,
    orientation: payload.orientation || videoSettings.orientation,
    quality: payload.quality || videoSettings.quality,
    resolution: payload.resolution || videoSettings.resolution
  });

  return {
    ...resolution,
    fps: parseFps(payload.fps || videoSettings.fps || presetFps),
    bitratePreset: String(payload.bitratePreset || videoSettings.bitratePreset || 'standard').trim(),
    cleanMetadata: payload.cleanMetadata !== false && videoSettings.cleanMetadata !== false
  };
}

function getVideoBitrate(width, height, fps, bitratePreset = 'standard') {
  const pixels = width * height;
  const fpsMultiplier = fps >= 50 ? 1.35 : 1;
  const qualityMultiplier = {
    fast: 0.75,
    standard: 1,
    high: 1.45,
    ultra: 1.9
  }[String(bitratePreset || 'standard')] || 1;

  const baseMbps = pixels >= 2560 * 1440 ? 14 : pixels >= 1920 * 1080 ? 8 : 5;
  return `${Math.round(baseMbps * fpsMultiplier * qualityMultiplier)}M`;
}

async function downloadToFile(fileUrl, outputPath) {
  const response = await axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
    timeout: 120000
  });

  await fs.ensureDir(path.dirname(outputPath));

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `${command} exited with code ${code}`));
      }
    });
  });
}

function runFfmpeg(args, options = {}) {
  return runCommand('ffmpeg', args, options);
}

async function getMediaDuration(filePath) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);

  const duration = Number(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Failed to get media duration for ${filePath}`);
  }

  return duration;
}

// Только переходы, поддерживаемые FFmpeg 5.x (Debian 12)
// coverleft/coverright/coverup/coverdown/revealleft/revealright/squeezeh/squeezev — только FFmpeg 6+
const ALLOWED_TRANSITIONS = [
  'fade', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'zoomin', 'fadeblack', 'fadewhite', 'dissolve', 'pixelize',
  'circleopen', 'circleclose', 'radial',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'wipetl', 'wipetr', 'wipebl', 'wipebr',
  'diagtl', 'diagtr', 'diagbl', 'diagbr',
  'hblur', 'fadegrays', 'fadefast', 'fadeslow',
  'hlslice', 'hrslice', 'vuslice', 'vdslice',
  'vertopen', 'vertclose', 'horzopen', 'horzclose',
  'circlecrop', 'rectcrop', 'distance', 'squeezeh', 'squeezev'
];

const CURATED_RANDOM_TRANSITIONS = [
  'fade',
  'hblur',
  'smoothleft',
  'smoothright',
  'dissolve'
];

function getAllowedTransition(transitionType) {
  if (transitionType === 'random') {
    // Возвращаем 'random' — конкретный переход будет выбираться для каждой сцены отдельно
    return 'random';
  }
  return ALLOWED_TRANSITIONS.includes(transitionType) ? transitionType : 'fade';
}

function getRandomTransition() {
  return CURATED_RANDOM_TRANSITIONS[Math.floor(Math.random() * CURATED_RANDOM_TRANSITIONS.length)];
}

function guessMediaTypeFromUrl(fileUrl = '') {
  try {
    const ext = path.extname(new URL(fileUrl).pathname).toLowerCase();

    const videoExts = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
    const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];

    if (videoExts.includes(ext)) return 'video';
    if (imageExts.includes(ext)) return 'image';

    return 'image';
  } catch (e) {
    return 'image';
  }
}

function parseOptionalPositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeMotionSettings(item = {}) {
  const motion = item.motionSettings || item.motion || {};
  const motionMode = String(item.motionMode || '').trim().toLowerCase();
  const rawZoomPercent = Number(item.zoomPercent ?? motion.zoomPercent ?? 20);
  const motionType = motionMode === 'custom'
    ? (item.motionType || motion.type || 'smooth-in')
    : motionMode || item.motionType || motion.type || motion.motionType || 'auto';
  const rawZoomInPercent = Number(item.zoomInPercent ?? motion.zoomInPercent ?? 20);
  const rawZoomOutPercent = Number(item.zoomOutPercent ?? motion.zoomOutPercent ?? 35);
  return {
    type: String(motionType).trim().toLowerCase(),
    zoomPercent: Number.isFinite(rawZoomPercent) ? Math.min(300, Math.max(0, rawZoomPercent)) : 20,
    zoomInPercent: Number.isFinite(rawZoomInPercent) ? Math.min(300, Math.max(0, rawZoomInPercent)) : 20,
    zoomOutPercent: Number.isFinite(rawZoomOutPercent) ? Math.min(300, Math.max(0, rawZoomOutPercent)) : 35,
    zoomAt: parseOptionalPositiveNumber(item.zoomAt ?? motion.zoomAt),
    direction: String(item.motionDirection || item.direction || motion.direction || motion.motionDirection || 'center').trim().toLowerCase(),
    pattern: String(item.motionPattern || motion.pattern || motion.motionPattern || 'alternate').trim().toLowerCase(),
    strength: String(item.motionStrength || motion.strength || motion.motionStrength || 'balanced').trim().toLowerCase()
  };
}

function normalizeOverlayStyle(item = {}) {
  const caption = item.overlayCaption || item.caption || item;
  return caption.style || caption || item.overlayStyle || item.captionStyle || item.overlaySettings || {};
}

function normalizeVideoBehavior(item = {}) {
  const value = String(item.videoBehavior || item.videoMode || 'clip').trim().toLowerCase();
  if (['loop', 'freeze', 'clip'].includes(value)) return value;
  if (value === 'trim' || value === 'trim-to-source' || value === 'source') return 'clip';
  return 'clip';
}

function normalizeMediaItems(payload = {}) {
  const sourceItems = Array.isArray(payload.frames) && payload.frames.length > 0
    ? payload.frames
    : Array.isArray(payload.media) && payload.media.length > 0
    ? payload.media
    : Array.isArray(payload.images) && payload.images.length > 0
    ? payload.images
    : [];

  if (sourceItems.length > 0) {
    return sourceItems
      .filter((item) => typeof item === 'string' || (item && (item.url || item.fileUrl)))
      .map((item) => {
        if (typeof item === 'string') {
          return {
            type: guessMediaTypeFromUrl(item),
            url: item,
            narrationText: '',
            sceneRole: '',
            overlayText: '',
            durationSeconds: null,
            overlayStyle: {},
            motionSettings: normalizeMotionSettings({}),
            videoBehavior: 'clip'
          };
        }
        const url = item.url || item.fileUrl || item;
        return {
        type: item.type || guessMediaTypeFromUrl(url || ''),
        url,
        narrationText: String(item.narrationText || '').trim(),
        sceneRole: String(item.sceneRole || '').trim(),
        overlayText: String(
          item.captionMode === 'off'
            ? ''
            : item.overlayText ||
              item.captionText ||
              item.overlayCaption?.text ||
              item.overlayCaption?.captionText ||
              item.caption?.text ||
              ''
        ).trim(),
          durationSeconds: parseOptionalPositiveNumber(item.durationSeconds ?? item.duration ?? item.sceneDuration),
          overlayStyle: normalizeOverlayStyle(item),
          motionSettings: normalizeMotionSettings(item),
          videoBehavior: normalizeVideoBehavior(item)
        };
      });
  }

  return [];
}

function normalizeMergeItems(payload = {}) {
  const sourceItems = Array.isArray(payload.videos) && payload.videos.length > 0
    ? payload.videos
    : Array.isArray(payload.videoUrls) && payload.videoUrls.length > 0
    ? payload.videoUrls
    : [];

  return sourceItems
    .filter((item) => typeof item === 'string' || (item && (item.url || item.videoUrl)))
    .map((item) => {
      if (typeof item === 'string') {
        return { url: item };
      }
      return { url: item.url || item.videoUrl };
    });
}

function formatAssTime(seconds) {
  const totalCs = Math.max(0, Math.round(Number(seconds || 0) * 100));
  const hours = Math.floor(totalCs / 360000);
  const minutes = Math.floor((totalCs % 360000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const centis = totalCs % 100;

  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function assColorFromHex(hex, fallback = '&H00FFFFFF') {
  if (!hex || typeof hex !== 'string') return fallback;

  const normalized = hex.trim().replace('#', '');

  if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
    const r = normalized[0] + normalized[0];
    const g = normalized[1] + normalized[1];
    const b = normalized[2] + normalized[2];
    return `&H00${b}${g}${r}`.toUpperCase();
  }

  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return fallback;

  const r = normalized.slice(0, 2);
  const g = normalized.slice(2, 4);
  const b = normalized.slice(4, 6);

  return `&H00${b}${g}${r}`.toUpperCase();
}

function parseKeywordsFromText(text) {
  const keywords = new Set();
  const cleanText = stripSubtitleMarkup(String(text || '')).replace(/\*([^*]+)\*/g, (_, word) => {
    // Очищаем от пунктуации для корректного сравнения с токенами
    const cleaned = word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();
    if (cleaned) keywords.add(cleaned);
    return word; // убираем звёздочки, слово остаётся
  });
  return { cleanText, keywords };
}

function stripSubtitleMarkup(text) {
  return String(text || '')
    .replace(/\[\/?emphasized\]/gi, '')
    .replace(/\[\/?emphasis\]/gi, '')
    .replace(/\[[^\]\r\n]*\]/g, ' ')
    .replace(/(^|\s)\[[^\s\r\n]*/g, ' ')
    .replace(/[^\s\r\n]*\](?=\s|$)/g, ' ')
    .replace(/<\/?emphasis[^>]*>/gi, '')
    .replace(/<\/?prosody[^>]*>/gi, '')
    .replace(/<break[^>]*\/?>/gi, ' ')
    .replace(/<\/?speak[^>]*>/gi, '');
}

function sanitizeAssText(text) {
  return stripSubtitleMarkup(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function tokenizeSubtitleText(text) {
  return sanitizeAssText(text).replace(/\n+/g, ' ').split(' ').filter(Boolean);
}

function normalizeSubtitleTokenForMatch(text) {
  return sanitizeAssText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function normalizeSubtitleTermKey(text) {
  return sanitizeAssText(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

const SINGLE_SUBTITLE_TERMS = {
  'эсказэи': 'СКЗИ',
  'скзи': 'СКЗИ',
  'джипиэс': 'GPS',
  'gps': 'GPS',
  'джипиэрэс': 'GPRS',
  'gprs': 'GPRS',
  'ютиси': 'UTC',
  'utc': 'UTC',
  'тэа001': 'ТА 001',
  'та001': 'ТА 001',
  'энкаэм': 'НКМ',
  'нкм': 'НКМ',
  'еэстээр': 'ЕСТР',
  'естр': 'ЕСТР',
  'глонасс': 'ГЛОНАСС',
  'гибдд': 'ГИБДД',
  'паккод': 'PUK-код',
  'пуккод': 'PUK-код',
  'pukкод': 'PUK-код',
  'пинкод': 'PIN-код',
  'pinкод': 'PIN-код',
  'виалон': 'Wialon',
  'wialon': 'Wialon',
  'омникомм': 'Omnicomm',
  'omnicomm': 'Omnicomm',
  'экодрайвинг': 'EcoDriving',
  'ecodriving': 'EcoDriving',
  'фат32': 'FAT32',
  'фаттридцатьдва': 'FAT32',
  'гигабайт': 'ГБ',
  'миллиметров': 'мм',
  'километроввчас': 'км/ч',
  'рублейвмесяц': 'рублей/мес'
};

const SEQUENCE_SUBTITLE_TERMS = [
  { keys: ['эс', 'ка', 'зэ', 'и'], text: 'СКЗИ' },
  { keys: ['джи', 'пи', 'эс'], text: 'GPS' },
  { keys: ['джи', 'пи', 'эр', 'эс'], text: 'GPRS' },
  { keys: ['ю', 'ти', 'си'], text: 'UTC' },
  { keys: ['эн', 'ка', 'эм'], text: 'НКМ' },
  { keys: ['е', 'эс', 'тэ', 'эр'], text: 'ЕСТР' },
  { keys: ['тэ', 'а', '001'], text: 'ТА 001' },
  { keys: ['та', '001'], text: 'ТА 001' },
  { keys: ['та', 'ноль', 'ноль', 'один'], text: 'ТА 001' },
  { keys: ['тэ', 'а', 'ноль', 'ноль', 'один'], text: 'ТА 001' },
  { keys: ['пак', 'код'], text: 'PUK-код' },
  { keys: ['пук', 'код'], text: 'PUK-код' },
  { keys: ['puk', 'код'], text: 'PUK-код' },
  { keys: ['пин', 'код'], text: 'PIN-код' },
  { keys: ['pin', 'код'], text: 'PIN-код' },
  { keys: ['файловая', 'система', 'фат', 'тридцать', 'два'], text: 'FAT32' },
  { keys: ['фат', 'тридцать', 'два'], text: 'FAT32' },
  { keys: ['километров', 'в', 'час'], text: 'км/ч' },
  { keys: ['рублей', 'в', 'месяц'], text: 'рублей/мес' }
];

function normalizeSpokenSubtitleTerms(timings = []) {
  const result = [];

  for (let i = 0; i < timings.length; i++) {
    const keys = timings.slice(i, i + 5).map((item) => normalizeSubtitleTermKey(item.text));
    const sequence = SEQUENCE_SUBTITLE_TERMS.find((entry) =>
      entry.keys.every((key, index) => keys[index] === key)
    );

    if (sequence) {
      const endIndex = i + sequence.keys.length - 1;
      result.push({
        text: sequence.text,
        start: timings[i].start,
        end: timings[endIndex].end
      });
      i = endIndex;
      continue;
    }

    const key = normalizeSubtitleTermKey(timings[i].text);
    result.push({
      ...timings[i],
      text: SINGLE_SUBTITLE_TERMS[key] || timings[i].text
    });
  }

  return result;
}

function splitWrappedLines(text, maxCharsPerLine = 28) {
  const clean = sanitizeAssText(text).replace(/\n+/g, ' ').trim();
  if (!clean) return [];

  const words = clean.split(' ').filter(Boolean);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;

    if (nextLine.length <= maxCharsPerLine) {
      currentLine = nextLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function wrapAssText(text, maxCharsPerLine = 28) {
  return splitWrappedLines(text, maxCharsPerLine).join('\\N');
}

function countWrappedLines(text, maxCharsPerLine = 28) {
  return splitWrappedLines(text, maxCharsPerLine).length;
}

function splitChunkBalanced(text) {
  const clean = sanitizeAssText(text).replace(/\n+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean);

  if (words.length <= 1) {
    return [clean];
  }

  let bestIndex = Math.floor(words.length / 2);
  let bestScore = Infinity;

  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(' ');
    const right = words.slice(i).join(' ');
    const score = Math.abs(left.length - right.length);

    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return [
    words.slice(0, bestIndex).join(' '),
    words.slice(bestIndex).join(' ')
  ];
}

function enforceMaxLines(chunks, maxCharsPerLine = 28, maxLines = 2) {
  const result = [];

  for (const chunk of chunks) {
    const clean = sanitizeAssText(chunk).replace(/\n+/g, ' ').trim();
    if (!clean) continue;

    const linesCount = countWrappedLines(clean, maxCharsPerLine);

    if (linesCount <= maxLines) {
      result.push(clean);
      continue;
    }

    const parts = splitChunkBalanced(clean);

    if (parts.length <= 1 || parts[0] === clean) {
      result.push(clean);
      continue;
    }

    result.push(...enforceMaxLines(parts, maxCharsPerLine, maxLines));
  }

  return result;
}

function splitLongTextByWords(text, maxPhraseChars = 48) {
  const clean = sanitizeAssText(text).replace(/\n+/g, ' ').trim();
  if (!clean) return [];

  const words = clean.split(' ').filter(Boolean);
  const result = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.length <= maxPhraseChars) {
      current = candidate;
    } else {
      if (current) {
        result.push(current.trim());
      }
      current = word;
    }
  }

  if (current) {
    result.push(current.trim());
  }

  return result;
}

function splitIntoSentences(text) {
  const clean = sanitizeAssText(text).replace(/\n+/g, ' ').trim();
  if (!clean) return [];

  const result = [];
  let current = '';

  for (const char of clean) {
    current += char;

    if (/[.!?…]/.test(char)) {
      result.push(current.trim());
      current = '';
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result.filter(Boolean);
}

function splitSentenceBySoftBreaks(sentence) {
  const clean = sanitizeAssText(sentence).replace(/\n+/g, ' ').trim();
  if (!clean) return [];

  const result = [];
  let current = '';

  for (const char of clean) {
    current += char;

    if (char === ',' || char === ';' || char === ':' || char === '—') {
      result.push(current.trim());
      current = '';
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result.filter(Boolean);
}

function mergeTinyChunks(chunks, maxPhraseChars = 48, minChunkChars = 12) {
  const result = [];

  for (const rawChunk of chunks) {
    const chunk = sanitizeAssText(rawChunk).replace(/\n+/g, ' ').trim();
    if (!chunk) continue;

    if (!result.length) {
      result.push(chunk);
      continue;
    }

    const prev = result[result.length - 1];
    const canMergeToPrev = `${prev} ${chunk}`.length <= maxPhraseChars;

    if (chunk.length < minChunkChars && canMergeToPrev) {
      result[result.length - 1] = `${prev} ${chunk}`.trim();
    } else {
      result.push(chunk);
    }
  }

  return result;
}

function splitTextToSubtitleChunks(text, options = {}) {
  const maxCharsPerLine = Number(options.maxCharsPerLine) || 28;
  const maxLines = Number(options.maxLines) || 2;
  const maxPhraseChars = Number(options.maxPhraseChars) || (maxCharsPerLine * maxLines);
  const minChunkChars = Number(options.minChunkChars) || 12;

  const normalized = sanitizeAssText(text).replace(/\n+/g, ' ').trim();
  if (!normalized) return [];

  const sentences = splitIntoSentences(normalized);
  const rawChunks = [];

  for (const sentence of sentences) {
    if (sentence.length <= maxPhraseChars) {
      rawChunks.push(sentence);
      continue;
    }

    const softParts = splitSentenceBySoftBreaks(sentence);

    if (softParts.length <= 1) {
      rawChunks.push(...splitLongTextByWords(sentence, maxPhraseChars));
      continue;
    }

    let current = '';

    for (const part of softParts) {
      const candidate = current ? `${current} ${part}` : part;

      if (candidate.length <= maxPhraseChars) {
        current = candidate;
      } else {
        if (current) {
          rawChunks.push(current.trim());
        }

        if (part.length <= maxPhraseChars) {
          current = part;
        } else {
          rawChunks.push(...splitLongTextByWords(part, maxPhraseChars));
          current = '';
        }
      }
    }

    if (current) {
      rawChunks.push(current.trim());
    }
  }

  const mergedChunks = mergeTinyChunks(rawChunks, maxPhraseChars, minChunkChars);

  return enforceMaxLines(mergedChunks, maxCharsPerLine, maxLines);
}

function splitTextIntoSemanticBlocks(text, blockCount) {
  const normalized = sanitizeAssText(text).replace(/\n+/g, ' ').trim();
  if (!normalized) return Array.from({ length: blockCount }, () => '');
  if (blockCount <= 1) return [normalized];

  let pieces = [];
  const sentences = splitIntoSentences(normalized);

  for (const sentence of sentences) {
    const softParts = splitSentenceBySoftBreaks(sentence);
    if (sentence.length > 90 && softParts.length > 1) {
      pieces.push(...softParts);
    } else {
      pieces.push(sentence);
    }
  }

  pieces = pieces
    .map((p) => sanitizeAssText(p).replace(/\n+/g, ' ').trim())
    .filter(Boolean);

  if (!pieces.length) {
    return Array.from({ length: blockCount }, (_, i) => (i === 0 ? normalized : ''));
  }

  if (pieces.length <= blockCount) {
    const padded = [...pieces];
    while (padded.length < blockCount) padded.push('');
    return padded;
  }

  const result = [];
  let index = 0;
  let remainingWeight = pieces.reduce((sum, piece) => sum + piece.length, 0);

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const remainingBlocks = blockCount - blockIndex;

    if (remainingBlocks === 1) {
      result.push(pieces.slice(index).join(' ').trim());
      break;
    }

    const targetWeight = remainingWeight / remainingBlocks;
    let currentParts = [];
    let currentWeight = 0;

    while (index < pieces.length) {
      const piece = pieces[index];
      const pieceWeight = piece.length;
      const remainingPiecesAfterTake = pieces.length - (index + 1);

      currentParts.push(piece);
      currentWeight += pieceWeight;
      index += 1;

      const mustLeaveAtLeastOnePiecePerBlock = remainingPiecesAfterTake >= (remainingBlocks - 1);

      if (currentWeight >= targetWeight && mustLeaveAtLeastOnePiecePerBlock) {
        break;
      }

      if (!mustLeaveAtLeastOnePiecePerBlock) {
        break;
      }
    }

    const blockText = currentParts.join(' ').trim();
    result.push(blockText);
    remainingWeight -= currentWeight;
  }

  while (result.length < blockCount) {
    result.push('');
  }

  if (result.length > blockCount) {
    const head = result.slice(0, blockCount - 1);
    const tail = result.slice(blockCount - 1).join(' ').trim();
    return [...head, tail];
  }

  return result;
}

function allocateDurationsByWeights(texts, totalDuration, minBlockDuration = 0.8) {
  if (!texts.length) return [];

  let effectiveMin = minBlockDuration;
  if ((texts.length * effectiveMin) > totalDuration) {
    effectiveMin = Math.max(0.35, (totalDuration / texts.length) * 0.75);
  }

  const weights = texts.map((text) => Math.max(1, sanitizeAssText(text).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const reservedMin = effectiveMin * texts.length;
  const extraDuration = Math.max(0, totalDuration - reservedMin);

  return texts.map((text, index) => {
    const extra = totalWeight > 0 ? (weights[index] / totalWeight) * extraDuration : 0;
    return effectiveMin + extra;
  });
}

function allocateAutoDurations({
  mediaItems,
  blockTexts,
  voiceDuration,
  transitionDuration = 0,
  minBlockDuration = 0.8
}) {
  const durations = Array.from({ length: mediaItems.length }, () => null);
  let fixedTotal = 0;
  const autoIndexes = [];

  mediaItems.forEach((item, index) => {
    const manualDuration = parseOptionalPositiveNumber(item.durationSeconds);
    const sourceDuration = parseOptionalPositiveNumber(item.sourceDuration);

    if (manualDuration) {
      durations[index] = manualDuration;
      fixedTotal += manualDuration;
      return;
    }

    if (item.type === 'video' && item.videoBehavior === 'clip' && sourceDuration) {
      const visibleSourceDuration = index < mediaItems.length - 1
        ? Math.max(0.1, sourceDuration - transitionDuration)
        : sourceDuration;
      durations[index] = visibleSourceDuration;
      fixedTotal += visibleSourceDuration;
      return;
    }

    autoIndexes.push(index);
  });

  const remainingDuration = Math.max(0, Number(voiceDuration || 0) - fixedTotal);

  if (autoIndexes.length > 0) {
    const autoTexts = autoIndexes.map((index) => blockTexts[index] || '');
    const allocated = allocateDurationsByWeights(
      autoTexts,
      remainingDuration > 0 ? remainingDuration : autoIndexes.length * minBlockDuration,
      minBlockDuration
    );

    autoIndexes.forEach((index, autoIndex) => {
      durations[index] = allocated[autoIndex];
    });
  } else if (fixedTotal < voiceDuration && durations.length > 0) {
    const lastIndex = durations.length - 1;
    durations[lastIndex] += voiceDuration - fixedTotal;
  }

  return durations.map((duration) => Math.max(0.1, Number(duration || minBlockDuration)));
}

function buildScenePlan({
  mediaItems,
  voiceDuration,
  subtitlesText,
  subtitleStyle,
  transitionDuration
}) {
  const allHaveNarration = mediaItems.every((item) => item.narrationText && item.narrationText.trim());

  const blockTexts = allHaveNarration
    ? mediaItems.map((item) => item.narrationText.trim())
    : splitTextIntoSemanticBlocks(subtitlesText, mediaItems.length);

  const visibleDurations = allocateAutoDurations({
    mediaItems,
    blockTexts,
    voiceDuration,
    transitionDuration,
    minBlockDuration: Number(subtitleStyle.minSceneDuration) || 0.8
  });

  let visibleStart = 0;

  return mediaItems.map((item, index) => {
    const isClipVideo = item.type === 'video' &&
      item.videoBehavior === 'clip' &&
      item.sourceDuration;
    const sourceDuration = Number(item.sourceDuration || 0);
    const visibleDuration = isClipVideo && index < mediaItems.length - 1
      ? Math.max(0.1, Math.min(visibleDurations[index], sourceDuration - transitionDuration))
      : isClipVideo
      ? Math.min(visibleDurations[index], sourceDuration)
      : visibleDurations[index];
    const inputDuration = isClipVideo
      ? index < mediaItems.length - 1
        ? Math.min(sourceDuration, visibleDuration + transitionDuration)
        : visibleDuration
      : index < mediaItems.length - 1
      ? visibleDuration + transitionDuration
      : visibleDuration;

    const scene = {
      ...item,
      blockText: blockTexts[index] || '',
      visibleStart,
      visibleEnd: visibleStart + visibleDuration,
      visibleDuration,
      inputDuration
    };

    visibleStart += visibleDuration;
    return scene;
  });
}

function buildPhraseEventsForWindow({
  text,
  startTime,
  duration,
  subtitleStyle = {}
}) {
  const totalDuration = Math.max(0.1, Number(duration) || 0.1);
  const maxCharsPerLine = Number(subtitleStyle.maxCharsPerLine) || 28;
  const maxLines = Number(subtitleStyle.maxLines) || 2;
  const maxPhraseChars = Number(subtitleStyle.maxPhraseChars) || (maxCharsPerLine * maxLines);

  const chunks = splitTextToSubtitleChunks(text, {
    maxCharsPerLine,
    maxLines,
    maxPhraseChars,
    minChunkChars: subtitleStyle.minChunkChars
  });

  if (!chunks.length) return [];

  let minPhraseDuration = Number(subtitleStyle.minPhraseDuration) || 0.9;
  if ((chunks.length * minPhraseDuration) > totalDuration) {
    minPhraseDuration = Math.max(0.25, (totalDuration / chunks.length) * 0.75);
  }

  const weights = chunks.map((chunk) => Math.max(1, sanitizeAssText(chunk).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const reservedMinDuration = minPhraseDuration * chunks.length;
  const extraDuration = Math.max(0, totalDuration - reservedMinDuration);

  const chunkDurations = chunks.map((chunk, index) => {
    const extra = totalWeight > 0 ? (weights[index] / totalWeight) * extraDuration : 0;
    return minPhraseDuration + extra;
  });

  const events = [];
  let cursor = 0;

  for (let i = 0; i < chunks.length; i++) {
    const localStart = cursor;
    const localEnd = i === chunks.length - 1
      ? totalDuration
      : Math.min(totalDuration, cursor + chunkDurations[i]);

    events.push({
      start: startTime + localStart,
      end: startTime + localEnd,
      rawText: chunks[i],
      text: wrapAssText(chunks[i], maxCharsPerLine)
    });

    cursor = localEnd;
  }

  return events;
}

function buildTimedDialogueEventsFromScenePlan(scenePlan, subtitleStyle = {}) {
  const events = [];

  for (const scene of scenePlan) {
    if (!scene.blockText) continue;

    const sceneEvents = buildPhraseEventsForWindow({
      text: scene.blockText,
      startTime: scene.visibleStart,
      duration: scene.visibleDuration,
      subtitleStyle
    });

    events.push(...sceneEvents);
  }

  return events;
}

function buildTimedDialogueEvents({
  subtitlesText,
  duration,
  subtitleStyle = {}
}) {
  const totalDuration = Math.max(0.1, Number(duration) || 0.1);
  const maxCharsPerLine = Number(subtitleStyle.maxCharsPerLine) || 28;
  const maxLines = Number(subtitleStyle.maxLines) || 2;
  const maxPhraseChars = Number(subtitleStyle.maxPhraseChars) || (maxCharsPerLine * maxLines);

  const chunks = splitTextToSubtitleChunks(subtitlesText, {
    maxCharsPerLine,
    maxLines,
    maxPhraseChars,
    minChunkChars: subtitleStyle.minChunkChars
  });

  if (!chunks.length) {
    return [];
  }

  let minPhraseDuration = Number(subtitleStyle.minPhraseDuration) || 0.9;

  if ((chunks.length * minPhraseDuration) > totalDuration) {
    minPhraseDuration = Math.max(0.35, (totalDuration / chunks.length) * 0.85);
  }

  const weights = chunks.map((chunk) => Math.max(1, sanitizeAssText(chunk).length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const reservedMinDuration = minPhraseDuration * chunks.length;
  const extraDuration = Math.max(0, totalDuration - reservedMinDuration);

  const chunkDurations = chunks.map((chunk, index) => {
    const extra = totalWeight > 0 ? (weights[index] / totalWeight) * extraDuration : 0;
    return minPhraseDuration + extra;
  });

  const events = [];
  let cursor = 0;

  for (let i = 0; i < chunks.length; i++) {
    const start = cursor;
    const end = i === chunks.length - 1
      ? totalDuration
      : Math.min(totalDuration, cursor + chunkDurations[i]);

    events.push({
      start,
      end,
      rawText: chunks[i],
      text: wrapAssText(chunks[i], maxCharsPerLine)
    });

    cursor = end;
  }

  return events;
}

function tokenizeWords(text = '') {
  return sanitizeAssText(text)
    .replace(/\n+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => ({
      index,
      text: word
    }));
}

function wrapWordTokens(tokens, maxCharsPerLine = 28) {
  const lines = [];
  let current = [];
  let currentLen = 0;

  for (const token of tokens) {
    const tokenLen = token.text.length;
    const nextLen = current.length ? currentLen + 1 + tokenLen : tokenLen;

    if (current.length && nextLen > maxCharsPerLine) {
      lines.push(current);
      current = [token];
      currentLen = tokenLen;
    } else {
      current.push(token);
      currentLen = nextLen;
    }
  }

  if (current.length) {
    lines.push(current);
  }

  return lines;
}

function buildHighlightedPhraseText(tokens, activeIndex, maxCharsPerLine = 28, highlightKeywords = new Set()) {
  const lines = wrapWordTokens(tokens, maxCharsPerLine);

  return lines
    .map((line) =>
      line
        .map((token) => {
          if (token.index === activeIndex) {
            return `{\\rActiveWord}${token.text}{\\rDefault}`;
          }
          const isKeyword = highlightKeywords.size > 0 &&
            highlightKeywords.has(token.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim());
          if (isKeyword) {
            return `{\\rKeyWord}${token.text}{\\rDefault}`;
          }
          return token.text;
        })
        .join(' ')
    )
    .join('\\N');
}

function buildWordHighlightEventsFromPhraseEvents(phraseEvents, subtitleStyle = {}, highlightKeywords = new Set()) {
  const maxCharsPerLine = Number(subtitleStyle.maxCharsPerLine) || 28;
  const result = [];

  for (const phraseEvent of phraseEvents) {
    const tokens = tokenizeWords(phraseEvent.rawText || '');
    if (!tokens.length) continue;

    const totalDuration = Math.max(0.1, Number(phraseEvent.end) - Number(phraseEvent.start));
    const weights = tokens.map((token) => {
      const clean = token.text.replace(/[^\p{L}\p{N}]+/gu, '');
      return Math.max(1, clean.length);
    });

    const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
    let cursor = Number(phraseEvent.start);

    for (let i = 0; i < tokens.length; i++) {
      const isLast = i === tokens.length - 1;
      const wordDuration = isLast
        ? Math.max(0.05, Number(phraseEvent.end) - cursor)
        : totalDuration * (weights[i] / totalWeight);

      result.push({
        start: cursor,
        end: isLast ? Number(phraseEvent.end) : cursor + wordDuration,
        text: buildHighlightedPhraseText(tokens, i, maxCharsPerLine, highlightKeywords)
      });

      cursor += wordDuration;
    }
  }

  return result;
}

function normalizeWordTimings(wordTimings = [], subtitlesText = '') {
  if (!Array.isArray(wordTimings)) return [];

  const visibleTokens = tokenizeSubtitleText(subtitlesText);
  const timings = wordTimings
    .map((item) => {
      const rawText = item.text || item.word || '';
      return {
        text: sanitizeAssText(rawText).replace(/\n+/g, ' ').trim(),
        matchKey: normalizeSubtitleTokenForMatch(rawText),
        start: Number(item.start),
        end: Number(item.end)
      };
    })
    .filter((item) =>
      Number.isFinite(item.start) &&
      Number.isFinite(item.end) &&
      item.end > item.start
    )
    .sort((a, b) => a.start - b.start);

  if (!visibleTokens.length) {
    return normalizeSpokenSubtitleTerms(timings.filter((item) => item.text));
  }

  let tokenIndex = 0;
  const aligned = [];

  for (const timing of timings) {
    if (!timing.text && !timing.matchKey) continue;

    let foundIndex = -1;
    if (timing.matchKey) {
      const searchEnd = Math.min(visibleTokens.length, tokenIndex + 8);
      for (let i = tokenIndex; i < searchEnd; i++) {
        if (normalizeSubtitleTokenForMatch(visibleTokens[i]) === timing.matchKey) {
          foundIndex = i;
          break;
        }
      }
    }

    let textTokens = [];
    if (foundIndex >= tokenIndex) {
      textTokens = visibleTokens.slice(tokenIndex, foundIndex + 1);
      tokenIndex = foundIndex + 1;
    } else if (tokenIndex < visibleTokens.length) {
      textTokens = [visibleTokens[tokenIndex]];
      tokenIndex += 1;
    } else if (timing.text) {
      textTokens = [timing.text];
    }

    const text = textTokens.join(' ').trim();
    if (text) {
      aligned.push({
        text,
        start: timing.start,
        end: timing.end
      });
    }
  }

  return normalizeSpokenSubtitleTerms(aligned);
}

/**
 * Автоматическая генерация wordTimings по тексту и длительности аудио.
 * Используется как fallback, когда внешний сервис (Kie AI / ElevenLabs)
 * не вернул таймкоды. Распределяет время пропорционально длине слов.
 */
function generateWordTimingsFromDuration(text, duration) {
  if (!text || !duration || duration <= 0) return [];

  const words = tokenizeSubtitleText(text);
  if (!words.length) return [];

  // Оставляем небольшие отступы: 0.1с в начале, 0.3с в конце
  const startOffset = 0.1;
  const endOffset = 0.3;
  const usableDuration = Math.max(0.5, duration - startOffset - endOffset);

  // Длина каждого слова (в символах) определяет долю времени
  const totalChars = words.reduce((sum, w) => sum + w.length, 0);
  if (totalChars === 0) return [];

  const result = [];
  let cursor = startOffset;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // Пропорционально длине слова + маленький бонус за пунктуацию (паузы)
    const punctuationBonus = /[.!?…,;:—–]$/.test(word) ? 0.15 : 0;
    const wordDuration = (word.length / totalChars) * usableDuration + punctuationBonus;
    const wordEnd = Math.min(cursor + wordDuration, duration);

    result.push({
      text: word,
      start: Number(cursor.toFixed(3)),
      end: Number(wordEnd.toFixed(3))
    });

    cursor = wordEnd;
  }

  // Корректировка: последнее слово заканчивается не позже duration - endOffset
  if (result.length > 0) {
    result[result.length - 1].end = Number(Math.min(result[result.length - 1].end, duration - endOffset).toFixed(3));
  }

  console.log(`[Fallback] Generated ${result.length} word timings from text (${duration.toFixed(1)}s audio)`);
  return result;
}

function buildPhrasesFromWordTimings(wordTimings, subtitleStyle = {}) {
  const maxCharsPerLine = Number(subtitleStyle.maxCharsPerLine) || 28;
  const maxLines = Number(subtitleStyle.maxLines) || 2;
  const maxPhraseChars = Number(subtitleStyle.maxPhraseChars) || (maxCharsPerLine * maxLines);

  const phrases = [];
  let current = [];

  const flush = () => {
    if (current.length) {
      phrases.push(current);
      current = [];
    }
  };

  for (const word of wordTimings) {
    const candidate = [...current, word];
    const candidateText = candidate.map((w) => w.text).join(' ');
    const candidateLines = countWrappedLines(candidateText, maxCharsPerLine);
    const tooLong = candidateText.length > maxPhraseChars || candidateLines > maxLines;

    if (current.length && tooLong) {
      flush();
    }

    current.push(word);

    if (/[.!?…]$/.test(word.text)) {
      flush();
    }
  }

  flush();
  return phrases;
}

function buildWordHighlightEventsFromWordTimings(wordTimings, subtitleStyle = {}, highlightKeywords = new Set()) {
  const normalized = normalizeWordTimings(wordTimings);
  if (!normalized.length) return [];

  const maxCharsPerLine = Number(subtitleStyle.maxCharsPerLine) || 28;
  const phrases = buildPhrasesFromWordTimings(normalized, subtitleStyle);
  const events = [];

  for (const phrase of phrases) {
    const phraseTokens = phrase.map((word, index) => ({
      index,
      text: word.text
    }));

    for (let i = 0; i < phrase.length; i++) {
      const current = phrase[i];
      const next = phrase[i + 1];

      const start = current.start;
      const end = next ? Math.max(current.end, next.start) : current.end;

      if (end <= start) continue;

      events.push({
        start,
        end,
        text: buildHighlightedPhraseText(phraseTokens, i, maxCharsPerLine, highlightKeywords)
      });
    }
  }

  return events;
}

function escapeFfmpegFilterPath(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

const MOTION_PRESETS = [
  { dir: 'zoom-in-topleft',      zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.12, yFactor: 0.14 },
  { dir: 'zoom-out-bottomright', zoomStart: 1.15, zoomStep: -0.0010, zoomMax: 1.15, zoomMin: 1.0,  xFactor: 0.86, yFactor: 0.84 },
  { dir: 'zoom-in-topright',     zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.86, yFactor: 0.14 },
  { dir: 'zoom-out-bottomleft',  zoomStart: 1.15, zoomStep: -0.0010, zoomMax: 1.15, zoomMin: 1.0,  xFactor: 0.14, yFactor: 0.84 },
  { dir: 'zoom-in-left',         zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.12, yFactor: 0.50 },
  { dir: 'zoom-out-right',       zoomStart: 1.15, zoomStep: -0.0010, zoomMax: 1.15, zoomMin: 1.0,  xFactor: 0.88, yFactor: 0.50 },
  { dir: 'zoom-in-bottomright',  zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.86, yFactor: 0.84 },
  { dir: 'zoom-out-left',        zoomStart: 1.15, zoomStep: -0.0010, zoomMax: 1.15, zoomMin: 1.0,  xFactor: 0.12, yFactor: 0.50 },
  { dir: 'zoom-in-center',       zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.50, yFactor: 0.50 },
  { dir: 'zoom-out-center',      zoomStart: 1.15, zoomStep: -0.0010, zoomMax: 1.15, zoomMin: 1.0,  xFactor: 0.50, yFactor: 0.50 }
];

const MOTION_DIRECTIONS = {
  center: { xFactor: 0.50, yFactor: 0.50 },
  'top-left': { xFactor: 0.00, yFactor: 0.00 },
  'top-right': { xFactor: 1.00, yFactor: 0.00 },
  'bottom-left': { xFactor: 0.00, yFactor: 1.00 },
  'bottom-right': { xFactor: 1.00, yFactor: 1.00 },
  left: { xFactor: 0.00, yFactor: 0.50 },
  right: { xFactor: 1.00, yFactor: 0.50 }
};

function clamp01(value, fallback = 0.5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(1, Math.max(0, numeric));
}

function amplifyFocusFactor(value, amount = 1.65) {
  return clamp01(0.5 + ((clamp01(value) - 0.5) * amount));
}

function isSmartFocusMotion(motionSettings = {}) {
  const type = String(motionSettings.type || '').trim().toLowerCase();
  return ['smart-object', 'smart', 'object', 'person-object'].includes(type);
}

function getMotionStrengthPercents(frameMotion = {}) {
  const strength = String(frameMotion.strength || 'balanced').trim().toLowerCase();
  if (strength === 'soft') {
    return { zoomInPercent: 10, zoomOutPercent: 20 };
  }
  if (strength === 'dynamic') {
    return { zoomInPercent: 35, zoomOutPercent: 50 };
  }
  if (strength === 'custom') {
    return {
      zoomInPercent: Math.min(300, Math.max(0, Number(frameMotion.zoomInPercent || 20))),
      zoomOutPercent: Math.min(300, Math.max(0, Number(frameMotion.zoomOutPercent || 35)))
    };
  }
  return { zoomInPercent: 20, zoomOutPercent: 35 };
}

function getAlternatingMotionType(frameMotion = {}, sceneIndex = 0) {
  const pattern = String(frameMotion.pattern || 'alternate').trim().toLowerCase();
  if (pattern === 'zoom-in' || pattern === 'in') return 'smooth-in';
  if (pattern === 'zoom-out' || pattern === 'out') return 'smooth-out';
  return sceneIndex % 2 === 0 ? 'smooth-in' : 'smooth-out';
}

function getMotionFocusFactors(scene, sceneIndex, motionPresetName, useSmartFocus) {
  if (useSmartFocus && scene.smartFocus) {
    return {
      xFactor: amplifyFocusFactor(scene.smartFocus.xFactor),
      yFactor: amplifyFocusFactor(scene.smartFocus.yFactor)
    };
  }

  const preset = getImageMotionPreset(sceneIndex, motionPresetName);
  return {
    xFactor: preset.xFactor,
    yFactor: preset.yFactor
  };
}

async function analyzeImageSmartFocus(imagePath) {
  if (!sharp) return null;

  try {
    const { data, info } = await sharp(imagePath)
      .rotate()
      .resize(96, 96, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const channels = info.channels;
    if (!width || !height || channels < 3) return null;

    const luma = new Float32Array(width * height);
    let avgLuma = 0;
    const bgSamples = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1]
    ];
    const bg = { r: 0, g: 0, b: 0 };

    for (const [x, y] of bgSamples) {
      const offset = (y * width + x) * channels;
      bg.r += data[offset];
      bg.g += data[offset + 1];
      bg.b += data[offset + 2];
    }
    bg.r /= bgSamples.length;
    bg.g /= bgSamples.length;
    bg.b /= bgSamples.length;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * channels;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luma[y * width + x] = value;
        avgLuma += value;
      }
    }

    avgLuma /= width * height;

    const weights = new Float32Array(width * height);
    const sortedWeights = [];

    for (let y = 1; y < height; y++) {
      for (let x = 1; x < width; x++) {
        const index = y * width + x;
        const offset = index * channels;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max === 0 ? 0 : (max - min) / max;
        const edge = Math.abs(luma[index] - luma[index - 1]) + Math.abs(luma[index] - luma[index - width]);
        const contrast = Math.abs(luma[index] - avgLuma);
        const bgDistance = Math.sqrt(
          ((r - bg.r) ** 2) +
          ((g - bg.g) ** 2) +
          ((b - bg.b) ** 2)
        );
        const weight = Math.max(0, (edge * 1.4) + (saturation * 55) + (contrast * 0.35) + (bgDistance * 0.75));

        weights[index] = weight;
        sortedWeights.push(weight);
      }
    }

    sortedWeights.sort((a, b) => a - b);
    const threshold = Math.max(
      12,
      sortedWeights[Math.floor(sortedWeights.length * 0.82)] || 0
    );

    const gridCols = 8;
    const gridRows = 8;
    const cellWeights = new Float32Array(gridCols * gridRows);
    let totalWeight = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (let y = 1; y < height; y++) {
      for (let x = 1; x < width; x++) {
        const index = y * width + x;
        const weight = weights[index];
        if (weight < threshold) continue;

        totalWeight += weight;
        weightedX += x * weight;
        weightedY += y * weight;

        const cellX = Math.min(gridCols - 1, Math.floor((x / width) * gridCols));
        const cellY = Math.min(gridRows - 1, Math.floor((y / height) * gridRows));
        cellWeights[(cellY * gridCols) + cellX] += weight;
      }
    }

    if (totalWeight <= 0) return null;

    let bestCellX = 0;
    let bestCellY = 0;
    let bestScore = -Infinity;

    for (let cellY = 0; cellY < gridRows; cellY++) {
      for (let cellX = 0; cellX < gridCols; cellX++) {
        let score = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nearX = cellX + dx;
            const nearY = cellY + dy;
            if (nearX < 0 || nearX >= gridCols || nearY < 0 || nearY >= gridRows) continue;
            const multiplier = dx === 0 && dy === 0 ? 1 : 0.35;
            score += cellWeights[(nearY * gridCols) + nearX] * multiplier;
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestCellX = cellX;
          bestCellY = cellY;
        }
      }
    }

    let clusterWeight = 0;
    let clusterX = 0;
    let clusterY = 0;

    for (let y = 1; y < height; y++) {
      for (let x = 1; x < width; x++) {
        const index = y * width + x;
        const weight = weights[index];
        if (weight < threshold) continue;

        const cellX = Math.min(gridCols - 1, Math.floor((x / width) * gridCols));
        const cellY = Math.min(gridRows - 1, Math.floor((y / height) * gridRows));
        if (Math.abs(cellX - bestCellX) > 1 || Math.abs(cellY - bestCellY) > 1) continue;

        clusterWeight += weight;
        clusterX += x * weight;
        clusterY += y * weight;
      }
    }

    if (clusterWeight > 0) {
      return {
        xFactor: clamp01(clusterX / clusterWeight / Math.max(1, width - 1)),
        yFactor: clamp01(clusterY / clusterWeight / Math.max(1, height - 1))
      };
    }

    return {
      xFactor: clamp01(weightedX / totalWeight / Math.max(1, width - 1)),
      yFactor: clamp01(weightedY / totalWeight / Math.max(1, height - 1))
    };
  } catch (error) {
    console.warn(`[smart-focus] Failed for ${path.basename(imagePath)}: ${error.message}`);
    return null;
  }
}

function getImageMotionPreset(sceneIndex, motionPresetName) {
  if (motionPresetName) {
    const found = MOTION_PRESETS.find((p) => p.dir === motionPresetName);
    if (found) return found;
  }
  return MOTION_PRESETS[sceneIndex % MOTION_PRESETS.length];
}

function normalizeImageMotion(scene, sceneIndex, motionPresetName) {
  const frameMotion = scene.motionSettings || {};
  const type = String(frameMotion.type || 'auto').trim().toLowerCase();

  if (type === 'none' || type === 'off' || type === 'disabled') {
    return { type: 'none' };
  }

  if (type === 'auto' || isSmartFocusMotion(frameMotion)) {
    const motionType = getAlternatingMotionType(frameMotion, sceneIndex);
    const percents = getMotionStrengthPercents(frameMotion);
    const zoomPercent = motionType === 'smooth-out' ? percents.zoomOutPercent : percents.zoomInPercent;
    const zoomScale = 1 + (zoomPercent / 100);
    const focus = getMotionFocusFactors(scene, sceneIndex, motionPresetName, isSmartFocusMotion(frameMotion));
    return {
      type: motionType,
      zoomStart: motionType === 'smooth-out' ? zoomScale : 1,
      zoomEnd: motionType === 'smooth-out' ? 1 : zoomScale,
      xFactor: focus.xFactor,
      yFactor: focus.yFactor
    };
  }

  const direction = MOTION_DIRECTIONS[frameMotion.direction] || MOTION_DIRECTIONS.center;
  const zoomScale = 1 + (Math.min(300, Math.max(0, Number(frameMotion.zoomPercent || 20))) / 100);

  if (type === 'sharp' || type === 'sharp-zoom' || type === 'sharp-zoom-in') {
    return {
      type: 'sharp',
      zoomStart: 1,
      zoomEnd: zoomScale,
      zoomAt: frameMotion.zoomAt,
      xFactor: direction.xFactor,
      yFactor: direction.yFactor
    };
  }

  if (type === 'smooth-out' || type === 'zoom-out') {
    return {
      type: 'smooth-out',
      zoomStart: zoomScale,
      zoomEnd: 1,
      xFactor: direction.xFactor,
      yFactor: direction.yFactor
    };
  }

  return {
    type: 'smooth-in',
    zoomStart: 1,
    zoomEnd: zoomScale,
    xFactor: direction.xFactor,
    yFactor: direction.yFactor
  };
}

function buildImageMotionFilter(scene, sceneIndex, width, height, motionPresetName, fps) {
  const duration = Number(scene.inputDuration.toFixed(3));
  const outputFps = parseFps(fps);
  const motion = normalizeImageMotion(scene, sceneIndex, motionPresetName);
  const smoothScale = Math.min(3, Math.max(2, Number(scene.motionSettings?.smoothScale || 2)));
  const zoomWidth = Math.round(width * smoothScale);
  const zoomHeight = Math.round(height * smoothScale);

  // Если motion отключён — просто scale+crop без zoompan
  if (motion.type === 'none') {
    return `[${sceneIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `setsar=1,fps=${outputFps},format=yuv420p,trim=duration=${duration},setpts=PTS-STARTPTS[v${sceneIndex}]`;
  }

  const frames = Math.max(1, Math.ceil(Number(scene.inputDuration || 0) * outputFps));
  const xExpr = `(iw-iw/zoom)*${motion.xFactor}`;
  const yExpr = `(ih-ih/zoom)*${motion.yFactor}`;
  const progressExpr = `(on/${Math.max(1, frames - 1)})`;
  const easedProgressExpr = `(${progressExpr}*${progressExpr}*(3-2*${progressExpr}))`;

  if (isSmartFocusMotion(scene.motionSettings || {})) {
    console.log(
      `[motion] frame ${sceneIndex + 1}: smart ${scene.smartFocus ? 'found' : 'fallback'} ` +
      `${motion.type} focus=${motion.xFactor.toFixed(2)},${motion.yFactor.toFixed(2)} ` +
      `zoom=${motion.zoomStart.toFixed(2)}->${motion.zoomEnd.toFixed(2)}`
    );
  }

  let zExpr;
  if (motion.type === 'sharp') {
    const triggerFrame = Math.max(1, Math.round(Number(motion.zoomAt || (duration / 2)) * outputFps));
    zExpr = `if(lt(on,${triggerFrame}),${motion.zoomStart},${motion.zoomEnd})`;
  } else {
    zExpr = `${motion.zoomStart}+(${motion.zoomEnd}-${motion.zoomStart})*${easedProgressExpr}`;
  }

  return `[${sceneIndex}:v]scale=${zoomWidth}:${zoomHeight}:force_original_aspect_ratio=increase,` +
    `crop=${zoomWidth}:${zoomHeight},` +
    `zoompan=` +
    `z='${zExpr}':` +
    `x='${xExpr}':` +
    `y='${yExpr}':` +
    `d=${frames}:s=${zoomWidth}x${zoomHeight}:fps=${outputFps},` +
    `scale=${width}:${height}:flags=lanczos,` +
    `setsar=1,format=yuv420p,trim=duration=${duration},setpts=PTS-STARTPTS[v${sceneIndex}]`;
}

/**
 * Конвертирует HEX цвет (#RRGGBB или #RGB) + opacity (0.0–1.0)
 * в формат 0xRRGGBBAA который понимает FFmpeg drawtext boxcolor.
 * Если передан старый формат "black@0.5" — возвращает как есть.
 */
function hexToFfmpegColor(colorStr, opacity) {
  if (!colorStr) return '0x00000000';
  // Если уже в старом формате "color@alpha" или "0x..." — оставляем
  if (colorStr.startsWith('0x') || colorStr.includes('@')) return colorStr;
  // Парсим HEX
  let hex = colorStr.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length !== 6) return colorStr; // не парсится — как есть
  const alpha = Math.round(Math.min(1, Math.max(0, Number(opacity ?? 1))) * 255);
  const alphaHex = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `0x${hex.toUpperCase()}${alphaHex}`;
}

function getSceneOverlayStyle(sceneOverlayStyle = {}, globalOverlayStyle = {}) {
  return {
    ...globalOverlayStyle,
    ...sceneOverlayStyle
  };
}

/**
 * Строит FFmpeg drawtext-фильтр для наложения текстовой надписи поверх сцены.
 * inputLabel  — входной лейбл видеопотока (например 'v0')
 * outputLabel — выходной лейбл (например 'vt0')
 */
function buildSceneDrawtextFilter(text, inputLabel, outputLabel, overlayStyle, width, height, fontsDir) {
  const fontName   = String(overlayStyle.fontName   || 'Inter');
  const fontSize   = Number(overlayStyle.fontSize   || Math.round(height * 0.045));
  const fontColor  = String(overlayStyle.fontColor  || '#FFFFFF');
  const bold       = overlayStyle.bold !== false; // true по умолчанию
  const position   = String(overlayStyle.position   || 'top').toLowerCase(); // top | center | bottom
  const bgColor    = String(overlayStyle.bgColor    || '#000000');
  const bgOpacity  = overlayStyle.bgOpacity !== undefined ? Number(overlayStyle.bgOpacity) : 0.0;
  const bgPadding  = Number(overlayStyle.bgPadding  ?? 8);  // отступ вокруг текста (px)
  const outline    = Number(overlayStyle.outline    ?? 2);
  const marginV    = Number(overlayStyle.marginV    || Math.round(height * 0.04));

  // Позиция по вертикали
  let yExpr;
  if (position === 'center') {
    yExpr = `(h-text_h)/2`;
  } else if (position === 'bottom') {
    yExpr = `h-text_h-${marginV}`;
  } else {
    yExpr = `${marginV}`;
  }

  // Экранирование текста для FFmpeg drawtext
  const safeText = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\n/g, ' ');

  // Выбор файла шрифта: Bold вариант если доступен, иначе обычный
  // FFmpeg drawtext не поддерживает параметр bold — жирность задаётся через файл шрифта
  const escapedFontsDir = fontsDir.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:');
  const boldFontFile   = `${escapedFontsDir}/${fontName}-Bold.ttf`;
  const regularFontFile = `${escapedFontsDir}/${fontName}.ttf`;

  // Проверяем наличие Bold-варианта синхронно (fs-extra)
  let fontfile = regularFontFile;
  try {
    if (bold && require('fs').existsSync(boldFontFile.replace(/\\\\/g, '\\').replace(/\\:/g, ':'))) {
      fontfile = boldFontFile;
    }
  } catch (_) { /* используем обычный */ }

  const drawtextArgs = [
    `text='${safeText}'`,
    `fontfile='${fontfile}'`,
    `fontsize=${fontSize}`,
    `fontcolor=${fontColor}`,
    `borderw=${outline}`,
    `bordercolor=black@0.8`,
    `box=1`,
    `boxcolor=${hexToFfmpegColor(bgColor, bgOpacity)}`,
    `boxborderw=${bgPadding}`,
    `x=(w-text_w)/2`,
    `y=${yExpr}`,
    `line_spacing=4`
  ].join(':');

  return `[${inputLabel}]drawtext=${drawtextArgs}[${outputLabel}]`;
}

/**
 * Режим single-word: каждое слово показывается отдельно по центру/снизу экрана.
 * Использует стиль ActiveWord для всех событий (цветной блок под словом).
 */
function buildSingleWordEvents(timingsOrPhraseEvents, subtitleStyle = {}, hasRealTimings = false, highlightKeywords = new Set()) {
  const events = [];

  // Определяем стиль для слова: keyword → KeyWord, иначе → ActiveWord
  function wordStyle(rawText) {
    const clean = rawText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();
    return highlightKeywords.size > 0 && highlightKeywords.has(clean)
      ? `{\\rKeyWord}${sanitizeAssText(rawText)}{\\rDefault}`
      : `{\\rActiveWord}${sanitizeAssText(rawText)}{\\rDefault}`;
  }

  if (hasRealTimings) {
    const normalized = normalizeWordTimings(timingsOrPhraseEvents);
    for (let i = 0; i < normalized.length; i++) {
      const word = normalized[i];
      const next = normalized[i + 1];
      events.push({
        start: word.start,
        end: next ? Math.min(word.end, next.start) : word.end,
        text: wordStyle(word.text)
      });
    }
  } else {
    for (const phrase of timingsOrPhraseEvents) {
      const tokens = tokenizeWords(phrase.rawText || '');
      if (!tokens.length) continue;

      const totalDuration = Math.max(0.1, phrase.end - phrase.start);
      const weights = tokens.map(t => Math.max(1, t.text.replace(/[^\p{L}\p{N}]+/gu, '').length));
      const totalWeight = weights.reduce((s, v) => s + v, 0) || 1;
      let cursor = phrase.start;

      for (let i = 0; i < tokens.length; i++) {
        const isLast = i === tokens.length - 1;
        const wordDuration = isLast
          ? Math.max(0.05, phrase.end - cursor)
          : totalDuration * (weights[i] / totalWeight);

        events.push({
          start: cursor,
          end: isLast ? phrase.end : cursor + wordDuration,
          text: wordStyle(tokens[i].text)
        });

        cursor += wordDuration;
      }
    }
  }

  return events;
}

function buildAssContent({
  width,
  height,
  duration,
  subtitlesText,
  subtitleStyle = {},
  scenePlan = [],
  wordTimings = [],
  highlightKeywords = new Set()
}) {
  subtitleStyle = applySubtitlePreset(subtitleStyle);
  const hasExplicitFontName = subtitleStyle.fontName !== undefined && subtitleStyle.fontName !== null && subtitleStyle.fontName !== '';
  const [rawFontName, rawFontWeight] = String(subtitleStyle.fontName || 'Inter').split(':');
  const fontName = rawFontName || 'Inter';
  const subtitleMode = String(subtitleStyle.mode || 'phrase').trim().toLowerCase();
  const isSingleWord = subtitleMode === 'single-word';
  const fontSize = Number(subtitleStyle.fontSize || Math.max(24, Math.round(height * (isSingleWord ? 0.07 : 0.026))));

  const subtitlePosition = String(subtitleStyle.position || 'bottom').toLowerCase();
  let marginV = Number(subtitleStyle.marginV || 0);
  if (!subtitleStyle.marginV) {
    if (subtitlePosition === 'center') marginV = Math.round(height * 0.40);
    else if (subtitlePosition === 'top') marginV = Math.round(height * 0.08);
    else marginV = Math.round(height * 0.11); // bottom default
  }

  const outline = Number(subtitleStyle.outline || 2);
  const shadow = Number(subtitleStyle.shadow || 0);
  const bold = rawFontWeight
    ? (rawFontWeight === 'bold' ? 1 : 0)
    : (subtitleStyle.bold !== undefined ? (subtitleStyle.bold === false ? 0 : 1) : (hasExplicitFontName ? 0 : 1));
  const alignment = Number(subtitleStyle.alignment || 2);

  // Отступы слева/справа — минимум 5% ширины видео, чтобы текст не вылезал за края
  // При большом шрифте автоматически увеличиваются
  const autoMargin = Math.max(60, Math.round(width * 0.05));
  const marginL = Number(subtitleStyle.marginL || autoMargin);
  const marginR = Number(subtitleStyle.marginR || autoMargin);

  // maxCharsPerLine: считаем от ширины видео и размера шрифта
  // ~1.8 символа на каждые 10px шрифта на 1080px ширины
  const usableWidth = width - marginL - marginR;
  const charsPerPixel = 1 / (fontSize * 0.55); // приблизительная ширина символа
  const autoMaxChars = Math.floor(usableWidth * charsPerPixel);
  const maxCharsPerLine = Number(subtitleStyle.maxCharsPerLine || Math.max(10, Math.min(40, autoMaxChars)));

  const primaryColour = assColorFromHex(subtitleStyle.primaryColor || '#FFFFFF', '&H00FFFFFF');
  const outlineColour = assColorFromHex(subtitleStyle.outlineColor || '#000000', '&H00000000');
  const backColour = assColorFromHex(subtitleStyle.backColor || '#000000', '&H00000000');

  // Цвета активного слова
  // word-highlight: фоновый блок (дефолт фиолетовый)
  // single-word: без фонового блока (дефолт прозрачный), слово просто крупное
  // phrase: не используется
  const activeWordTextColour = subtitleMode === 'word-highlight'
    ? assColorFromHex(subtitleStyle.activeWordTextColor || '#FFFFFF', '&H00FFFFFF')
    : primaryColour;
  const activeWordOutlineColour = subtitleMode === 'word-highlight'
    ? assColorFromHex(subtitleStyle.activeWordBackColor || '#8B5CF6', '&H00F65C8B')
    : outlineColour;
  const activeWordBackColour = subtitleMode === 'word-highlight'
    ? assColorFromHex(subtitleStyle.activeWordBackColor || '#8B5CF6', '&H00F65C8B')
    : backColour; // single-word и phrase — без отдельного фонового блока
  const keywordColour = assColorFromHex(subtitleStyle.keywordColor || '#FFD700', '&H0000D7FF');

  // Пробрасываем вычисленный maxCharsPerLine в subtitleStyle если не задан вручную
  if (!subtitleStyle.maxCharsPerLine) {
    subtitleStyle = { ...subtitleStyle, maxCharsPerLine };
  }

  const subtitleAnimation = String(subtitleStyle.animation || 'none').trim().toLowerCase();
  let animTag = '';
  if (subtitleAnimation === 'fade') {
    animTag = '{\\fad(200,150)}';
  } else if (subtitleAnimation === 'pop') {
    animTag = '{\\fad(80,100)\\t(0,120,\\fscx110\\fscy110)\\t(120,220,\\fscx100\\fscy100)}';
  } else if (subtitleAnimation === 'slide-up') {
    animTag = '{\\move(540,1080,540,960,0,200)}';
  } else if (subtitleAnimation === 'bounce') {
    animTag = '{\\fad(60,80)\\t(0,100,\\fscx115\\fscy115)\\t(100,180,\\fscx95\\fscy95)\\t(180,250,\\fscx102\\fscy102)\\t(250,300,\\fscx100\\fscy100)}';
  }

  // Нормализуем wordTimings или генерируем fallback по длительности аудио
  let normalizedWordTimings = normalizeWordTimings(wordTimings);
  if (!normalizedWordTimings.length && subtitlesText && duration > 0) {
    normalizedWordTimings = generateWordTimingsFromDuration(subtitlesText, duration);
  }

  const phraseEvents = scenePlan.length > 0
    ? buildTimedDialogueEventsFromScenePlan(scenePlan, subtitleStyle)
    : buildTimedDialogueEvents({
        subtitlesText,
        duration,
        subtitleStyle
      });

  const events = subtitleMode === 'word-highlight'
    ? (normalizedWordTimings.length
        ? buildWordHighlightEventsFromWordTimings(normalizedWordTimings, subtitleStyle, highlightKeywords)
        : buildWordHighlightEventsFromPhraseEvents(phraseEvents, subtitleStyle, highlightKeywords))
    : subtitleMode === 'single-word'
    ? buildSingleWordEvents(normalizedWordTimings.length ? normalizedWordTimings : phraseEvents, subtitleStyle, !!normalizedWordTimings.length, highlightKeywords)
    : phraseEvents;

  // Прямоугольный блок активного слова
  // word-highlight: BorderStyle:3 (opaque box) с цветным фоном
  // single-word/phrase: BorderStyle:1 (outline only) без фонового блока
  const activeBoxPad = Math.round(fontSize * 0.20);
  const activeBorderStyle = subtitleMode === 'word-highlight' ? 3 : 1;
  const activeOutline = subtitleMode === 'word-highlight' ? activeBoxPad : outline;
  const activeShadow = subtitleMode === 'word-highlight' ? 0 : shadow;

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColour},${primaryColour},${outlineColour},${backColour},${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1
Style: ActiveWord,${fontName},${fontSize},${activeWordTextColour},${activeWordTextColour},${activeWordOutlineColour},${activeWordBackColour},${bold},0,0,0,100,100,0,0,${activeBorderStyle},${activeOutline},${activeShadow},${alignment},${marginL},${marginR},${marginV},1
Style: KeyWord,${fontName},${fontSize},${keywordColour},${keywordColour},${outlineColour},${backColour},${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.map((e) => `Dialogue: 0,${formatAssTime(e.start)},${formatAssTime(e.end)},Default,,0,0,0,,${animTag}${e.text}`).join('\n')}
`;
}

function applySubtitlePreset(subtitleStyle = {}) {
  const presetName = String(subtitleStyle.preset || 'custom').trim().toLowerCase();
  const presets = {
    'capcut-white': {
      mode: 'word-highlight',
      fontName: 'Inter:bold',
      fontSize: 78,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      outline: 4,
      activeWordTextColor: '#FFFFFF',
      activeWordBackColor: '#7C3AED',
      animation: 'pop'
    },
    'yellow-pop': {
      mode: 'single-word',
      fontName: 'Montserrat:bold',
      fontSize: 96,
      primaryColor: '#FFE600',
      outlineColor: '#000000',
      outline: 5,
      animation: 'bounce'
    },
    'minimal-clean': {
      mode: 'phrase',
      fontName: 'Inter',
      fontSize: 64,
      primaryColor: '#FFFFFF',
      outlineColor: '#111111',
      outline: 2,
      animation: 'fade'
    },
    'black-box': {
      mode: 'phrase',
      fontName: 'Inter:bold',
      fontSize: 68,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      backColor: '#000000',
      outline: 3,
      animation: 'fade'
    },
    'neon-green': {
      mode: 'word-highlight',
      fontName: 'Montserrat:bold',
      fontSize: 82,
      primaryColor: '#FFFFFF',
      outlineColor: '#00FF66',
      outline: 4,
      activeWordTextColor: '#000000',
      activeWordBackColor: '#00FF66',
      animation: 'pop'
    },
    'red-impact': {
      mode: 'single-word',
      fontName: 'BebasNeue:bold',
      fontSize: 112,
      primaryColor: '#FFFFFF',
      outlineColor: '#FF1744',
      outline: 5,
      animation: 'pop'
    },
    'blue-karaoke': {
      mode: 'word-highlight',
      fontName: 'Roboto:bold',
      fontSize: 76,
      primaryColor: '#FFFFFF',
      outlineColor: '#000000',
      outline: 3,
      activeWordTextColor: '#FFFFFF',
      activeWordBackColor: '#2563EB',
      animation: 'slide-up'
    }
  };

  if (!presets[presetName]) return subtitleStyle;
  return {
    ...presets[presetName],
    ...subtitleStyle,
    preset: presetName
  };
}

/**
 * Подготавливает аудиофайл для FFmpeg pipeline:
 * 1. Удаляет встроенные видеопотоки (cover art из ID3-тегов)
 * 2. Перекодирует в MP3 для совместимости с -stream_loop (FFmpeg 5.1
 *    не поддерживает -stream_loop для M4A/MP4 контейнеров)
 *
 * Без этого шага FFmpeg падает с "Option loop not found" если аудио
 * в M4A-контейнере или содержит cover art неизвестного типа.
 */
async function prepareAudioFile(filePath) {
  const cleanPath = filePath + '.prepared.mp3';

  // Проверяем формат входного файла
  try {
    const { stdout: probeOut } = await runCommand('ffprobe', [
      '-v', 'error', '-show_entries', 'format=format_name',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]);
    console.log(`[prepareAudio] Input format of ${path.basename(filePath)}: "${probeOut.trim()}"`);
  } catch (pe) {
    console.warn(`[prepareAudio] Probe failed: ${pe.message}`);
  }

  // Стратегия 1: -map 0:a:0 — извлечь только первый аудиопоток, перекодировать в MP3
  try {
    await runFfmpeg([
      '-y', '-i', filePath,
      '-map', '0:a:0',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      '-map_metadata', '-1',
      cleanPath
    ]);
    if (await fs.pathExists(cleanPath)) {
      const stat = await fs.stat(cleanPath);
      if (stat.size > 1000) {
        await fs.move(cleanPath, filePath, { overwrite: true });
        console.log(`[prepareAudio] Strategy 1 OK (map 0:a:0): ${path.basename(filePath)}, size=${stat.size}`);
        return;
      }
      console.warn(`[prepareAudio] Strategy 1 output too small: ${stat.size} bytes`);
    }
    await fs.remove(cleanPath).catch(() => {});
  } catch (e1) {
    await fs.remove(cleanPath).catch(() => {});
    console.warn(`[prepareAudio] Strategy 1 failed: ${e1.message}`);
  }

  // Стратегия 2: -vn (без видео) + перекодирование
  try {
    await runFfmpeg([
      '-y', '-i', filePath,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      '-map_metadata', '-1',
      cleanPath
    ]);
    if (await fs.pathExists(cleanPath)) {
      const stat = await fs.stat(cleanPath);
      if (stat.size > 1000) {
        await fs.move(cleanPath, filePath, { overwrite: true });
        console.log(`[prepareAudio] Strategy 2 OK (-vn): ${path.basename(filePath)}, size=${stat.size}`);
        return;
      }
    }
    await fs.remove(cleanPath).catch(() => {});
  } catch (e2) {
    await fs.remove(cleanPath).catch(() => {});
    console.warn(`[prepareAudio] Strategy 2 failed: ${e2.message}`);
  }

  // Стратегия 3: через промежуточный WAV
  const rawPath = filePath + '.raw.wav';
  try {
    await runFfmpeg([
      '-y', '-i', filePath,
      '-vn', '-dn', '-sn',
      '-acodec', 'pcm_s16le',
      '-ar', '44100', '-ac', '2',
      rawPath
    ]);
    await runFfmpeg([
      '-y', '-i', rawPath,
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      cleanPath
    ]);
    await fs.remove(rawPath).catch(() => {});
    if (await fs.pathExists(cleanPath)) {
      const stat = await fs.stat(cleanPath);
      if (stat.size > 1000) {
        await fs.move(cleanPath, filePath, { overwrite: true });
        console.log(`[prepareAudio] Strategy 3 OK (via WAV): ${path.basename(filePath)}, size=${stat.size}`);
        return;
      }
    }
    await fs.remove(cleanPath).catch(() => {});
  } catch (e3) {
    await fs.remove(cleanPath).catch(() => {});
    await fs.remove(rawPath).catch(() => {});
    console.warn(`[prepareAudio] Strategy 3 failed: ${e3.message}`);
  }

  // Проверяем финальный формат
  try {
    const { stdout: finalProbe } = await runCommand('ffprobe', [
      '-v', 'error', '-show_entries', 'format=format_name',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]);
    console.error(`[prepareAudio] ALL strategies failed! File still: "${finalProbe.trim()}" — ${path.basename(filePath)}`);
  } catch (_) {}

  throw new Error(`Cannot prepare audio file: ${path.basename(filePath)} — file may be corrupt or unsupported format`);
}

async function normalizeMergeClip(inputPath, outputPath, width, height, fps) {
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-vf',
    `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p`,
    '-af',
    'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath
  ]);
}

async function mergeClipsConcat(clips, outputPath) {
  const concatListPath = path.join(path.dirname(outputPath), 'merge-list.txt');
  const concatLines = clips.map((clip) => `file '${clip.path.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(concatListPath, concatLines);
  try {
    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      outputPath
    ]);
  } finally {
    await fs.remove(concatListPath).catch(() => {});
  }
}

async function mergeClipsXfade(clips, outputPath, transitionType, transitionDuration) {
  const ffmpegArgs = ['-y'];
  clips.forEach((clip) => {
    ffmpegArgs.push('-i', clip.path);
  });

  const filterParts = [];
  clips.forEach((_, index) => {
    filterParts.push(`[${index}:v]setpts=PTS-STARTPTS[v${index}]`);
    filterParts.push(`[${index}:a]asetpts=PTS-STARTPTS[a${index}]`);
  });

  let previousVideo = 'v0';
  let previousAudio = 'a0';
  let cumulativeDuration = clips[0].duration;

  for (let i = 1; i < clips.length; i++) {
    const videoLabel = `vx${i}`;
    const audioLabel = `ax${i}`;
    const offset = Math.max(0.1, cumulativeDuration - transitionDuration);
    filterParts.push(
      `[${previousVideo}][v${i}]xfade=transition=${transitionType}:duration=${transitionDuration}:offset=${Number(offset.toFixed(3))}[${videoLabel}]`
    );
    filterParts.push(
      `[${previousAudio}][a${i}]acrossfade=d=${transitionDuration}:c1=tri:c2=tri[${audioLabel}]`
    );
    previousVideo = videoLabel;
    previousAudio = audioLabel;
    cumulativeDuration += clips[i].duration - transitionDuration;
  }

  ffmpegArgs.push(
    '-filter_complex', filterParts.join(';'),
    '-map', `[${previousVideo}]`,
    '-map', `[${previousAudio}]`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    outputPath
  );

  await runFfmpeg(ffmpegArgs);
}

async function processMergeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.status = 'processing';

    const jobDir = path.join(process.cwd(), 'storage', 'jobs', jobId);
    await fs.ensureDir(jobDir);

    const videos = normalizeMergeItems(job.payload);
    if (videos.length < 2) {
      throw new Error('videos must contain at least 2 items');
    }

    const { width, height, fps } = parseVideoSettings(job.payload);
    const mergeMode = String(job.payload.mergeMode || 'xfade').trim().toLowerCase();
    const transitionType = getAllowedTransition(job.payload.transitionType || 'fade');
    const transitionDuration = Math.min(2, Math.max(0.05, Number(job.payload.transitionDuration ?? 0.35)));
    const outputPath = path.join(process.cwd(), 'storage', 'output', `${jobId}.mp4`);

    const clips = [];
    for (let i = 0; i < videos.length; i++) {
      const sourcePath = path.join(jobDir, `source_${i + 1}${getExtFromUrl(videos[i].url, '.mp4')}`);
      const normalizedPath = path.join(jobDir, `clip_${i + 1}.mp4`);
      await downloadToFile(videos[i].url, sourcePath);
      await normalizeMergeClip(sourcePath, normalizedPath, width, height, fps);
      clips.push({
        path: normalizedPath,
        duration: await getMediaDuration(normalizedPath)
      });
    }

    if (mergeMode === 'cut') {
      await mergeClipsConcat(clips, outputPath);
    } else {
      await mergeClipsXfade(clips, outputPath, transitionType, transitionDuration);
    }

    const thumbnailPath = path.join(process.cwd(), 'storage', 'output', `${jobId}.jpg`);
    try {
      await runFfmpeg([
        '-y',
        '-ss', '0',
        '-i', outputPath,
        '-vframes', '1',
        '-q:v', '2',
        '-vf', 'scale=320:-1',
        thumbnailPath
      ]);
      job.thumbnailUrl = `${BASE_URL}/output/${jobId}.jpg`;
    } catch (e) {
      console.warn(`Thumbnail generation failed: ${e.message}`);
      job.thumbnailUrl = null;
    }

    job.status = 'done';
    job.videoUrl = `${BASE_URL}/output/${jobId}.mp4`;
    job.error = null;
    await sendWebhook(job);
  } catch (error) {
    job.status = 'fail';
    job.error = error.message;
    job.videoUrl = null;
    await sendWebhook(job);
  }
}

async function _processJobInner(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.status = 'processing';

    const jobDir = path.join(process.cwd(), 'storage', 'jobs', jobId);
    await fs.ensureDir(jobDir);

    const mediaItems = normalizeMediaItems(job.payload);
    const voiceUrl = job.payload.voiceMp3;
    const musicUrl = job.payload.musicMp3;
    const musicVolume = Number(job.payload.musicVolume ?? 0.15);
    const transitionType = getAllowedTransition(job.payload.transitionType);
    const { width, height, fps, bitratePreset, cleanMetadata } = parseVideoSettings(job.payload);
    const videoBitrate = getVideoBitrate(width, height, fps, bitratePreset);
    // Парсим *ключевые слова* из оригинального текста ДО очистки
    const { cleanText: subtitlesText, keywords: highlightKeywords } = parseKeywordsFromText(String(job.payload.subtitlesText || '').trim());
    const subtitleStyle = job.payload.subtitleStyle || {};
    const overlayStyle = job.payload.overlayStyle || {};
    const wordTimings = Array.isArray(job.payload.wordTimings) ? job.payload.wordTimings : [];
    const logoUrl = String(job.payload.logoUrl || '').trim();

    if (!mediaItems.length) {
      throw new Error('media must be a non-empty array');
    }

    const voicePath = path.join(jobDir, `voice${getExtFromUrl(voiceUrl, '.mp3')}`);
    const musicPath = musicUrl
      ? path.join(jobDir, `music${getExtFromUrl(musicUrl, '.mp3')}`)
      : null;
    const subtitlesPath = path.join(jobDir, 'subtitles.ass');
    const outputPath = path.join(process.cwd(), 'storage', 'output', `${jobId}.mp4`);
    const fontsDir = path.join(process.cwd(), 'storage', 'fonts');

    const preparedMedia = [];

    for (let i = 0; i < mediaItems.length; i++) {
      const item = mediaItems[i];
      const type = item.type === 'video' ? 'video' : 'image';
      const localPath = path.join(
        jobDir,
        `media_${i + 1}${getExtFromUrl(item.url, type === 'video' ? '.mp4' : '.jpg')}`
      );

      await downloadToFile(item.url, localPath);

      let sourceDuration = null;
      if (type === 'video') {
        sourceDuration = await getMediaDuration(localPath);
      }

      let smartFocus = null;
      if (type === 'image' && isSmartFocusMotion(item.motionSettings)) {
        smartFocus = await analyzeImageSmartFocus(localPath);
        if (smartFocus) {
          console.log(`[smart-focus] frame ${i + 1}: x=${smartFocus.xFactor.toFixed(2)} y=${smartFocus.yFactor.toFixed(2)}`);
        } else {
          console.log(`[smart-focus] frame ${i + 1}: fallback to auto direction`);
        }
      }

      preparedMedia.push({
        ...item,
        type,
        localPath,
        sourceDuration,
        smartFocus
      });
    }

    await downloadToFile(voiceUrl, voicePath);
    await prepareAudioFile(voicePath);

    // Верификация: проверяем что voice — MP3 после подготовки
    try {
      const { stdout: vfmt } = await runCommand('ffprobe', [
        '-v', 'error', '-show_entries', 'format=format_name:stream=codec_type',
        '-of', 'json', voicePath
      ]);
      console.log(`[verify] Voice after prepare: ${vfmt.trim()}`);
    } catch (_) {}

    if (musicUrl && musicPath) {
      await downloadToFile(musicUrl, musicPath);
      await prepareAudioFile(musicPath);
    }

    const voiceDuration = await getMediaDuration(voicePath);

    if (!Number.isFinite(voiceDuration) || voiceDuration <= 0) {
      throw new Error('Invalid voice duration');
    }

    let transitionDuration = 0;
    if (preparedMedia.length > 1) {
      const safeTransition = Math.min(
        0.5,
        Math.max(0.15, (voiceDuration / preparedMedia.length) * 0.35)
      );
      transitionDuration = Number(safeTransition.toFixed(3));
    }

    const scenePlan = buildScenePlan({
      mediaItems: preparedMedia,
      voiceDuration,
      subtitlesText,
      subtitleStyle,
      transitionDuration
    });
    const finalVideoDuration = scenePlan.length
      ? scenePlan[scenePlan.length - 1].visibleEnd
      : voiceDuration;
    const audioPadDuration = Math.max(0, Number((finalVideoDuration - voiceDuration).toFixed(3)));

    // Зацикливаем музыку до фактической длительности ролика.
    if (musicUrl && musicPath) {
      const loopedMusicPath = musicPath + '.looped.mp3';
      try {
        const musicDuration = await getMediaDuration(musicPath);
        if (musicDuration > 0 && musicDuration < finalVideoDuration + 5) {
          const loopCount = Math.ceil((finalVideoDuration + 5) / musicDuration);
          const concatListPath = musicPath + '.concat.txt';
          const concatLines = Array(loopCount).fill(`file '${musicPath}'`).join('\n');
          await fs.writeFile(concatListPath, concatLines);
          await runFfmpeg([
            '-y', '-f', 'concat', '-safe', '0',
            '-i', concatListPath,
            '-t', String(Math.ceil(finalVideoDuration + 5)),
            '-c:a', 'libmp3lame', '-q:a', '2',
            loopedMusicPath
          ]);
          await fs.move(loopedMusicPath, musicPath, { overwrite: true });
          await fs.remove(concatListPath).catch(() => {});
          console.log(`[music] Looped ${loopCount}x to cover ${finalVideoDuration.toFixed(1)}s`);
        }
      } catch (loopErr) {
        await fs.remove(loopedMusicPath).catch(() => {});
        console.warn(`[music] Loop failed: ${loopErr.message} — using original music file`);
      }
    }

    if (subtitlesText || scenePlan.some((scene) => scene.blockText)) {
      const assContent = buildAssContent({
        width,
        height,
        duration: finalVideoDuration,
        subtitlesText,
        subtitleStyle,
        scenePlan,
        wordTimings,
        highlightKeywords
      });

      await fs.writeFile(subtitlesPath, assContent, 'utf8');
    }

    const ffmpegArgs = ['-y'];

    for (const scene of scenePlan) {
      if (scene.type === 'image') {
        ffmpegArgs.push(
          '-loop', '1',
          '-t', String(Number(scene.inputDuration.toFixed(3))),
          '-i', scene.localPath
        );
      } else {
        // Видеоклип: явно указываем только видеопоток (-vn не нужен, но убираем лишние потоки через map)
        ffmpegArgs.push('-i', scene.localPath);
      }
    }

    // Cover art уже удалён prepareAudioFile() — безопасно подавать как обычный аудио-вход
    ffmpegArgs.push('-i', voicePath);

    const voiceInputIndex = scenePlan.length;
    let musicInputIndex = null;
    let logoInputIndex = null;

    if (musicUrl && musicPath) {
      // Музыка уже зациклена prepareAudioFile + concat — подаём как обычный вход
      ffmpegArgs.push('-i', musicPath);
      musicInputIndex = scenePlan.length + 1;
    }

    // Логотип: скачиваем и добавляем как входной поток
    let logoPath = null;
    if (logoUrl) {
      logoPath = path.join(jobDir, `logo${getExtFromUrl(logoUrl, '.png')}`);
      try {
        await downloadToFile(logoUrl, logoPath);
        ffmpegArgs.push('-i', logoPath);
        logoInputIndex = scenePlan.length + (musicInputIndex !== null ? 2 : 1);
      } catch (e) {
        console.warn(`Logo download failed (${logoUrl}): ${e.message} — skipping logo`);
        logoPath = null;
      }
    }

    const filterParts = [];

    for (let i = 0; i < scenePlan.length; i++) {
      const scene = scenePlan[i];

      if (scene.type === 'image') {
        filterParts.push(
          buildImageMotionFilter(scene, i, width, height, subtitleStyle.motionPreset, fps)
        );
      } else {
        const padDuration = Math.max(0, Number(scene.inputDuration) - Number(scene.sourceDuration || 0));
        const videoFilters = [
          `scale=${width}:${height}:force_original_aspect_ratio=increase`,
          `crop=${width}:${height}`,
          `setsar=1`,
          `fps=${fps}`,
          `format=yuv420p`
        ];

        if (scene.videoBehavior === 'loop' && padDuration > 0.02) {
          videoFilters.push(`loop=loop=-1:size=${Math.max(1, Math.ceil(Number(scene.sourceDuration || 1) * fps))}:start=0`);
        } else if (scene.videoBehavior === 'freeze' && padDuration > 0.02) {
          videoFilters.push(`tpad=stop_mode=clone:stop_duration=${Number(padDuration.toFixed(3))}`);
        }

        videoFilters.push(`trim=duration=${Number(scene.inputDuration.toFixed(3))}`);
        videoFilters.push('setpts=PTS-STARTPTS');

        filterParts.push(
          `[${i}:v]${videoFilters.join(',')}[v${i}]`
        );
      }

      // Наложение текстовой надписи поверх сцены (если задана)
      const sceneOverlayText = String(scene.overlayText || '').trim();
      if (sceneOverlayText) {
        const dtLabel = `vdt${i}`;
        filterParts.push(
          buildSceneDrawtextFilter(
            sceneOverlayText,
            `v${i}`,
            dtLabel,
            getSceneOverlayStyle(scene.overlayStyle, overlayStyle),
            width,
            height,
            fontsDir
          )
        );
        // Переименовываем лейбл сцены так, чтобы xfade использовал уже с надписью
        filterParts.push(`[${dtLabel}]null[v${i}r]`);
      } else {
        filterParts.push(`[v${i}]null[v${i}r]`);
      }
    }

    let finalVideoLabel = 'v0r';

    if (scenePlan.length > 1) {
      let previousLabel = 'v0r';
      let cumulativeVisible = scenePlan[0].visibleDuration;

      for (let i = 1; i < scenePlan.length; i++) {
        const xfadeLabel = `x${i}`;
        const offset = Number(cumulativeVisible.toFixed(3));
        // Если режим random — каждый переход выбирается заново независимо
        const thisTransition = transitionType === 'random' ? getRandomTransition() : transitionType;

        filterParts.push(
          `[${previousLabel}][v${i}r]xfade=transition=${thisTransition}:duration=${transitionDuration}:offset=${offset}[${xfadeLabel}]`
        );

        previousLabel = xfadeLabel;
        cumulativeVisible += scenePlan[i].visibleDuration;
      }

      finalVideoLabel = previousLabel;
    }

    if (subtitlesText || scenePlan.some((scene) => scene.blockText)) {
      const escapedSubtitlesPath = escapeFfmpegFilterPath(subtitlesPath);
      const escapedFontsDir = escapeFfmpegFilterPath(fontsDir);
      const subtitleVideoLabel = 'vsub';

      filterParts.push(
        `[${finalVideoLabel}]subtitles=filename='${escapedSubtitlesPath}':fontsdir='${escapedFontsDir}'[${subtitleVideoLabel}]`
      );

      finalVideoLabel = subtitleVideoLabel;
    }

    // Логотип: накладываем в выбранную позицию (по умолчанию правый верхний угол)
    if (logoPath && logoInputIndex !== null) {
      const logoMargin = Math.round(width * 0.03);
      const logoMaxW = Math.round(width * 0.20); // не больше 20% ширины
      const logoLabel = 'vlogo';
      const logoPosition = String(job.payload.logoPosition || 'top-right').toLowerCase();

      let logoX, logoY;
      if (logoPosition === 'top-left') {
        logoX = `${logoMargin}`;
        logoY = `${logoMargin}`;
      } else if (logoPosition === 'top-center') {
        logoX = `(W-w)/2`;
        logoY = `${logoMargin}`;
      } else if (logoPosition === 'top-right') {
        logoX = `W-w-${logoMargin}`;
        logoY = `${logoMargin}`;
      } else if (logoPosition === 'bottom-left') {
        logoX = `${logoMargin}`;
        logoY = `H-h-${logoMargin}`;
      } else if (logoPosition === 'bottom-center') {
        logoX = `(W-w)/2`;
        logoY = `H-h-${logoMargin}`;
      } else if (logoPosition === 'bottom-right') {
        logoX = `W-w-${logoMargin}`;
        logoY = `H-h-${logoMargin}`;
      } else {
        // fallback: top-right
        logoX = `W-w-${logoMargin}`;
        logoY = `${logoMargin}`;
      }

      filterParts.push(
        `[${logoInputIndex}:v]scale=${logoMaxW}:-1:force_original_aspect_ratio=decrease[logoScaled]`
      );
      filterParts.push(
        `[${finalVideoLabel}][logoScaled]overlay=x=${logoX}:y=${logoY}:format=auto[${logoLabel}]`
      );
      finalVideoLabel = logoLabel;
    }

    if (musicUrl && musicPath && musicInputIndex !== null) {
      const voiceFilters = [
        `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo`
      ];
      if (audioPadDuration > 0.02) {
        voiceFilters.push(`apad=pad_dur=${audioPadDuration}`);
      }
      filterParts.push(
        `[${voiceInputIndex}:a]${voiceFilters.join(',')}[voice]`
      );
      filterParts.push(
        `[${musicInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${musicVolume}[music]`
      );
      filterParts.push(
        `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[a]`
      );
    } else if (audioPadDuration > 0.02) {
      filterParts.push(
        `[${voiceInputIndex}:a]apad=pad_dur=${audioPadDuration}[voiceOnly]`
      );
    }

    ffmpegArgs.push(
      '-filter_complex',
      filterParts.join(';'),
      '-map', `[${finalVideoLabel}]`
    );

    if (musicUrl && musicPath && musicInputIndex !== null) {
      ffmpegArgs.push('-map', '[a]');
    } else if (audioPadDuration > 0.02) {
      ffmpegArgs.push('-map', '[voiceOnly]');
    } else {
      ffmpegArgs.push('-map', `${voiceInputIndex}:a`);
    }

    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', videoBitrate,
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      outputPath
    );

    if (cleanMetadata) {
      ffmpegArgs.splice(ffmpegArgs.length - 1, 0,
        '-x264-params', 'no-info=1',
        '-map_metadata', '-1',
        '-map_chapters', '-1',
        '-metadata', 'title=',
        '-metadata', 'artist=',
        '-metadata', 'comment=',
        '-metadata', 'description=',
        '-metadata', 'encoder='
      );
    }

    // Логируем финальную FFmpeg-команду для отладки
    console.log(`[ffmpeg] Final command: ffmpeg ${ffmpegArgs.join(' ').substring(0, 2000)}`);

    await runFfmpeg(ffmpegArgs);

    // Генерируем thumbnail — первый кадр видео (320px по ширине)
    const thumbnailPath = path.join(process.cwd(), 'storage', 'output', `${jobId}.jpg`);
    try {
      await runFfmpeg([
        '-y',
        '-ss', '0',
        '-i', outputPath,
        '-vframes', '1',
        '-q:v', '2',
        '-vf', 'scale=320:-1',
        thumbnailPath
      ]);
      job.thumbnailUrl = `${BASE_URL}/output/${jobId}.jpg`;
    } catch (e) {
      console.warn(`Thumbnail generation failed: ${e.message}`);
      job.thumbnailUrl = null;
    }

    job.status = 'done';
    job.videoUrl = `${BASE_URL}/output/${jobId}.mp4`;
    job.error = null;
    await sendWebhook(job);
  } catch (error) {
    job.status = 'fail';
    job.error = error.message;
    job.videoUrl = null;
    await sendWebhook(job);
  }
}

async function processJob(jobId) {
  while (activeJobs >= MAX_CONCURRENT_JOBS) {
    await new Promise((r) => setTimeout(r, 3000));
  }
  activeJobs++;
  try {
    const job = jobs.get(jobId);
    if (job?.type === 'merge') {
      await processMergeJob(jobId);
    } else {
      await _processJobInner(jobId);
    }
  } finally {
    activeJobs--;
  }
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'video-service',
    message: 'Service is running'
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'healthy'
  });
});

app.post('/render', authMiddleware, (req, res) => {
  const {
    frames = [],
    media = [],
    images = [],
    voiceMp3 = '',
    musicMp3 = '',
    musicVolume = 0.15,
    subtitlesText = '',
    transitionType = 'fade',
    videoPreset = '',
    orientation = '',
    quality = '',
    fps = '',
    bitratePreset = '',
    cleanMetadata = true,
    videoSettings = {},
    resolution = '1080x1920',
    subtitleStyle = {},
    overlayStyle = {},
    logoUrl = '',
    logoPosition = 'top-right',
    wordTimings = [],
    webhookUrl = ''
  } = req.body || {};

  const normalizedMedia = normalizeMediaItems({ frames, media, images });

  if (!normalizedMedia.length) {
    return res.status(400).json({
      ok: false,
      error: 'media must be a non-empty array'
    });
  }

  if (!voiceMp3) {
    return res.status(400).json({
      ok: false,
      error: 'voiceMp3 is required'
    });
  }

  const jobId = uuidv4();

  jobs.set(jobId, {
    jobId,
    status: 'queued',
    createdAt: new Date().toISOString(),
    payload: {
      media: normalizedMedia,
      frames,
      images,
      voiceMp3,
      musicMp3,
      musicVolume,
      subtitlesText,
      transitionType,
      videoPreset,
      orientation,
      quality,
      fps,
      bitratePreset,
      cleanMetadata,
      videoSettings,
      resolution,
      subtitleStyle,
      overlayStyle,
      logoUrl,
      logoPosition: String(logoPosition || 'top-right').trim(),
      wordTimings,
      webhookUrl: String(webhookUrl || '').trim()
    },
    videoUrl: null,
    thumbnailUrl: null,
    error: null
  });

  processJob(jobId);

  res.json({
    ok: true,
    jobId,
    status: 'queued'
  });
});

app.post('/merge', authMiddleware, (req, res) => {
  const {
    videos = [],
    videoUrls = [],
    mergeMode = 'xfade',
    transitionType = 'fade',
    transitionDuration = 0.35,
    videoPreset = '',
    orientation = '',
    quality = '',
    fps = '',
    resolution = '1080x1920',
    webhookUrl = ''
  } = req.body || {};

  const normalizedVideos = normalizeMergeItems({ videos, videoUrls });

  if (normalizedVideos.length < 2) {
    return res.status(400).json({
      ok: false,
      error: 'videos must contain at least 2 items'
    });
  }

  const jobId = uuidv4();

  jobs.set(jobId, {
    jobId,
    type: 'merge',
    status: 'queued',
    createdAt: new Date().toISOString(),
    payload: {
      videos: normalizedVideos,
      mergeMode,
      transitionType,
      transitionDuration,
      videoPreset,
      orientation,
      quality,
      fps,
      resolution,
      webhookUrl: String(webhookUrl || '').trim()
    },
    videoUrl: null,
    thumbnailUrl: null,
    error: null
  });

  processJob(jobId);

  res.json({
    ok: true,
    jobId,
    status: 'queued'
  });
});

app.get('/status/:jobId', authMiddleware, (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: 'Job not found'
    });
  }

  const queuePosition = job.status === 'queued'
    ? [...jobs.values()].filter((j) => j.status === 'queued' && j.createdAt < job.createdAt).length
    : 0;

  res.json({
    ok: true,
    jobId: job.jobId,
    status: job.status,
    queuePosition,
    error: job.error
  });
});

app.get('/result/:jobId', authMiddleware, (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: 'Job not found'
    });
  }

  res.json({
    ok: true,
    jobId: job.jobId,
    status: job.status,
    videoUrl: job.videoUrl,
    thumbnailUrl: job.thumbnailUrl || null,
    error: job.error
  });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Video service started on port ${PORT}`);
  });
}

module.exports = {
  app,
  analyzeImageSmartFocus,
  applySubtitlePreset,
  assColorFromHex,
  buildAssContent,
  buildImageMotionFilter,
  buildScenePlan,
  getAllowedTransition,
  normalizeImageMotion,
  normalizeMediaItems,
  normalizeMotionSettings,
  normalizeSpokenSubtitleTerms,
  normalizeWordTimings,
  parseVideoSettings,
  sanitizeAssText
};
