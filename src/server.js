const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs-extra');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

fs.ensureDirSync('storage/jobs');
fs.ensureDirSync('storage/temp');
fs.ensureDirSync('storage/output');
fs.ensureDirSync('storage/fonts');

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Video service started on port ${PORT}`);
});
