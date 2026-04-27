const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

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
  'fade', 'smoothleft', 'smoothright', 'slideleft', 'slideright',
  'zoomin', 'fadeblack', 'fadewhite', 'dissolve', 'pixelize',
  'circleopen', 'circleclose', 'radial',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown'
];

function getAllowedTransition(transitionType) {
  if (transitionType === 'random') {
    // Возвращаем 'random' — конкретный переход будет выбираться для каждой сцены отдельно
    return 'random';
  }
  return ALLOWED_TRANSITIONS.includes(transitionType) ? transitionType : 'fade';
}

function getRandomTransition() {
  return ALLOWED_TRANSITIONS[Math.floor(Math.random() * ALLOWED_TRANSITIONS.length)];
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

function normalizeMediaItems(payload = {}) {
  if (Array.isArray(payload.media) && payload.media.length > 0) {
    return payload.media
      .filter((item) => item && item.url)
      .map((item) => ({
        type: item.type || guessMediaTypeFromUrl(item.url),
        url: item.url,
        narrationText: String(item.narrationText || '').trim(),
        sceneRole: String(item.sceneRole || '').trim(),
        overlayText: String(item.overlayText || '').trim()
      }));
  }

  if (Array.isArray(payload.images) && payload.images.length > 0) {
    // images может быть массивом строк (URL) или объектов {url, overlayText}
    return payload.images.map((item) => {
      if (typeof item === 'string') {
        return { type: 'image', url: item, narrationText: '', sceneRole: '', overlayText: '' };
      }
      return {
        type: item.type || 'image',
        url: item.url || item,
        narrationText: String(item.narrationText || '').trim(),
        sceneRole: String(item.sceneRole || '').trim(),
        overlayText: String(item.overlayText || '').trim()
      };
    });
  }

  return [];
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

function sanitizeAssText(text) {
  return String(text || '')
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

  const visibleDurations = allocateDurationsByWeights(
    blockTexts,
    voiceDuration,
    Number(subtitleStyle.minSceneDuration) || 0.8
  );

  let visibleStart = 0;

  return mediaItems.map((item, index) => {
    const visibleDuration = visibleDurations[index];
    const inputDuration = index < mediaItems.length - 1
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

function buildHighlightedPhraseText(tokens, activeIndex, maxCharsPerLine = 28) {
  const lines = wrapWordTokens(tokens, maxCharsPerLine);

  return lines
    .map((line) =>
      line
        .map((token) => {
          if (token.index === activeIndex) {
            // \rActiveWord переключает стиль (цвет обводки = glow-цвет, Outline = большой)
            // \blur добавляет мягкое размытие ореола → эффект свечения без острых углов
            return `{\\rActiveWord\\blur4}${token.text}{\\rDefault\\blur0}`;
          }
          return token.text;
        })
        .join(' ')
    )
    .join('\\N');
}

function buildWordHighlightEventsFromPhraseEvents(phraseEvents, subtitleStyle = {}) {
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
        text: buildHighlightedPhraseText(tokens, i, maxCharsPerLine)
      });

      cursor += wordDuration;
    }
  }

  return result;
}

function normalizeWordTimings(wordTimings = []) {
  if (!Array.isArray(wordTimings)) return [];

  return wordTimings
    .map((item) => ({
      text: sanitizeAssText(item.text || '').replace(/\n+/g, ' ').trim(),
      start: Number(item.start),
      end: Number(item.end)
    }))
    .filter((item) =>
      item.text &&
      Number.isFinite(item.start) &&
      Number.isFinite(item.end) &&
      item.end > item.start
    )
    .sort((a, b) => a.start - b.start);
}

/**
 * Автоматическая генерация wordTimings по тексту и длительности аудио.
 * Используется как fallback, когда внешний сервис (Kie AI / ElevenLabs)
 * не вернул таймкоды. Распределяет время пропорционально длине слов.
 */
function generateWordTimingsFromDuration(text, duration) {
  if (!text || !duration || duration <= 0) return [];

  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
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

function buildWordHighlightEventsFromWordTimings(wordTimings, subtitleStyle = {}) {
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
        text: buildHighlightedPhraseText(phraseTokens, i, maxCharsPerLine)
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
  { dir: 'zoom-in-center',      zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.50, yFactor: 0.50 },
  { dir: 'zoom-out-center',     zoomStart: 1.15, zoomStep: -0.0010, zoomMax: 1.15, zoomMin: 1.0,  xFactor: 0.50, yFactor: 0.50 },
  { dir: 'zoom-in-topleft',     zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.20, yFactor: 0.20 },
  { dir: 'zoom-in-bottomright', zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.80, yFactor: 0.80 },
  { dir: 'zoom-out-left',       zoomStart: 1.15, zoomStep: -0.0010, zoomMax: 1.15, zoomMin: 1.0,  xFactor: 0.25, yFactor: 0.50 },
  { dir: 'zoom-in-topright',    zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.80, yFactor: 0.20 },
  { dir: 'zoom-in-bottomleft',  zoomStart: 1.0,  zoomStep: +0.0013, zoomMax: 1.13, zoomMin: null, xFactor: 0.20, yFactor: 0.80 },
  { dir: 'zoom-out-right',      zoomStart: 1.15, zoomStep: -0.0010, zoomMax: 1.15, zoomMin: 1.0,  xFactor: 0.75, yFactor: 0.50 }
];

function getImageMotionPreset(sceneIndex, motionPresetName) {
  if (motionPresetName) {
    const found = MOTION_PRESETS.find((p) => p.dir === motionPresetName);
    if (found) return found;
  }
  return MOTION_PRESETS[sceneIndex % MOTION_PRESETS.length];
}

function buildImageMotionFilter(scene, sceneIndex, width, height, motionPresetName) {
  const duration = Number(scene.inputDuration.toFixed(3));

  // Если motion отключён — просто scale+crop без zoompan
  if (motionPresetName === 'none') {
    return `[${sceneIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},` +
      `setsar=1,fps=25,format=yuv420p,trim=duration=${duration},setpts=PTS-STARTPTS[v${sceneIndex}]`;
  }

  const frames = Math.max(1, Math.ceil(Number(scene.inputDuration || 0) * 25));
  const motion = getImageMotionPreset(sceneIndex, motionPresetName);
  const xExpr = `(iw-iw/zoom)*${motion.xFactor}`;
  const yExpr = `(ih-ih/zoom)*${motion.yFactor}`;

  let zExpr;
  if (motion.zoomStep >= 0) {
    zExpr = `if(lte(on,1),${motion.zoomStart},min(zoom+${motion.zoomStep},${motion.zoomMax}))`;
  } else {
    const zMin = motion.zoomMin != null ? motion.zoomMin : 1.0;
    zExpr = `if(lte(on,1),${motion.zoomStart},max(zoom${motion.zoomStep},${zMin}))`;
  }

  return `[${sceneIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},` +
    `zoompan=` +
    `z='${zExpr}':` +
    `x='${xExpr}':` +
    `y='${yExpr}':` +
    `d=${frames}:s=${width}x${height}:fps=25,` +
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
    .replace(/'/g, "'")
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

function buildAssContent({
  width,
  height,
  duration,
  subtitlesText,
  subtitleStyle = {},
  scenePlan = [],
  wordTimings = []
}) {
  const fontName = subtitleStyle.fontName || 'Inter';
  const fontSize = Number(subtitleStyle.fontSize || Math.max(24, Math.round(height * 0.026)));
  const marginV = Number(subtitleStyle.marginV || Math.round(height * 0.11));
  const outline = Number(subtitleStyle.outline || 2);
  const shadow = Number(subtitleStyle.shadow || 0);
  const bold = subtitleStyle.bold === false ? 0 : 1;
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

  const activeWordTextColour = assColorFromHex(subtitleStyle.activeWordTextColor || '#FFFFFF', '&H00FFFFFF');
  const activeWordBackColour = assColorFromHex(subtitleStyle.activeWordBackColor || '#8B5CF6', '&H00F65C8B');
  const subtitleMode = String(subtitleStyle.mode || 'phrase').trim().toLowerCase();

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
  }



  // Нормализуем wordTimings или генерируем fallback по длительности аудио
  let normalizedWordTimings = normalizeWordTimings(wordTimings);
  if (!normalizedWordTimings.length && subtitlesText && duration > 0) {
    // Fallback: автоматическая генерация таймкодов по тексту и длительности
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
    ? (
        normalizedWordTimings.length
          ? buildWordHighlightEventsFromWordTimings(normalizedWordTimings, subtitleStyle)
          : buildWordHighlightEventsFromPhraseEvents(phraseEvents, subtitleStyle)
      )
    : phraseEvents;

  // Glow-эффект активного слова: толстая обводка цветом фона + blur → мягкое свечение
  // BorderStyle: 1 (обычная обводка), Outline = большой → цветной ореол вокруг слова
  const activeGlowBord = Math.round(fontSize * 0.38); // толщина ореола
  const activeGlowBlur = Math.round(fontSize * 0.25); // размытие ореола

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColour},${primaryColour},${outlineColour},${backColour},${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1
Style: ActiveWord,${fontName},${fontSize},${activeWordTextColour},${activeWordTextColour},${activeWordBackColour},&H00000000,${bold},0,0,0,100,100,0,0,1,${activeGlowBord},0,${alignment},${marginL},${marginR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.map((event) => `Dialogue: 0,${formatAssTime(event.start)},${formatAssTime(event.end)},Default,,0,0,0,,${animTag}${event.text}`).join('\n')}
`;
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
    const { width, height } = parseResolution(job.payload.resolution);
    const subtitlesText = String(job.payload.subtitlesText || '').trim();
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

      preparedMedia.push({
        ...item,
        type,
        localPath,
        sourceDuration
      });
    }

    await downloadToFile(voiceUrl, voicePath);

    if (musicUrl && musicPath) {
      await downloadToFile(musicUrl, musicPath);
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

    if (subtitlesText || scenePlan.some((scene) => scene.blockText)) {
      const assContent = buildAssContent({
        width,
        height,
        duration: voiceDuration,
        subtitlesText,
        subtitleStyle,
        scenePlan,
        wordTimings
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
        ffmpegArgs.push('-i', scene.localPath);
      }
    }

    ffmpegArgs.push('-i', voicePath);

    const voiceInputIndex = scenePlan.length;
    let musicInputIndex = null;
    let logoInputIndex = null;

    if (musicUrl && musicPath) {
      ffmpegArgs.push(
        '-stream_loop', '-1',
        '-i', musicPath
      );
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
          buildImageMotionFilter(scene, i, width, height, subtitleStyle.motionPreset)
        );
      } else {
        const padDuration = Math.max(0, Number(scene.inputDuration) - Number(scene.sourceDuration || 0));
        const videoFilters = [
          `scale=${width}:${height}:force_original_aspect_ratio=increase`,
          `crop=${width}:${height}`,
          `setsar=1`,
          `fps=25`,
          `format=yuv420p`
        ];

        if (padDuration > 0.02) {
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
          buildSceneDrawtextFilter(sceneOverlayText, `v${i}`, dtLabel, overlayStyle, width, height, fontsDir)
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
        `[${finalVideoLabel}]subtitles='${escapedSubtitlesPath}':fontsdir='${escapedFontsDir}'[${subtitleVideoLabel}]`
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
      filterParts.push(
        `[${voiceInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[voice]`
      );
      filterParts.push(
        `[${musicInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${musicVolume}[music]`
      );
      filterParts.push(
        `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[a]`
      );
    }

    ffmpegArgs.push(
      '-filter_complex',
      filterParts.join(';'),
      '-map', `[${finalVideoLabel}]`
    );

    if (musicUrl && musicPath && musicInputIndex !== null) {
      ffmpegArgs.push('-map', '[a]');
    } else {
      ffmpegArgs.push('-map', `${voiceInputIndex}:a`);
    }

    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-r', '25',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      outputPath
    );

    await runFfmpeg(ffmpegArgs);

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
    await _processJobInner(jobId);
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
    media = [],
    images = [],
    voiceMp3 = '',
    musicMp3 = '',
    musicVolume = 0.15,
    subtitlesText = '',
    transitionType = 'fade',
    resolution = '1080x1920',
    subtitleStyle = {},
    overlayStyle = {},
    logoUrl = '',
    logoPosition = 'top-right',
    wordTimings = [],
    webhookUrl = ''
  } = req.body || {};

  const normalizedMedia = normalizeMediaItems({ media, images });

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
      images,
      voiceMp3,
      musicMp3,
      musicVolume,
      subtitlesText,
      transitionType,
      resolution,
      subtitleStyle,
      overlayStyle,
      logoUrl,
      logoPosition: String(logoPosition || 'top-right').trim(),
      wordTimings,
      webhookUrl: String(webhookUrl || '').trim()
    },
    videoUrl: null,
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
    error: job.error
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video service started on port ${PORT}`);
});
