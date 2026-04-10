# 🎬 VORTEX — YouTube Downloader

A free, beautiful YouTube downloader that **requires no backend**.  
Deploy the `frontend/` folder to GitHub Pages — it just works.

---

## 🚀 Deploy in 3 Steps

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/yt-downloader.git
git push -u origin main
```

### Step 2 — Enable GitHub Pages

1. Go to your repo on GitHub
2. **Settings → Pages**
3. Under **Source** → select **GitHub Actions**
4. The workflow in `.github/workflows/deploy.yml` runs automatically

### Step 3 — Done ✅

Your app is live at:
```
https://YOUR_USERNAME.github.io/yt-downloader/
```

**No API keys. No backend. No configuration needed.**

---

## How it works

The frontend calls the [cobalt.tools](https://cobalt.tools) open API directly from the browser.  
cobalt.tools is a free, open-source media downloader — no account or key required.

---

## Features

- 1080p, 720p, 480p, 360p MP4 download
- MP3 audio extraction
- Auto-fetch video info on paste
- Mobile friendly
- Zero dependencies — pure HTML/CSS/JS

---

## Local Development

```bash
cd frontend
python -m http.server 8080
# Open http://localhost:8080
```

---

## Legal

For personal use only. Respect copyright and [YouTube's Terms of Service](https://www.youtube.com/t/terms).
