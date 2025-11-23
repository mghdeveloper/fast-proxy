import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;

// ------------- CONFIG -------------
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h cache
const DEFAULT_REFERER = "https://megaplay.buzz/";
const BASE_OUTPUT_DIR = path.join(process.cwd(), "stream_cache"); // Save M3U8 files
const PROXY_PREFIX = "/watch-Beta/stream/proxy.php?url=";
const CURL_TIMEOUT = 15000;
// ----------------------------------

// Enable CORS for all origins
app.use(cors({ origin: "*" }));

// Ensure base output directory exists
if (!fs.existsSync(BASE_OUTPUT_DIR)) fs.mkdirSync(BASE_OUTPUT_DIR, { recursive: true });

// Helper: convert relative URL to absolute
function absUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

// Helper: fetch remote content
async function fetchText(url, referer) {
  try {
    const res = await axios.get(url, {
      timeout: CURL_TIMEOUT,
      responseType: "text",
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: referer,
        Referer: referer,
        "User-Agent": "Mozilla/5.0 FastNodeProxy/1.0",
      },
    });
    return res.data;
  } catch {
    return null;
  }
}

// Simple in-memory index to track cache
const cacheIndex = new Map();

// --------------------- ROUTE: get_best_stream ---------------------
app.get("/get_best_stream", async (req, res) => {
  const masterUrl = req.query.url;
  if (!masterUrl) return res.json({ error: "Missing URL" });

  let referer = req.query.referer || DEFAULT_REFERER;
  try {
    const r = new URL(referer);
    referer = `${r.protocol}//${r.hostname}/`;
  } catch {
    referer = DEFAULT_REFERER;
  }

  // Safe folder name based on SHA1 of URL + referer
  const crypto = await import("crypto");
  const hash = crypto.createHash("sha1").update(masterUrl + "|" + referer).digest("hex");
  const cacheDir = path.join(BASE_OUTPUT_DIR, hash);

  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const masterCachePath = path.join(cacheDir, "master.m3u8");

  // Check long cache
  if (fs.existsSync(masterCachePath) && Date.now() - fs.statSync(masterCachePath).mtimeMs < CACHE_TTL) {
    const files = fs.readdirSync(cacheDir);
    const variants = files
      .filter((f) => f !== "." && f !== ".." && f !== "master.m3u8")
      .map((f) => {
        const bw = parseInt(path.parse(f).name, 10) || null;
        return { bandwidth: bw, resolution: null, file: path.join("stream_cache", hash, f) };
      });

    return res.json({
      master: path.join("stream_cache", hash, "master.m3u8"),
      all: variants,
    });
  }

  // Load master playlist
  const masterTxt = await fetchText(masterUrl, referer);
  if (!masterTxt) return res.json({ error: "Could not load master playlist" });

  const lines = masterTxt.split(/\r?\n/);
  let streams = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrsText = line.replace("#EXT-X-STREAM-INF:", "");
      let bandwidth = null;
      let resolution = null;

      for (let part of attrsText.split(",")) {
        part = part.trim();
        if (part.startsWith("BANDWIDTH=")) bandwidth = parseInt(part.replace("BANDWIDTH=", ""), 10);
        if (part.startsWith("RESOLUTION=")) resolution = part.replace("RESOLUTION=", "");
      }

      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const relUrl = lines[j]?.trim();
      if (!relUrl) continue;

      streams.push({ bandwidth, resolution, url: absUrl(masterUrl, relUrl) });
    }
  }

  if (!streams.length) return res.json({ error: "No streams found" });

  // Fetch all variant playlists in parallel
  const variantFetches = streams.map((s) => fetchText(s.url, referer));
  const variantTxts = await Promise.all(variantFetches);

  const variantEntries = [];

  streams.forEach((s, idx) => {
    const txt = variantTxts[idx];
    if (!txt) return;

    const processed = txt
      .split(/\r?\n/)
      .map((line) => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return line;
        const abs = absUrl(s.url, t);
        return `${PROXY_PREFIX}${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}`;
      })
      .join("\n");

    const fileName = `${s.bandwidth || "v" + idx}.m3u8`;
    const filePath = path.join(cacheDir, fileName);
    fs.writeFileSync(filePath, processed, "utf-8");
    variantEntries.push({ bandwidth: s.bandwidth, resolution: s.resolution, file: path.join("stream_cache", hash, fileName) });
  });

  // Build new master playlist
  const masterLines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  variantEntries.forEach((v) => {
    masterLines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth || 0}`);
    masterLines.push(path.basename(v.file));
  });

  fs.writeFileSync(masterCachePath, masterLines.join("\n"), "utf-8");

  res.json({
    master: path.join("stream_cache", hash, "master.m3u8"),
    all: variantEntries,
  });
});

// --------------------- SERVE FILES FOR FRONT-END ---------------------
app.use("/stream_cache", express.static(BASE_OUTPUT_DIR));

// --------------------- SELF-CHECK ---------------------
app.get("/self-check", (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// Self-check interval
setInterval(async () => {
  try {
    await axios.get(`http://localhost:${PORT}/self-check`, { timeout: 3000 });
    console.log("Self-check OK:", new Date().toISOString());
  } catch (err) {
    console.error("SELF CHECK FAILED:", err.message);
  }
}, 30 * 1000);

// --------------------- START SERVER ---------------------
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
