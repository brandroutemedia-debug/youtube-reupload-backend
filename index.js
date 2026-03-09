// v4
const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COOKIES_PATH = path.join("/tmp", "cookies.txt");

function ensureCookiesFile() {
  var cookiesContent = process.env.YOUTUBE_COOKIES;
  if (cookiesContent) {
    // Ensure Netscape header is present
    var header = "# Netscape HTTP Cookie File";
    if (cookiesContent.indexOf(header) === -1) {
      cookiesContent = header + "\n" + cookiesContent;
    }
    // Fix lines: remove empty lines and ensure proper format
    var lines = cookiesContent.split("\n");
    var cleaned = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.length > 0) {
        cleaned.push(line);
      }
    }
    var finalContent = cleaned.join("\n") + "\n";
    fs.writeFileSync(COOKIES_PATH, finalContent, "utf8");
    console.log("Cookies file written to " + COOKIES_PATH);
    console.log("Cookie lines: " + cleaned.length);
    return true;
  }
  console.warn("No YOUTUBE_COOKIES environment variable found");
  return false;
}

const hasCookies = ensureCookiesFile();

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
    console.error("Failed to update status to " + status + ":", err.message);
  }
}

function run(cmd) {
  return new Promise(function(resolve, reject) {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, function(err, stdout, stderr) {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function getYtDlpCmd(sourceUrl, outputFile) {
  var cookiesFlag = hasCookies ? ' --cookies "' + COOKIES_PATH + '"' : "";
  return 'yt-dlp --js-runtimes node -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4' + cookiesFlag + ' -o "' + outputFile + '" "' + sourceUrl + '"';
}

app.post("/api/reupload", async function(req, res) {
  var body = req.body;
  var job_id = body.job_id;
  var source_url = body.source_url;
  var source_video_id = body.source_video_id;
  var destination_channel_id = body.destination_channel_id;
  var google_refresh_token = body.google_refresh_token;
  var webhook_url = body.webhook_url;
  var custom_title = body.custom_title;
  var custom_description = body.custom_description;

  if (!job_id || !source_url || !webhook_url || !google_refresh_token) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  res.json({ accepted: true, job_id: job_id });

  var workDir = path.join("/tmp", job_id);
  var rawFile = path.join(workDir, "video.mp4");
  var mutedFile = path.join(workDir, "muted.mp4");

  try {
    fs.mkdirSync(workDir, { recursive: true });

    await updateStatus(webhook_url, job_id, "downloading");
    await run(getYtDlpCmd(source_url, rawFile));
    if (!fs.existsSync(rawFile)) throw new Error("Download failed");

    await updateStatus(webhook_url, job_id, "muting");
    await run('ffmpeg -i "' + rawFile + '" -an -c:v copy "' + mutedFile + '" -y');
    if (!fs.existsSync(mutedFile)) throw new Error("Muting failed");

    await updateStatus(webhook_url, job_id, "uploading");
    var auth = getOAuth2Client(google_refresh_token);
    var youtube = google.youtube({ version: "v3", auth: auth });

    var title = custom_title || "Re-uploaded video";
    var description = custom_description || "";

    if (!custom_title && source_video_id) {
      try {
        var metaRes = await youtube.videos.list({ part: ["snippet"], id: [source_video_id] });
        if (metaRes.data.items && metaRes.data.items.length > 0) {
          title = metaRes.data.items[0].snippet.title || title;
          description = metaRes.data.items[0].snippet.description || description;
        }
      } catch (e) {}
    }

    var uploadRes = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title: title, description: description, categoryId: "22" },
        status: { privacyStatus: "private" },
      },
      media: { body: fs.createReadStream(mutedFile) },
    });

    await updateStatus(webhook_url, job_id, "done", { uploaded_video_id: uploadRes.data.id });
  } catch (err) {
    await updateStatus(webhook_url, job_id, "failed", { error_message: err.message });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
});

app.get("/health", function(req, res) { res.json({ ok: true, cookies: hasCookies }); });

app.listen(PORT, function() { console.log("Server running on port " + PORT); });
