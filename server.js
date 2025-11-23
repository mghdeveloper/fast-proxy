import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: "*" }));

// --- Helpers ---
function absUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

async function fetchText(url, headers) {
  try {
    const res = await axios.get(url, { headers, timeout: 15000, responseType: "text" });
    return res.data;
  } catch {
    return null;
  }
}

// --- Route ---
app.get("/get_best_stream", async (req, res) => {
  const masterUrl = req.query.url ? decodeURIComponent(req.query.url) : null;
  if (!masterUrl) return res.json({ error: "Missing URL" });

  let referer = req.query.referer ? decodeURIComponent(req.query.referer) : "https://megaplay.buzz/";
  try {
    const r = new URL(referer);
    referer = `${r.protocol}//${r.hostname}/`;
  } catch {
    referer = "https://megaplay.buzz/";
  }

  const headers = {
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    Connection: "keep-alive",
    Origin: referer,
    Referer: referer,
    "User-Agent": "Mozilla/5.0"
  };

  // 1) Load master playlist
  const playlist = await fetchText(masterUrl, headers);
  if (!playlist) return res.json({ error: "Could not load master playlist" });

  const baseMasterUrl = path.dirname(masterUrl);

  // 2) Parse playlist
  const lines = playlist.split(/\r?\n/);
  const streams = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("#EXT-X-STREAM-INF")) continue;

    const parts = line.replace("#EXT-X-STREAM-INF:", "").split(",");
    let bandwidth = null;
    let resolution = null;
    for (const p of parts) {
      if (p.includes("BANDWIDTH=")) bandwidth = parseInt(p.replace("BANDWIDTH=", ""));
      if (p.includes("RESOLUTION=")) resolution = p.replace("RESOLUTION=", "");
    }
    if (!bandwidth) continue;

    const subUrl = lines[i + 1]?.trim();
    if (!subUrl) continue;
    streams.push({
      bandwidth,
      resolution,
      url: subUrl.match(/^https?:\/\//) ? subUrl : `${baseMasterUrl}/${subUrl}`
    });
  }

  if (!streams.length) return res.json({ error: "No streams found" });

  // 3) Create folder
  const folderName = `${Date.now()}_${Math.floor(Math.random() * 9000 + 1000)}`;
  const baseDir = path.join("stream", folderName);
  fs.mkdirSync(baseDir, { recursive: true });

  // 4) Process variant playlists
  const variantEntries = [];
  for (const s of streams) {
    const variant = await fetchText(s.url, headers);
    if (!variant) continue;

    const folder = path.dirname(s.url);
    const proxied = variant.replace(/^(?!#)(.*)$/gm, (_, seg) => {
      seg = seg.trim();
      if (!seg.match(/^https?:\/\//)) seg = `${folder}/${seg}`;
      return `/watch-Beta/stream/proxy.php?url=${encodeURIComponent(seg)}&referer=${encodeURIComponent(referer)}`;
    });

    const fileName = `${s.bandwidth}.m3u8`;
    fs.writeFileSync(path.join(baseDir, fileName), proxied, "utf-8");

    variantEntries.push({
      bandwidth: s.bandwidth,
      resolution: s.resolution,
      file: path.join(baseDir, fileName)
    });
  }

  // 5) Build master playlist
  let masterOut = "#EXTM3U\n#EXT-X-VERSION:3\n";
  for (const v of variantEntries) {
    masterOut += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution}\n`;
    masterOut += `${path.basename(v.file)}\n`;
  }
  fs.writeFileSync(path.join(baseDir, "master.m3u8"), masterOut, "utf-8");

  // 6) Return JSON
  res.json({
    master: path.join(baseDir, "master.m3u8"),
    all: variantEntries
  });
});

// --- Start server ---
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
