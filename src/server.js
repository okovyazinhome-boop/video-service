const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';

const jobs = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

fs.ensureDirSync('storage/jobs');
fs.ensureDirSync('storage/temp');
fs.ensureDirSync('storage/output');
fs.ensureDirSync('storage/fonts');

function authMiddleware(req, res, next) {
  if (!API_KEY) {
    return next();
  }

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
