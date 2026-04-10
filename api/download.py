"""
Vercel serverless function — /api/download

Downloads a YouTube video or audio track with yt-dlp and streams it
directly back to the browser so the user gets a real file save dialog.

Query parameters:
  url      — full YouTube watch URL (required)
  quality  — "1080" | "720" | "480" | "360" | "audio"  (default: "1080")

Uses pre-merged progressive MP4 formats so ffmpeg is NOT required.
Audio is served as M4A (AAC) — widely supported, no re-encoding needed.
"""

from http.server import BaseHTTPRequestHandler
import subprocess
import json
import os
import re
import tempfile
import urllib.parse

# Allowed quality values — validated against this set before use
_ALLOWED_QUALITIES = {"1080", "720", "480", "360", "audio"}

# Accept only recognisable YouTube URL shapes to guard against
# command-line injection via crafted query parameters.
_YT_URL_RE = re.compile(
    r"^https?://(?:www\.|m\.)?(?:youtube\.com/watch\?(?:[\w=&%-]*&)?v=[\w-]{11}|youtu\.be/[\w-]{11})",
    re.IGNORECASE,
)


def _validate_inputs(url: str, quality: str) -> str | None:
    """Return an error string if inputs are invalid, else None."""
    if not url:
        return "Missing required 'url' query parameter."
    if not _YT_URL_RE.match(url):
        return "Invalid or unsupported URL. Only YouTube watch/short links are accepted."
    if quality not in _ALLOWED_QUALITIES:
        return f"Invalid quality '{quality}'. Allowed: {', '.join(sorted(_ALLOWED_QUALITIES))}."
    return None


def _extract_video_id(url: str) -> str | None:
    """Extract the 11-character video ID from a validated YouTube URL."""
    m = re.search(r"[\w-]{11}", url)
    return m.group(0) if m else None


class handler(BaseHTTPRequestHandler):

    # ── CORS pre-flight ──────────────────────────────────────────
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    # ── Main GET handler ─────────────────────────────────────────
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        url     = params.get("url",     [None])[0] or ""
        quality = params.get("quality", ["1080"])[0]

        err = _validate_inputs(url, quality)
        if err:
            self._json_error(400, err)
            return

        # Reconstruct a clean URL from the extracted video ID so that only
        # a known-safe string is ever passed to the subprocess command list.
        video_id = _extract_video_id(url)
        if not video_id:
            self._json_error(400, "Could not extract a video ID from the provided URL.")
            return
        safe_url = f"https://www.youtube.com/watch?v={video_id}"

        # ── Build yt-dlp format string ───────────────────────────
        # We deliberately use pre-merged (progressive) formats so we
        # never need ffmpeg, which is not available in the Vercel runtime.
        if quality == "audio":
            fmt          = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio"
            default_ext  = "m4a"
            content_type = "audio/mp4"
        else:
            q = int(quality)   # safe: already validated against _ALLOWED_QUALITIES
            # "best" selects the single-file (pre-merged) progressive stream
            fmt          = f"best[height<={q}][ext=mp4]/best[height<={q}]"
            default_ext  = "mp4"
            content_type = "video/mp4"

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                out_tmpl = os.path.join(tmpdir, "dl.%(ext)s")

                # All elements are hard-coded or validated — no shell expansion.
                cmd = [
                    "yt-dlp",
                    "--no-playlist",
                    "--no-warnings",
                    "-f", fmt,
                    "-o", out_tmpl,
                    safe_url,   # reconstructed from extracted video ID — not raw user input
                ]

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=300,
                )

                if result.returncode != 0:
                    err_detail = result.stderr.strip() or "yt-dlp exited with a non-zero status."
                    self._json_error(500, err_detail)
                    return

                # Find the downloaded file (skip .part or .ytdl leftovers)
                files = [
                    f for f in os.listdir(tmpdir)
                    if not f.endswith((".part", ".ytdl"))
                ]
                if not files:
                    self._json_error(500, "yt-dlp ran but produced no output file.")
                    return

                filepath   = os.path.join(tmpdir, files[0])
                file_size  = os.path.getsize(filepath)
                actual_ext = files[0].rsplit(".", 1)[-1] if "." in files[0] else default_ext

                # Determine Content-Type from actual extension
                ext_map = {
                    "mp4":  "video/mp4",
                    "webm": "video/webm",
                    "mkv":  "video/x-matroska",
                    "m4a":  "audio/mp4",
                    "mp3":  "audio/mpeg",
                    "opus": "audio/ogg",
                }
                serve_type = ext_map.get(actual_ext, content_type)

                self.send_response(200)
                self._cors_headers()
                self.send_header("Content-Type", serve_type)
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="video.{actual_ext}"',
                )
                self.send_header("Content-Length", str(file_size))
                self.end_headers()

                # Stream the file in chunks
                with open(filepath, "rb") as fh:
                    while True:
                        chunk = fh.read(65536)
                        if not chunk:
                            break
                        try:
                            self.wfile.write(chunk)
                        except (BrokenPipeError, ConnectionResetError):
                            break

        except subprocess.TimeoutExpired:
            self._json_error(504, "Download timed out — try a shorter video or lower quality.")
        except Exception as exc:
            self._json_error(500, str(exc))

    # ── Helpers ──────────────────────────────────────────────────
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json_error(self, code, message):
        try:
            body = json.dumps({"error": message}).encode()
            self.send_response(code)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass

    # Silence the default request logging to keep Vercel logs clean
    def log_message(self, msg_format, *args):
        pass
