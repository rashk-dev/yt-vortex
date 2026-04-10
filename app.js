/**
 * VORTEX — YouTube Downloader
 *
 * Download flow:
 *  1. Call /api/download (Vercel serverless, yt-dlp) → streams the file
 *  2. fetch() that response as a blob in the browser
 *  3. Create an object URL → click <a download> → real file saved
 *
 * This approach bypasses the cross-origin `a.download` restriction
 * because we stream the bytes locally first.
 */

// ── Backend endpoint ─────────────────────────────────────────
const API_BASE = "/api/download";

// ── State ────────────────────────────────────────────────────
let currentUrl = "";
let selectedQ  = "1080";

// ── Tiny DOM helper ─────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Status display ───────────────────────────────────────────
function setStatus(type, msg) {
  const box = $("status");
  box.className = type || "";
  $("status-msg").innerHTML = msg;
  $("spin").style.display = (type === "info") ? "block" : "none";
  box.style.display = type ? "flex" : "none";
}

// ── Extract YouTube video ID ─────────────────────────────────
function extractId(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("?")[0];
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v") || "";
  } catch {}
  // fallback regex
  const m = raw.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}

// ── Fetch video info via oEmbed ──────────────────────────────
async function fetchInfo() {
  const raw = ($("url").value || "").trim();
  if (!raw) { $("url").focus(); return; }

  const id = extractId(raw);
  if (!id) {
    setStatus("error", "⚠️ Couldn't find a YouTube video ID. Paste a link like:<br><code>https://youtube.com/watch?v=XXXXXXXXXXX</code>");
    return;
  }

  currentUrl = raw;
  $("btn-fetch").disabled = true;
  $("btn-fetch").textContent = "Loading…";
  $("preview").style.display = "none";
  setStatus("info", "Fetching video info…");

  try {
    const oe = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(raw)}&format=json`
    ).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

    $("thumb").src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    $("dur").textContent = "";
    $("vid-title").textContent = oe.title || "Unknown title";
    $("author").textContent    = oe.author_name || "";
    $("views").textContent     = "";
    $("preview").style.display = "block";
    setStatus("", "");
  } catch (e) {
    setStatus("error", "Could not load video info. Make sure the video is public and the URL is correct.");
  } finally {
    $("btn-fetch").disabled = false;
    $("btn-fetch").textContent = "Fetch";
  }
}

// ── Quality pill selection ───────────────────────────────────
function pick(el) {
  document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
  el.classList.add("active");
  selectedQ = el.dataset.q;
}

// ── Build API download URL ───────────────────────────────────
function buildApiUrl(url, q) {
  return `${API_BASE}?url=${encodeURIComponent(url)}&quality=${encodeURIComponent(q)}`;
}

// ── Stream blob → real file download ────────────────────────
async function streamDownload(fileUrl, filename, onProgress) {
  // fetch the bytes through our /api/download endpoint — the browser
  // buffers the entire response as a blob so it can trigger a real save dialog
  const res = await fetch(fileUrl, { signal: AbortSignal.timeout(0) }); // no timeout for large files
  if (!res.ok) throw new Error(`Stream fetch failed: ${res.status}`);

  const contentLength = res.headers.get("Content-Length");
  const total = contentLength ? parseInt(contentLength) : 0;
  let loaded = 0;

  // Read as stream so we can show progress
  const reader   = res.body.getReader();
  const chunks   = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (total > 0) onProgress(loaded, total);
    else           onProgress(loaded, 0);
  }

  const blob      = new Blob(chunks);
  const objectUrl = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href     = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // revoke after a moment to free memory
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
}

// ── Format bytes ─────────────────────────────────────────────
function fmtBytes(b) {
  if (b < 1024)       return b + " B";
  if (b < 1048576)    return (b/1024).toFixed(1) + " KB";
  if (b < 1073741824) return (b/1048576).toFixed(1) + " MB";
  return (b/1073741824).toFixed(2) + " GB";
}

// ── Main download handler ────────────────────────────────────
async function doDownload() {
  if (!currentUrl) { setStatus("error", "Please fetch a video first."); return; }

  $("btn-dl").disabled = true;

  try {
    // Audio is served as M4A (no ffmpeg needed); video as MP4
    const ext      = selectedQ === "audio" ? "m4a" : "mp4";
    const rawTitle = $("vid-title").textContent.trim();
    const title    = rawTitle.replace(/[\\/*?:"<>|]/g, "_").slice(0, 120);
    const filename = `${title}.${ext}`;

    setStatus("info", "Preparing download… this may take a moment.");

    const apiUrl    = buildApiUrl(currentUrl, selectedQ);
    let   startTime = Date.now();

    await streamDownload(apiUrl, filename, (loaded, total) => {
      const elapsed = (Date.now() - startTime) / 1000 || 0.001;
      const speed   = fmtBytes(loaded / elapsed) + "/s";
      if (total > 0) {
        const pct = Math.round((loaded / total) * 100);
        const dl  = fmtBytes(loaded);
        const tot = fmtBytes(total);
        setStatus("info", `Downloading… ${pct}% &nbsp;·&nbsp; ${dl} / ${tot} &nbsp;·&nbsp; ${speed}`);
      } else {
        setStatus("info", `Downloading… ${fmtBytes(loaded)} received &nbsp;·&nbsp; ${speed}`);
      }
    });

    setStatus("success", `✅ Saved as <strong>${filename}</strong> — check your downloads folder!`);

  } catch (err) {
    console.error("Download error:", err);

    let msg = err.message || "Unknown error";

    if (msg.includes("unavailable")) {
      msg = "This video is unavailable or geo-restricted.";
    } else if (msg.includes("private")) {
      msg = "This video is private.";
    } else if (msg.includes("age")) {
      msg = "Age-restricted video — cannot be downloaded.";
    } else if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
      msg = "Network error — check your internet connection and try again.";
    }

    setStatus("error", `❌ ${msg}`);
  } finally {
    $("btn-dl").disabled = false;
  }
}

// ── Keyboard & paste shortcuts ───────────────────────────────
document.getElementById("url").addEventListener("keydown", e => {
  if (e.key === "Enter") fetchInfo();
});

document.getElementById("url").addEventListener("paste", () => {
  setTimeout(() => {
    const v = document.getElementById("url").value.trim();
    if (v.includes("youtube.com/") || v.includes("youtu.be/")) fetchInfo();
  }, 60);
});
