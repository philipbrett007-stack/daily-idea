# Daily Idea

A personal, ad-free take on Deepstash: one well-sourced idea every morning, plus a few more waiting behind the **Another idea** button.

## How it works

- Each morning a scheduled Claude task researches a set of ideas (checked sources, a video or image, a simple sketch) and commits them to `ideas/YYYY-MM-DD.json`, updating `ideas/index.json`.
- This repo is served by GitHub Pages. The app is a Progressive Web App: install it from Chrome on Android with **Add to Home screen / Install app**.
- What you've read and your Stash are kept on your phone only. Ideas you've already opened keep working offline.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `sw.js` | Service worker for offline use (bump `VERSION` after changing app files) |
| `manifest.webmanifest`, `icons/` | Install details and home-screen icon |
| `ideas/index.json` | List of days with idea counts and titles |
| `ideas/YYYY-MM-DD.json` | That day's ideas |

## Day file format

```json
{
  "date": "2026-10-18",
  "generated_at": "2026-10-18T08:41:00+01:00",
  "ideas": [
    {
      "id": "1",
      "featured": true,
      "theme": "Thought for the day",
      "title": "…",
      "idea": "…",
      "why": ["…", "…"],
      "visual": { "type": "video", "url": "https://…", "label": "…", "note": "…" },
      "sketch_svg": "<svg …>…</svg>",
      "sketch_alt": "…",
      "try_this": "…",
      "sources": [{ "title": "…", "url": "https://…" }]
    }
  ]
}
```
