/**
 * VORTEX — YouTube Downloader
 *
 * Download flow:
 *  1. POST to cobalt API → get a stream/tunnel URL
 *  2. fetch() that URL as a blob in the browser
 *  3. Create an object URL → click <a download> → real file saved
 *
 * This approach bypasses the cross-origin `a.download` restriction
 * because we stream the bytes locally first.
 */

// ── Cobalt instances (tried in order) ───────────────────────
const COBALT = [
  "https://api.cobalt.tools",
  "https://cobalt.api.timelessnesses.me",
  "https://co.wuk.sh",
];

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

// ── Build cobalt POST body ───────────────────────────────────
function cobaltPayload(url, q) {
  if (q === "audio") {
    return { url, downloadMode: "audio", audioFormat: "mp3", audioBitrate: "320" };
  }
  return { url, videoQuality: q, downloadMode: "auto", filenameStyle: "pretty" };
}

// ── Call cobalt, try every instance ─────────────────────────
async function getCobaltUrl(url, q) {
  const payload = cobaltPayload(url, q);
  const errors  = [];

  for (const base of COBALT) {
    try {
      const res = await fetch(base, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(25000),
      });

      // cobalt returns 200 even for some errors, always try to parse
      const data = await res.json().catch(() => null);
      if (!data) { errors.push(`${base}: empty response`); continue; }

      // New cobalt API (v10+) uses data.status + data.url
      // Also handle legacy { url } flat response
      const status  = data.status;
      const fileUrl = data.url || (data.picker && data.picker[0]?.url);

      if (fileUrl && (!status || ["stream","redirect","tunnel","success"].includes(status))) {
        return fileUrl;
      }
      if (status === "picker" && data.picker?.length) {
        return data.picker[0].url;
      }
      if (status === "error") {
        const code = data.error?.code || data.text || JSON.stringify(data.error) || "unknown";
        errors.push(`${base}: ${code}`);
        continue;
      }

      errors.push(`${base}: unrecognised response (status=${status})`);
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

// ── Stream blob → real file download ────────────────────────
async function streamDownload(fileUrl, filename, onProgress) {
  // fetch the bytes — this is what makes the download actually work
  // even across origins the browser can read a cobalt tunnel URL
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
    // Step 1: get the stream URL from cobalt
    setStatus("info", "Resolving download link…");
    const fileUrl = await getCobaltUrl(currentUrl, selectedQ);

    // Step 2: stream + save as blob
    const ext      = selectedQ === "audio" ? "mp3" : "mp4";
    const rawTitle = $("vid-title").textContent.trim();
    const title    = rawTitle.replace(/[\\/*?:"<>|]/g, "_").slice(0, 120);
    const filename = `${title}.${ext}`;

    setStatus("info", "Downloading… 0%");

    let startTime = Date.now();

    await streamDownload(fileUrl, filename, (loaded, total) => {
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

    // friendly messages for common cobalt errors
    if (msg.includes("content.video.unavailable") || msg.includes("unavailable")) {
      msg = "This video is unavailable or geo-restricted.";
    } else if (msg.includes("content.video.age")) {
      msg = "Age-restricted video — cobalt cannot download it.";
    } else if (msg.includes("content.video.private")) {
      msg = "This video is private.";
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
