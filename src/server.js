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

function getAllowedTransition(transitionType) {
  const allowedTransitions = [
    'fade',
    'smoothleft',
    'smoothright',
    'slideleft',
    'slideright'
  ];

  return allowedTransitions.includes(transitionType) ? transitionType : 'fade';
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
        narrationText: String(item.narrationText || '').trim()
      }));
  }

  if (Array.isArray(payload.images) && payload.images.length > 0) {
    return payload.images.map((url) => ({
      type: 'image',
      url,
      narrationText: ''
    }));
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
      text: wrapAssText(chunks[i], maxCharsPerLine)
    });

    cursor = end;
  }

  return events;
}

function escapeFfmpegFilterPath(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

function buildAssContent({
  width,
  height,
  duration,
  subtitlesText,
  subtitleStyle = {},
  scenePlan = []
}) {
  const fontName = subtitleStyle.fontName || 'Arial';
  const fontSize = Number(subtitleStyle.fontSize || Math.max(24, Math.round(height * 0.026)));
  const marginV = Number(subtitleStyle.marginV || Math.round(height * 0.11));
  const outline = Number(subtitleStyle.outline || 2);
  const shadow = Number(subtitleStyle.shadow || 0);
  const bold = subtitleStyle.bold === false ? 0 : 1;
  const alignment = Number(subtitleStyle.alignment || 2);
  const marginL = Number(subtitleStyle.marginL || 60);
  const marginR = Number(subtitleStyle.marginR || 60);

  const primaryColour = assColorFromHex(subtitleStyle.primaryColor || '#FFFFFF', '&H00FFFFFF');
  const outlineColour = assColorFromHex(subtitleStyle.outlineColor || '#000000', '&H00000000');
  const backColour = assColorFromHex(subtitleStyle.backColor || '#000000', '&H00000000');

  const events = scenePlan.length > 0
    ? buildTimedDialogueEventsFromScenePlan(scenePlan, subtitleStyle)
    : buildTimedDialogueEvents({
        subtitlesText,
        duration,
        subtitleStyle
      });

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColour},${primaryColour},${outlineColour},${backColour},${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.map((event) => `Dialogue: 0,${formatAssTime(event.start)},${formatAssTime(event.end)},Default,,0,0,0,,${event.text}`).join('\n')}
`;
}

async function processJob(jobId) {
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
        scenePlan
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

    if (musicUrl && musicPath) {
      ffmpegArgs.push(
        '-stream_loop', '-1',
        '-i', musicPath
      );
      musicInputIndex = scenePlan.length + 1;
    }

    const filterParts = [];

    for (let i = 0; i < scenePlan.length; i++) {
      const scene = scenePlan[i];

      if (scene.type === 'image') {
        filterParts.push(
          `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height},setsar=1,fps=25,format=yuv420p,` +
          `trim=duration=${Number(scene.inputDuration.toFixed(3))},setpts=PTS-STARTPTS[v${i}]`
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
        videoFilters.push(`setpts=PTS-STARTPTS`);

        filterParts.push(
          `[${i}:v]${videoFilters.join(',')}[v${i}]`
        );
      }
    }

    let finalVideoLabel = 'v0';

    if (scenePlan.length > 1) {
      let previousLabel = 'v0';
      let cumulativeVisible = scenePlan[0].visibleDuration;

      for (let i = 1; i < scenePlan.length; i++) {
        const xfadeLabel = `x${i}`;
        const offset = Number(cumulativeVisible.toFixed(3));

        filterParts.push(
          `[${previousLabel}][v${i}]xfade=transition=${transitionType}:duration=${transitionDuration}:offset=${offset}[${xfadeLabel}]`
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
  } catch (error) {
    job.status = 'fail';
    job.error = error.message;
    job.videoUrl = null;
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
    subtitlesText = '',
    transitionType = 'fade',
    musicVolume = 0.15,
    resolution = '1080x1920',
    subtitleStyle = {},
    logoUrl = ''
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
      subtitlesText,
      transitionType,
      musicVolume,
      resolution,
      subtitleStyle,
      logoUrl
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

  res.json({
    ok: true,
    jobId: job.jobId,
    status: job.status,
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
