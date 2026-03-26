const express = require("express");
const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const COOKIES_PATH = path.join("/tmp", "cookies.txt");
const MAX_CAPTURE_LENGTH = 12000;

exec("pip install -U yt-dlp --quiet --break-system-packages", function(err) {
  if (err) console.warn("yt-dlp update failed:", err.message);
  else console.log("yt-dlp updated successfully");
});

function ensureCookiesFile() {
  var cookiesContent = process.env.YOUTUBE_COOKIES;
  if (cookiesContent) {
    var header = "# Netscape HTTP Cookie File";
    if (cookiesContent.indexOf(header) === -1) {
      cookiesContent = header + "\n" + cookiesContent;
    }
    var lines = cookiesContent.split("\n");
    var cleaned = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.length > 0) cleaned.push(line);
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

function captureChunk(existing, chunk) {
  var next = existing + chunk;
  if (next.length <= MAX_CAPTURE_LENGTH) return next;
  return next.slice(next.length - MAX_CAPTURE_LENGTH);
}

function runProcess(command, args, options) {
  options = options || {};

  return new Promise(function(resolve, reject) {
    var stdoutText = "";
    var stderrText = "";
    var child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", function(chunk) {
      stdoutText = captureChunk(stdoutText, chunk.toString());
    });

    child.stderr.on("data", function(chunk) {
      stderrText = captureChunk(stderrText, chunk.toString());
    });

    child.on("error", function(err) {
      reject(new Error(command + " failed to start: " + err.message));
    });

    child.on("close", function(code) {
      if (code === 0) {
        resolve({ stdout: stdoutText, stderr: stderrText });
        return;
      }

      var details = (stderrText || stdoutText || "Unknown process error").trim();
      reject(new Error(command + " exited with code " + code + ": " + details));
    });
  });
}

function getYtDlpArgs(sourceUrl, outputFile) {
  var args = [
    "--extractor-args", "youtube:player_client=ios,mweb",
    "--add-header", "User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    "--no-check-certificates",
    "--socket-timeout", "30",
    "--retries", "5",
    "--fragment-retries", "5",
    "--no-progress",
    "--newline",
    "-f", "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]",
    "--merge-output-format", "mp4",
    "-o", outputFile,
    sourceUrl,
  ];

  if (hasCookies) {
    args.splice(args.length - 1, 0, "--cookies", COOKIES_PATH);
  }

  return args;
}

function getFfmpegArgs(inputFile, outputFile) {
  return [
    "-i", inputFile,
    "-an",
    "-c:v", "copy",
    "-movflags", "+faststart",
    outputFile,
    "-y",
    "-nostats",
    "-loglevel", "error",
  ];
}

async function createMutedVideo(sourceUrl, workDir, prefix) {
  var rawFile = path.join(workDir, "video.mp4");
  var mutedFile = path.join(workDir, "muted.mp4");

  console.log(prefix + ": downloading " + sourceUrl);
  await runProcess("yt-dlp", getYtDlpArgs(sourceUrl, rawFile), { cwd: workDir });
  if (!fs.existsSync(rawFile)) {
    throw new Error(prefix + ": Download completed but output file was not created");
  }

  console.log(prefix + ": muting audio");
  await runProcess("ffmpeg", getFfmpegArgs(rawFile, mutedFile), { cwd: workDir });
  if (!fs.existsSync(mutedFile)) {
    throw new Error(prefix + ": Muting completed but output file was not created");
  }

  return { rawFile, mutedFile };
}

app.post("/api/reupload", async function(req, res) {
  var body = req.body;
  var job_id = body.job_id;
  var source_url = body.source_url;
  var source_video_id = body.source_video_id;
  var google_refresh_token = body.google_refresh_token;
  var webhook_url = body.webhook_url;
  var custom_title = body.custom_title;
  var custom_description = body.custom_description;

  if (!job_id || !source_url || !webhook_url || !google_refresh_token) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  res.json({ accepted: true, job_id: job_id });

  var workDir = path.join("/tmp", job_id);

  try {
    fs.mkdirSync(workDir, { recursive: true });

    await updateStatus(webhook_url, job_id, "downloading");
    var files = await createMutedVideo(source_url, workDir, "reupload " + job_id);

    await updateStatus(webhook_url, job_id, "uploading");
    var auth = getOAuth2Client(google_refresh_token);
    var youtube = google.youtube({ version: "v3", auth: auth });

    var title = custom_title || "Re-uploaded video";
    var description = custom_description || "";

    if (!custom_title && source_video_id) {
      try {
        var metaRes = await youtube.videos.list({
          part: ["snippet"],
          id: [source_video_id],
        });
        if (metaRes.data.items && metaRes.data.items.length > 0) {
          title = metaRes.data.items[0].snippet.title || title;
          description = metaRes.data.items[0].snippet.description || description;
        }
      } catch (e) {
        console.warn("Failed to fetch source video metadata:", e.message);
      }
    }

    var uploadRes = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: title,
          description: description,
          categoryId: "22",
        },
        status: { privacyStatus: "private" },
      },
      media: { body: fs.createReadStream(files.mutedFile) },
    });

    await updateStatus(webhook_url, job_id, "done", {
      uploaded_video_id: uploadRes.data.id,
    });
  } catch (err) {
    console.error("reupload error:", err.message);
    await updateStatus(webhook_url, job_id, "failed", {
      error_message: err.message,
    });
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

app.post("/api/download-muted", async function(req, res) {
  var source_url = req.body.source_url;
  if (!source_url) {
    return res.status(400).json({ error: "source_url is required" });
  }

  var jobId = "mute-" + Date.now();
  var workDir = path.join("/tmp", jobId);

  try {
    fs.mkdirSync(workDir, { recursive: true });

    var files = await createMutedVideo(source_url, workDir, "download-muted " + jobId);
    var stat = fs.statSync(files.mutedFile);
    console.log("download-muted: sending muted file, size=" + stat.size);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", "attachment; filename=muted.mp4");

    var stream = fs.createReadStream(files.mutedFile);
    stream.pipe(res);
    stream.on("end", function() {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (e) {}
    });
    stream.on("error", function(err) {
      console.error("download-muted stream error:", err.message);
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (e) {}
      if (!res.headersSent) {
        res.status(500).json({
          error: "Failed to stream muted video",
          details: err.message,
        });
      }
    });
  } catch (err) {
    console.error("download-muted error:", err.message);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {}
    res.status(500).json({
      error: "Failed to generate muted video",
      details: err.message,
    });
  }
});

app.get("/health", async function(req, res) {
  try {
    await runProcess("sh", ["-lc", "command -v yt-dlp >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1"]);
    res.json({ ok: true, cookies: hasCookies, tools: true });
  } catch (err) {
    res.status(500).json({ ok: false, cookies: hasCookies, tools: false, error: err.message });
  }
});

app.use(function(err, req, res, next) {
  console.error("Unhandled backend error:", err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({
    error: "Internal backend error",
    details: err && err.message ? err.message : "Unknown error",
  });
});

app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});
