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

async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.status = 'processing';

    const jobDir = path.join(process.cwd(), 'storage', 'jobs', jobId);
    await fs.ensureDir(jobDir);

    const imageUrls = job.payload.images || [];
    const voiceUrl = job.payload.voiceMp3;
    const musicUrl = job.payload.musicMp3;
    const musicVolume = Number(job.payload.musicVolume ?? 0.15);
    const transitionType = getAllowedTransition(job.payload.transitionType);
    const { width, height } = parseResolution(job.payload.resolution);

    const voicePath = path.join(jobDir, `voice${getExtFromUrl(voiceUrl, '.mp3')}`);
    const musicPath = musicUrl
      ? path.join(jobDir, `music${getExtFromUrl(musicUrl, '.mp3')}`)
      : null;
    const outputPath = path.join(process.cwd(), 'storage', 'output', `${jobId}.mp4`);

    const imagePaths = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      const imagePath = path.join(jobDir, `image_${i + 1}${getExtFromUrl(imageUrl, '.jpg')}`);
      await downloadToFile(imageUrl, imagePath);
      imagePaths.push(imagePath);
    }

    await downloadToFile(voiceUrl, voicePath);

    if (musicUrl && musicPath) {
      await downloadToFile(musicUrl, musicPath);
    }

    const voiceDuration = await getMediaDuration(voicePath);

    if (!Number.isFinite(voiceDuration) || voiceDuration <= 0) {
      throw new Error('Invalid voice duration');
    }

    const imageCount = imagePaths.length;

    let transitionDuration = 0;
    if (imageCount > 1) {
      const safeTransition = Math.min(0.5, Math.max(0.15, (voiceDuration / imageCount) * 0.6));
      transitionDuration = Number(safeTransition.toFixed(3));
    }

    const inputImageDuration = imageCount === 1
      ? Number(voiceDuration.toFixed(3))
      : Number(((voiceDuration + ((imageCount - 1) * transitionDuration)) / imageCount).toFixed(3));

    if (!Number.isFinite(inputImageDuration) || inputImageDuration <= 0) {
      throw new Error('Invalid per-image duration');
    }

    if (imageCount > 1 && inputImageDuration <= transitionDuration) {
      throw new Error('Transition duration is too large for current voice duration');
    }

    const ffmpegArgs = ['-y'];

    for (let i = 0; i < imagePaths.length; i++) {
      ffmpegArgs.push(
        '-loop', '1',
        '-t', String(inputImageDuration),
        '-i', imagePaths[i]
      );
    }

    ffmpegArgs.push('-i', voicePath);

    const voiceInputIndex = imagePaths.length;
    let musicInputIndex = null;

    if (musicUrl && musicPath) {
      ffmpegArgs.push(
        '-stream_loop', '-1',
        '-i', musicPath
      );
      musicInputIndex = imagePaths.length + 1;
    }

    const filterParts = [];

    for (let i = 0; i < imagePaths.length; i++) {
      filterParts.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},setsar=1,fps=25,format=yuv420p[v${i}]`
      );
    }

    let finalVideoLabel = 'v0';

    if (imageCount > 1) {
      let previousLabel = 'v0';

      for (let i = 1; i < imageCount; i++) {
        const offset = Number(((inputImageDuration - transitionDuration) * i).toFixed(3));
        const xfadeLabel = `x${i}`;

        filterParts.push(
          `[${previousLabel}][v${i}]xfade=transition=${transitionType}:duration=${transitionDuration}:offset=${offset}[${xfadeLabel}]`
        );

        previousLabel = xfadeLabel;
      }

      finalVideoLabel = previousLabel;
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

  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'images must be a non-empty array'
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
