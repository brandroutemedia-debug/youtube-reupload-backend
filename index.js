require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const WEBHOOK_SECRET = process.env.REUPLOAD_WEBHOOK_SECRET;

app.get('/', (req, res) => {
  res.json({ status: 'Backend is running!' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/reupload', async (req, res) => {
  const { secret, videoUrl, channelToken, title, description } = req.body;

  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const videoId = Date.now();
  const rawFile = `/tmp/raw_${videoId}.mp4`;
  const mutedFile = `/tmp/muted_${videoId}.mp4`;

  try {
    await runCommand(`yt-dlp -f "best[ext=mp4]" -o "${rawFile}" "${videoUrl}"`);
    await runCommand(`ffmpeg -i "${rawFile}" -an "${mutedFile}"`);

    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: channelToken });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const uploadRes = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title: title || 'Reupload', description: description || '' },
        status: { privacyStatus: 'public' },
      },
      media: { body: fs.createReadStream(mutedFile) },
    });

    fs.unlinkSync(rawFile);
    fs.unlinkSync(mutedFile);

    res.json({ success: true, youtubeId: uploadRes.data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

app.listen(3000, () => console.log('Server running on port 3000'));
