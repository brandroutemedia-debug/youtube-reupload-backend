/**
 * Railway Backend for Video Re-upload
 * 
 * Required environment variables:
 *   GOOGLE_CLIENT_ID        - OAuth 2.0 Client ID
 *   GOOGLE_CLIENT_SECRET    - OAuth 2.0 Client Secret
 *   REUPLOAD_WEBHOOK_SECRET - Shared secret for webhook auth
 *   PORT                    - Server port (Railway sets this automatically)
 */

const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function getOAuth2Client(refreshToken) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "urn:ietf:wg:oauth:2.0:oob"
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

async function updateStatus(webhookUrl, jobId, status, extra = {}) {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        status,
        secret: process.env.REUPLOAD_WEBHOOK_SECRET || "",
        ...extra,
      }),
    });
  } catch (err) {
    console.error(`Failed to update status to ${status}:`, err.message);
  }
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

app.post("/api/reupload", async (req, res) => {
  const {
    job_id, source_url, source_video_id, destination_channel_id,
    google_refresh_token, webhook_url, custom_title, custom_description,
  } = req.body;

  if (!job_id || !source_url || !webhook_url || !google_refresh_token) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  res.json({ accepted: true, job_id });

  const workDir = path.join("/tmp", job_id);
  const rawFile = path.join(workDir, "video.mp4");
  const mutedFile = path.join(workDir, "muted.mp4");

  try {
    fs.mkdirSync(workDir, { recursive: true });

    await updateStatus(webhook_url, job_id, "downloading");
    await run(`yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${rawFile}" "${source_url}"`);

    if (!fs.existsSync(rawFile)) {
      throw new Error("Download failed — file not found");
    }

    await updateStatus(webhook_url, job_id, "muting");
    await run(`ffmpeg -i "${rawFile}" -an -c:v copy "${mutedFile}" -y`);

    if (!fs.existsSync(mutedFile)) {
      throw new Error("Muting failed — file not found");
    }

    await updateStatus(webhook_url, job_id, "uploading");

    const auth = getOAuth2Client(google_refresh_token);
    const youtube = google.youtube({ version: "v3", auth });

    let title = custom_title || `Re-uploaded video ${source_video_id || ""}`;
    let description = custom_description || `Re-uploaded from ${source_url}`;

    if (!custom_title) {
      try {
        const metaRes = await youtube.videos.list({
          part: ["snippet"],
          id: [source_video_id],
        });
        if (metaRes.data.items && metaRes.data.items.length > 0) {
          const snippet = metaRes.data.items[0].snippet;
          title = snippet.title || title;
          description = snippet.description || description;
        }
      } catch (e) {
        console.log("Could not fetch source metadata:", e.message);
      }
    }

    const uploadRes = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title,
          description,
          categoryId: "22",
        },
        status: {
          privacyStatus: "private",
        },
      },
      media: {
        body: fs.createReadStream(mutedFile),
      },
    });

    const uploadedVideoId = uploadRes.data.id;
    await updateStatus(webhook_url, job_id, "done", { uploaded_video_id: uploadedVideoId });

    console.log(`✅ Job ${job_id} completed. Uploaded: ${uploadedVideoId}`);
  } catch (err) {
    console.error(`❌ Job ${job_id} failed:`, err.message);
    await updateStatus(webhook_url, job_id, "failed", { error_message: err.message });
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`🚀 Re-upload backend running on port ${PORT}`);
});
