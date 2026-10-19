/* Daily Idea — phone app logic.
   Ideas come from ideas/index.json and ideas/YYYY-MM-DD.json, written by the scheduled Claude task.
   "New idea" (or swiping the card left) swaps in an idea you haven't seen: today's first, then anything
   in the bank, up to 100 a day. Everything personal (what you've read, your stash) stays on this phone. */
(function () {
  "use strict";

  const TZ = "Europe/Dublin";
  const DAILY_LIMIT = 100;
  const KEYS = { stash: "di.stash.v1", seen: "di.seen.v1", shown: "di.shown.v2", taps: "di.taps.v2",
    reads: "di.reads.v1", tune: "di.tune.v1", mindSeen: "di.mindseen.v1", gh: "di.gh.v1" };

  // Each theme gets its own colour. Order matters: the first keyword that matches wins.
  const THEME_COLOURS = [
    ["creativ", "#FF7AC6"], ["invent", "#FF7AC6"],
    ["history", "#FFA64D"], ["big idea", "#FFA64D"],
    ["science", "#3DD6B5"], ["nature", "#3DD6B5"],
    ["psych", "#FF8A7A"], ["behav", "#FF8A7A"],
    ["philos", "#F6C35B"], ["wisdom", "#F6C35B"],
    ["thought for", "#6EC1FF"], ["living", "#6EC1FF"],
    ["think", "#8B7BFF"], ["decision", "#8B7BFF"]
  ];
  function themeColour(theme) {
    const s = String(theme || "").toLowerCase();
    for (const [k, c] of THEME_COLOURS) if (s.includes(k)) return c;
    return "#8B7BFF";
  }

  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage full or blocked */ } }
  };

  let index = null;               // { latest, days: [{date, count, titles}] }
  let indexMissing = false;
  const dayCache = new Map();     // date -> { date, ideas: [...] }
  let stash = store.get(KEYS.stash, {});         // key -> { date, idea, savedAt }
  let seen = new Set(store.get(KEYS.seen, []));  // keys read
  let shown = store.get(KEYS.shown, {});         // today -> [keys shown today, in order]
  let taps = store.get(KEYS.taps, {});           // today -> New idea taps used
  let reads = store.get(KEYS.reads, {});         // key -> { t: when first opened (ms), th: theme }, for Mindset
  let tune = store.get(KEYS.tune, {});           // mindset axis id -> weight (0.5 less, 1 normal, 2 more)
  let view = "today";
  let lastLoad = 0;
  let deferredInstall = null;
  let busy = false;
  let canAnother = false;

  const $ = (s) => document.querySelector(s);

  /* ---------- helpers ---------- */
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids) { if (c == null || c === false) continue; n.append(c.nodeType ? c : document.createTextNode(String(c))); }
    return n;
  }
  const ICONS = {
    video: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8.5 5.8v12.4L18.8 12z" fill="currentColor"/></svg>',
    image: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 16.5l4-4.5 3 3 2.5-2.5 2.5 4z" fill="currentColor"/><circle cx="15.5" cy="9" r="1.4" fill="currentColor"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M10 14l4-4M9 7h-1a5 5 0 000 10h1M15 7h1a5 5 0 010 10h-1" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
    out: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 01-1 1H6a1 1 0 01-1-1V8a1 1 0 011-1h4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    caret: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M9 6.5v11L18 12z" fill="currentColor"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3.5l1.9 5.2 5.6.3-4.4 3.5 1.5 5.4L12 14.8 7.4 17.9l1.5-5.4L4.5 9l5.6-.3z" fill="currentColor"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 002 2h10a2 2 0 002-2v-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 4h10v16l-5-3.5L7 20z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
  };
  function icon(name, cls) { const s = el("span", { class: cls }); s.innerHTML = ICONS[name] || ICONS.link; return s; }

  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hour12: false });
  const longFmt = new Intl.DateTimeFormat("en-IE", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
  const shortFmt = new Intl.DateTimeFormat("en-IE", { timeZone: "UTC", day: "numeric", month: "short" });
  const dayKey = (d) => dayFmt.format(d);
  const todayKey = () => dayKey(new Date());
  const asDate = (key) => new Date(key + "T12:00:00Z");
  function fmtDay(key) {
    if (key === todayKey()) return "Today";
    if (key === dayKey(new Date(Date.now() - 864e5))) return "Yesterday";
    const d = asDate(key); return isNaN(d) ? key : longFmt.format(d);
  }
  const fmtShort = (key) => { const d = asDate(key); return isNaN(d) ? key : shortFmt.format(d); };
  function greeting() {
    const h = parseInt(hourFmt.format(new Date()), 10);
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }
  function safeUrl(u) { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : null; } catch (_) { return null; } }
  function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } }
  function ytId(u) {
    try {
      const x = new URL(u); let id = null;
      if (x.hostname.endsWith("youtu.be")) id = x.pathname.slice(1).split("/")[0];
      else if (x.hostname.endsWith("youtube.com")) {
        id = x.searchParams.get("v");
        if (!id) { const m = x.pathname.match(/\/(shorts|embed|live)\/([\w-]+)/); if (m) id = m[2]; }
      }
      return id && /^[\w-]{6,20}$/.test(id) ? id : null;
    } catch (_) { return null; }
  }
  const keyOf = (date, idea, i) => date + "#" + (idea && idea.id ? String(idea.id) : String(i + 1));
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }
  function banner(msg) { const b = $("#banner"); b.textContent = msg || ""; b.hidden = !msg; }

  // keep only the last week of per-day bookkeeping
  (function prune() {
    const cutoff = dayKey(new Date(Date.now() - 7 * 864e5));
    for (const obj of [shown, taps]) for (const k of Object.keys(obj)) if (k < cutoff) delete obj[k];
    store.set(KEYS.shown, shown); store.set(KEYS.taps, taps);
    const old = Date.now() - 70 * 864e5;   // Mindset only needs the last couple of months of reading
    for (const [k, r] of Object.entries(reads)) if (!r || r.t < old) delete reads[k];
    store.set(KEYS.reads, reads);
  })();

  /* ---------- data ---------- */
  // Ideas can arrive in two places: the app's own copy (main branch) and the scheduled
  // task's branch (claude/ideas), which it can always push to. Read both, keep the fuller day.
  const SOURCES = ["ideas/", "https://raw.githubusercontent.com/philipbrett007-stack/daily-idea/refs/heads/claude/ideas/ideas/"];
  const daySource = new Map();    // date -> index into SOURCES
  async function getJSON(path) {
    const url = /^https:/.test(path) ? path + "?t=" + Date.now() : path;
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  function normaliseDay(d, date) {
    const ideas = Array.isArray(d && d.ideas) ? d.ideas.filter((x) => x && typeof x === "object" && x.title) : [];
    ideas.forEach((x, i) => { if (!x.id) x.id = String(i + 1); });
    const featured = ideas.filter((x) => x.featured), rest = ideas.filter((x) => !x.featured);
    return { date: (d && d.date) || date, ideas: featured.concat(rest) };
  }
  async function loadIndex() {
    const results = await Promise.allSettled(SOURCES.map((s) => getJSON(s + "index.json")));
    const byDate = new Map();
    results.forEach((res, si) => {
      if (res.status !== "fulfilled") return;
      const list = Array.isArray(res.value && res.value.days) ? res.value.days : [];
      for (const d of list) {
        if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
        const have = byDate.get(d.date);
        if (!have || (Number(d.count) || 0) > (Number(have.d.count) || 0)) byDate.set(d.date, { d, si });
      }
    });
    if (!results.some((r) => r.status === "fulfilled")) {
      const e = results[0].reason;
      if (e && e.status === 404) { index = { latest: null, days: [] }; indexMissing = true; return; }
      throw e;
    }
    daySource.clear();
    for (const [date, v] of byDate) daySource.set(date, v.si);
    const days = [...byDate.values()].map((v) => v.d).sort((a, b) => (a.date < b.date ? 1 : -1));
    index = { latest: days.length ? days[0].date : null, days };
    indexMissing = false;
  }
  async function loadDay(date, fresh) {
    if (!fresh && dayCache.has(date)) return dayCache.get(date);
    const first = daySource.get(date) || 0;
    let raw;
    try { raw = await getJSON(SOURCES[first] + date + ".json"); }
    catch (e) { raw = await getJSON(SOURCES[1 - first] + date + ".json"); }
    const d = normaliseDay(raw, date);
    dayCache.set(date, d);
    return d;
  }
  async function ideaByKey(k) {
    const date = k.split("#")[0];
    const d = await loadDay(date);
    const i = d.ideas.findIndex((x, j) => keyOf(date, x, j) === k);
    return i < 0 ? null : { date, idea: d.ideas[i] };
  }
  function seenCount(date) { let n = 0; const p = date + "#"; for (const k of seen) if (k.startsWith(p)) n++; return n; }

  // Next idea: the newest day's ideas first, then an unseen idea from the rest of the bank.
  // If you've tuned your feed on the Mindset tab, themes you asked for come up more often.
  async function nextUnseen() {
    if (!index || !index.days.length) return null;
    const shownToday = new Set(shown[todayKey()] || []);
    const free = (k) => !seen.has(k) && !shownToday.has(k);
    const latest = index.latest;
    try {
      const d = await loadDay(latest);
      const open = d.ideas.map((x, i) => ({ x, k: keyOf(latest, x, i) })).filter((c) => free(c.k));
      if (open.length) {
        if (open[0].x.featured || !isTuned()) return open[0].k;
        let best = open[0];
        for (const c of open) if (themeWeight(c.x.theme) > themeWeight(best.x.theme)) best = c;
        return best.k;
      }
    } catch (_) { /* fall through to the bank */ }
    const days = index.days.filter((x) => x.date !== latest && seenCount(x.date) < (Number(x.count) || 0)).map((x) => x.date);
    for (let i = days.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [days[i], days[j]] = [days[j], days[i]]; }
    const pool = [];
    let looked = 0;
    for (const date of days) {
      let d; try { d = await loadDay(date); } catch (_) { continue; }
      d.ideas.forEach((x, i) => { const k = keyOf(date, x, i); if (free(k)) pool.push({ k, w: themeWeight(x.theme) }); });
      if (pool.length && (!isTuned() || ++looked >= 6)) break;
    }
    if (!pool.length) return null;
    let r = Math.random() * pool.reduce((s, c) => s + c.w, 0);
    for (const c of pool) { r -= c.w; if (r <= 0) return c.k; }
    return pool[pool.length - 1].k;
  }

  /* ---------- media: videos play inside the app, images open full screen here ---------- */
  const looksLikeImage = (u) => /\.(jpe?g|png|webp|gif|svg)(\?|#|$)/i.test(u) || /^https:\/\/upload\.wikimedia\.org\//.test(u) || /\/Special:FilePath\//.test(u);
  const looksLikeVideoFile = (u) => /\.(mp4|webm|ogv|m4v)(\?|#|$)/i.test(u);
  // "90", "1:30", "1m30s", "90s" -> seconds
  function toSeconds(t) {
    if (t == null || t === "") return 0;
    if (typeof t === "number") return Math.max(0, Math.floor(t));
    const s = String(t).trim();
    if (/^\d+$/.test(s)) return +s;
    if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(":").reduce((a, b) => a * 60 + +b, 0);
    const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
  }
  // Work out how to play a video link inside the app. Returns null if it can't be embedded.
  function embedFor(v) {
    const u = safeUrl(v && v.url); if (!u) return null;
    let x; try { x = new URL(u); } catch (_) { return null; }
    const start = toSeconds(v.start != null ? v.start : x.searchParams.get("t") || x.searchParams.get("start"));
    const end = toSeconds(v.end);
    const yt = ytId(u);
    if (yt) {
      const q = new URLSearchParams({ autoplay: "1", playsinline: "1", rel: "0", modestbranding: "1" });
      if (start) q.set("start", String(start)); if (end > start) q.set("end", String(end));
      return { kind: "iframe", src: "https://www.youtube-nocookie.com/embed/" + yt + "?" + q, poster: "https://i.ytimg.com/vi/" + yt + "/hqdefault.jpg", open: u, site: "YouTube" };
    }
    const vm = x.hostname.endsWith("vimeo.com") && x.pathname.match(/\/(?:video\/)?(\d{5,})/);
    if (vm) return { kind: "iframe", src: "https://player.vimeo.com/video/" + vm[1] + "?autoplay=1&playsinline=1" + (start ? "#t=" + start + "s" : ""), poster: safeUrl(v.thumb_url), open: u, site: "Vimeo" };
    const ted = /(^|\.)ted\.com$/.test(x.hostname) && x.pathname.match(/\/talks\/([\w-]+)/);
    if (ted && ted[1] !== "view") return { kind: "iframe", src: "https://embed.ted.com/talks/" + ted[1], poster: safeUrl(v.thumb_url), open: u, site: "TED" };
    if (looksLikeVideoFile(u)) return { kind: "video", src: u + (start ? "#t=" + start : ""), poster: safeUrl(v.thumb_url), open: u, site: host(u) };
    return null;
  }

  function videoPlayer(v) {
    const e = embedFor(v); if (!e) return null;
    const label = v.label ? String(v.label) : "Watch the clip";
    const frame = el("div", { class: "player" });
    const startBtn = el("button", { type: "button", class: "poster", "aria-label": "Play: " + label });
    if (e.poster) {
      const img = el("img", { src: e.poster, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
      img.addEventListener("error", () => img.remove());
      startBtn.append(img);
    }
    startBtn.append(el("span", { class: "play" }, icon("play", "")));
    const t = toSeconds(v.start);
    if (t) startBtn.append(el("span", { class: "starts", text: "from " + Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0") }));
    frame.append(startBtn);
    startBtn.addEventListener("click", () => {
      // Stop any other clip that's playing, then start this one in place.
      document.querySelectorAll(".player.on").forEach((p) => { if (p !== frame && p._reset) p._reset(); });
      const media = e.kind === "iframe"
        ? el("iframe", { src: e.src, title: label, allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true, referrerpolicy: "strict-origin-when-cross-origin" })
        : el("video", { src: e.src, controls: true, autoplay: true, playsinline: true, preload: "metadata", poster: e.poster || null });
      frame.replaceChildren(media); frame.classList.add("on");
    });
    frame._reset = () => { frame.replaceChildren(startBtn); frame.classList.remove("on"); };
    return el("div", { class: "visual video" }, frame,
      el("div", { class: "vrow" },
        el("span", { class: "vtext" },
          el("span", { class: "vlabel", text: label }),
          v.note ? el("span", { class: "vnote", text: String(v.note) }) : null),
        el("a", { class: "vopen", href: e.open, target: "_blank", rel: "noopener noreferrer", "aria-label": "Open on " + e.site }, icon("out", ""))));
  }

  // Full-screen image viewer that stays inside the app. The phone's back button closes it.
  let lightbox = null;
  function openImage(src, caption, credit, page) {
    if (!lightbox) {
      lightbox = el("div", { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": "Image" });
      lightbox.addEventListener("click", (ev) => { if (!ev.target.closest("a")) history.back(); });
      document.body.append(lightbox);
      window.addEventListener("popstate", () => { if (!lightbox.hidden) { lightbox.hidden = true; lightbox.replaceChildren(); document.body.classList.remove("noscroll"); } });
    }
    lightbox.replaceChildren(
      el("button", { type: "button", class: "lb-close", "aria-label": "Close" }, "✕"),
      el("img", { src, alt: caption || "", referrerpolicy: "no-referrer" }),
      caption || credit ? el("div", { class: "lb-cap" },
        caption ? el("p", { text: caption }) : null,
        credit ? (page ? el("a", { href: page, target: "_blank", rel: "noopener noreferrer", text: credit }) : el("small", { text: credit })) : null) : null);
    lightbox.hidden = false; document.body.classList.add("noscroll");
    history.pushState({ lightbox: 1 }, "");
  }

  function imageFigure(im, cls) {
    const src = safeUrl(im && im.url); if (!src || !looksLikeImage(src)) return null;
    const caption = im.caption ? String(im.caption) : "", credit = im.credit ? String(im.credit) : "", page = safeUrl(im.page_url);
    const img = el("img", { src, alt: caption, loading: "lazy", referrerpolicy: "no-referrer" });
    const btn = el("button", { type: "button", class: "shot-btn", "aria-label": "View image full screen" }, img);
    const fig = el("figure", { class: cls || "shot" }, btn,
      caption || credit ? el("figcaption", null, caption ? el("span", { text: caption }) : null, credit ? el("small", { text: credit }) : null) : null);
    btn.addEventListener("click", () => openImage(src, caption, credit, page));
    img.addEventListener("error", () => { const g = fig.parentElement; fig.remove(); if (g && g.classList.contains("gallery") && !g.children.length) g.remove(); });
    return fig;
  }

  function paragraphs(text, cls) {
    const box = el("div", { class: cls });
    for (const p of String(text).split(/\n\s*\n/)) if (p.trim()) box.append(el("p", { text: p.trim() }));
    return box.children.length ? box : null;
  }

  /* ---------- cards ---------- */
  function section(label, content) { return el("div", null, el("div", { class: "label", text: label }), content); }

  // The readable body of an idea, shared by the main card and expanded rows.
  function ideaBody(idea, key, date) {
    const parts = [];
    if (idea.idea) { const b = paragraphs(idea.idea, "idea"); if (b) parts.push(b); }

    const v = idea.visual, vu = v && safeUrl(v.url);
    const player = vu ? videoPlayer(v) : null;
    if (player) parts.push(player);

    const imgs = (Array.isArray(idea.images) ? idea.images : []).map((im) => imageFigure(im)).filter(Boolean);
    if (imgs.length) parts.push(el("div", { class: "gallery" + (imgs.length === 1 ? " single" : "") }, ...imgs));

    if (idea.deep_dive) { const b = paragraphs(idea.deep_dive, "prose"); if (b) parts.push(section("How it works", b)); }

    if (typeof idea.sketch_svg === "string") {
      const s = idea.sketch_svg.trim();
      if (s.startsWith("<svg") && s.length < 80000 && !/<script|<foreignObject|\son\w+\s*=|href\s*=\s*["']?(?!#)/i.test(s)) {
        parts.push(el("figure", { class: "sketch" },
          el("img", { src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s), alt: idea.sketch_alt ? String(idea.sketch_alt) : "Sketch explaining the idea", loading: "lazy" }),
          idea.sketch_alt ? el("figcaption", { text: String(idea.sketch_alt) }) : null));
      }
    }

    const ex = (Array.isArray(idea.examples) ? idea.examples : []).filter((x) => x && (x.title || x.text));
    if (ex.length) {
      parts.push(section("In practice", el("div", { class: "examples" }, ...ex.map((x) => el("div", { class: "example" },
        x.title ? el("h3", { text: String(x.title) }) : null,
        x.text ? paragraphs(x.text, "prose") : null,
        x.image ? imageFigure(x.image, "shot inline") : null)))));
    }

    const directImage = vu && !player && looksLikeImage(vu) ? imageFigure({ url: vu, caption: v.label, credit: v.note }) : null;
    if (directImage) parts.push(el("div", { class: "gallery single" }, directImage));
    else if (vu && !player) {
      // A web page we can't show inside the app: a tidy link card instead.
      const kind = v.type === "video" ? "video" : v.type === "image" ? "image" : "link";
      const a = el("a", { class: "visual", href: vu, target: "_blank", rel: "noopener noreferrer" });
      const tu = safeUrl(v.thumb_url);
      const thumbSrc = tu && looksLikeImage(tu) ? tu : null;
      if (thumbSrc) {
        const img = el("img", { src: thumbSrc, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
        const thumb = el("div", { class: "thumb" }, img, kind === "video" ? el("div", { class: "play" }, icon("play", "")) : null);
        img.addEventListener("error", () => thumb.remove());
        a.append(thumb);
      }
      a.append(el("div", { class: "vrow" }, icon(kind, "vicon"),
        el("span", { class: "vtext" },
          el("span", { class: "vlabel", text: v.label ? String(v.label) : (kind === "video" ? "Watch the clip" : "Open the image") }),
          v.note ? el("span", { class: "vnote", text: String(v.note) }) : null,
          el("span", { class: "vhost", text: host(vu) }))));
      parts.push(a);
    }

    if (Array.isArray(idea.why) && idea.why.length) {
      parts.push(section("Why it holds up", el("ul", { class: "why" }, ...idea.why.map((w) => el("li", { text: String(w) })))));
    }

    if (idea.try_this) {
      parts.push(el("div", { class: "try" }, el("div", { class: "label", text: "Try this today" }), el("p", { text: String(idea.try_this) })));
    }

    const srcs = (Array.isArray(idea.sources) ? idea.sources : []).map((s) => ({ t: s && s.title, u: s && safeUrl(s.url) })).filter((s) => s.u);
    if (srcs.length) {
      parts.push(section("Go deeper", el("ul", { class: "sources" },
        ...srcs.map((s) => el("li", null, el("a", { href: s.u, target: "_blank", rel: "noopener noreferrer" }, icon("out", ""), el("span", { text: s.t ? String(s.t) : host(s.u) })))))));
    }

    const isStashed = !!stash[key];
    const stashBtn = el("button", { type: "button", class: "act stash-btn", "aria-pressed": String(isStashed), "data-stash": key }, icon("bookmark", ""), el("span", { text: isStashed ? "Stashed" : "Stash" }));
    stashBtn.addEventListener("click", () => toggleStash(key, date, idea));
    const shareBtn = el("button", { type: "button", class: "act" }, icon("share", ""), el("span", { text: "Share" }));
    shareBtn.addEventListener("click", () => share(idea));
    parts.push(el("div", { class: "actions" }, stashBtn, shareBtn));
    return parts;
  }

  function mainCard(idea, ctx) {
    const c = el("article", { class: "card main" + (ctx.fresh ? " enter" : ""), "data-key": ctx.key });
    c.style.setProperty("--t", themeColour(idea.theme));
    const right = idea.featured
      ? el("span", { class: "badge" }, icon("star", ""), "Pick of the day")
      : ctx.fromDay ? el("span", { class: "badge", text: "From " + fmtShort(ctx.fromDay) }) : null;
    c.append(
      el("div", { class: "card-top" }, idea.theme ? el("span", { class: "tag", text: String(idea.theme) }) : el("span"), right),
      el("h2", { class: "title", text: String(idea.title) }),
      ...ideaBody(idea, ctx.key, ctx.date));
    markSeen(ctx.key, idea);
    return c;
  }

  function rowCard(idea, ctx) {
    const d = el("details", { class: "card row", "data-key": ctx.key });
    d.style.setProperty("--t", themeColour(idea.theme));
    const meta = [idea.theme ? String(idea.theme) : null, ctx.showDate ? fmtShort(ctx.date) : null].filter(Boolean).join(", ");
    d.append(el("summary", null,
      el("span", { class: "row-dot", "aria-hidden": "true" }),
      el("span", { class: "row-text" }, el("span", { class: "row-title", text: String(idea.title) }), meta ? el("span", { class: "row-meta", text: meta }) : null),
      icon("caret", "caret")));
    let built = false;
    d.addEventListener("toggle", () => {
      if (!d.open) return;
      if (!built) { d.append(el("div", { class: "row-body" }, ...ideaBody(idea, ctx.key, ctx.date))); built = true; }
      markSeen(ctx.key, idea);
    });
    return d;
  }

  function markSeen(key, idea) {
    if (seen.has(key)) return;
    seen.add(key); store.set(KEYS.seen, Array.from(seen).slice(-5000));
    if (idea && !reads[key]) { reads[key] = { t: Date.now(), th: String(idea.theme || "") }; store.set(KEYS.reads, reads); }
  }

  async function share(idea) {
    const src = (Array.isArray(idea.sources) ? idea.sources : []).map((s) => s && safeUrl(s.url)).find(Boolean);
    const text = idea.title + "\n\n" + (idea.idea || "") + (src ? "\n\nSource: " + src : "");
    if (navigator.share) { try { await navigator.share({ title: idea.title, text }); } catch (_) { /* cancelled */ } return; }
    try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); } catch (_) { toast("Couldn't share on this device"); }
  }

  function toggleStash(key, date, idea) {
    if (stash[key]) { delete stash[key]; toast("Removed from your stash"); }
    else { stash[key] = { date, idea, savedAt: new Date().toISOString() }; toast("Saved to your stash"); }
    store.set(KEYS.stash, stash);
    const on = !!stash[key];
    document.querySelectorAll('[data-stash="' + CSS.escape(key) + '"]').forEach((b) => {
      b.setAttribute("aria-pressed", String(on)); b.querySelector("span:last-child").textContent = on ? "Stashed" : "Stash";
    });
    renderStashCount();
    if (view === "stash") renderStash();
    updateMindNudges();
  }

  /* ---------- Today ---------- */
  function emptyBox(title, text) { return el("div", { class: "empty" }, el("p", { class: "etitle", text: title }), el("p", { text })); }

  // New batches of researched ideas start arriving at these Dublin times (the scheduled task's run times).
  const BATCH_SIZE = 5;
  const BATCH_TIMES = [[7, 40, "7:40"]];
  function nextBatchLabel() {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
    const h = +parts.find((p) => p.type === "hour").value % 24, m = +parts.find((p) => p.type === "minute").value;
    const now = h * 60 + m;
    for (const [bh, bm, label] of BATCH_TIMES) if (bh * 60 + bm > now) return "at " + label + " today";
    return "at " + BATCH_TIMES[0][2] + " tomorrow";
  }

  let waitTimer = null;
  function totalCount() { return index ? index.days.reduce((s, d) => s + (Number(d.count) || 0), 0) : 0; }
  // Ideas in the bank you haven't opened yet.
  function unreadCount() {
    if (!index) return 0;
    const dates = new Set(index.days.map((d) => d.date));
    let read = 0;
    for (const k of seen) if (dates.has(k.split("#")[0])) read++;
    return Math.max(0, totalCount() - read);
  }
  function outOfIdeasText() {
    const total = totalCount();
    return "That's all " + total + (total === 1 ? " idea" : " ideas") + " read for now. " + BATCH_SIZE + " more arrive " + nextBatchLabel() + ".";
  }
  function stopWaiting() { if (waitTimer) { clearInterval(waitTimer); waitTimer = null; } }
  // While the bank is empty, quietly check for newly researched ideas every 90 seconds.
  function startWaiting() {
    if (waitTimer) return;
    waitTimer = setInterval(async () => {
      if (document.hidden || view !== "today" || busy) return;
      const before = totalCount();
      try { await loadIndex(); if (index.latest) await loadDay(index.latest, true); } catch (_) { return; }
      if (totalCount() > before) { stopWaiting(); toast("Fresh ideas are in. Tap Refresh idea."); await renderToday(); }
    }, 90000);
  }

  function setFab(state) {
    const btn = $("#another"), out = $("#out-box"), hint = $("#today-hint");
    btn.hidden = out.hidden = true; hint.hidden = true; canAnother = false;
    if (state === "none") return;
    if (state === "limit") {
      out.hidden = false; out.textContent = "That's your 100 for today. " + BATCH_SIZE + " more arrive " + nextBatchLabel() + ".";
      stopWaiting(); return;
    }
    btn.hidden = false; btn.disabled = false; canAnother = true;
    $("#another-count").textContent = unreadCount() + " left";
    if (state === "out") {
      out.hidden = false;
      out.textContent = outOfIdeasText() + " This screen picks them up automatically.";
      startWaiting();
    } else {
      hint.hidden = false; stopWaiting();
    }
  }

  async function renderToday(opts) {
    const cardsEl = $("#today-cards"), earlier = $("#earlier"), earlierCards = $("#earlier-cards");
    const today = todayKey();
    $("#today-h").textContent = greeting();
    $("#today-date").textContent = longFmt.format(asDate(today));

    if (!index || !index.days.length) {
      cardsEl.replaceChildren(emptyBox(indexMissing ? "Your first ideas arrive at 9:00" : "No ideas yet",
        "Each morning a fresh set of ideas lands here. Tap refresh at the top to check."));
      earlier.hidden = true; setFab("none"); return;
    }

    let list = (shown[today] || []).slice();
    if (!list.length) {
      let k = await nextUnseen();
      if (!k) { try { const d = await loadDay(index.latest); if (d.ideas.length) k = keyOf(index.latest, d.ideas[0], 0); } catch (_) {} }
      if (k) { list = [k]; shown[today] = list; store.set(KEYS.shown, shown); }
    }

    let current = null;
    for (let i = list.length - 1; i >= 0 && !current; i--) {
      try { current = await ideaByKey(list[i]); if (current) current.key = list[i]; } catch (_) { current = null; }
    }
    if (!current) {
      cardsEl.replaceChildren(emptyBox("Couldn't load the idea", "Check your connection and tap refresh at the top."));
      earlier.hidden = true; setFab("none"); return;
    }
    const colour = themeColour(current.idea.theme);
    document.documentElement.style.setProperty("--t", colour);
    cardsEl.replaceChildren(mainCard(current.idea, {
      key: current.key, date: current.date, fresh: opts && opts.fresh,
      fromDay: current.date !== today ? current.date : null
    }));

    const prev = list.slice(0, -1).reverse();
    const rows = [];
    for (const k of prev) {
      try { const r = await ideaByKey(k); if (r) rows.push(rowCard(r.idea, { key: k, date: r.date })); } catch (_) {}
    }
    earlier.hidden = !rows.length;
    earlierCards.replaceChildren(...rows);

    if ((taps[today] || 0) >= DAILY_LIMIT) setFab("limit");
    else setFab((await nextUnseen()) ? "ready" : "out");
  }

  async function newIdea() {
    if (busy || !canAnother) return;
    const today = todayKey();
    if ((taps[today] || 0) >= DAILY_LIMIT) return;
    busy = true;
    const btn = $("#another"); btn.disabled = true;
    try {
      let k = await nextUnseen();
      if (!k) {
        toast("Checking for new ideas…");
        try { await loadIndex(); dayCache.delete(index.latest); } catch (_) {}
        k = await nextUnseen();
        if (!k) toast("All read. " + BATCH_SIZE + " more arrive " + nextBatchLabel() + ".");
      }
      if (k) {
        const cur = document.querySelector("#today-cards .card.main");
        if (cur && !reduceMotion()) { cur.classList.add("leave"); await wait(190); }
        const list = shown[today] || [];
        if (list.length) markSeen(list[list.length - 1]);
        shown[today] = list.concat(k); taps[today] = (taps[today] || 0) + 1;
        store.set(KEYS.shown, shown); store.set(KEYS.taps, taps);
      }
      await renderToday({ fresh: !!k });
      if (k) window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
    } finally {
      busy = false;
      btn.disabled = false;
    }
  }

  // Swipe the card left for a new idea
  (function swipe() {
    const area = $("#today-cards");
    let x0 = null, y0 = 0, t0 = 0;
    area.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1 || e.target.closest("a, button, .gallery, .player")) { x0 = null; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
    }, { passive: true });
    area.addEventListener("touchend", (e) => {
      if (x0 == null) return;
      const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (dx < -70 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - t0 < 800) newIdea();
    }, { passive: true });
  })();

  /* ---------- Stash ---------- */
  function renderStashCount() {
    const n = Object.keys(stash).length, c = $("#stash-count");
    c.textContent = n; c.hidden = n === 0;
  }
  function renderStash() {
    const list = Object.entries(stash).sort((a, b) => (a[1].savedAt < b[1].savedAt ? 1 : -1));
    $("#stash-sub").textContent = list.length
      ? list.length + (list.length === 1 ? " idea saved on this phone." : " ideas saved on this phone.")
      : "Ideas you've saved, kept on this phone.";
    const target = $("#stash-cards");
    if (!list.length) { target.replaceChildren(emptyBox("Nothing saved yet", "Tap Stash on any idea to keep it here. Your stash works offline too.")); return; }
    target.replaceChildren(...list.map(([key, s]) => rowCard(s.idea, { key, date: s.date, showDate: true })));
  }

  /* ---------- Archive ---------- */
  function renderArchive() {
    const target = $("#archive-days");
    if (!index || !index.days.length) {
      $("#archive-sub").textContent = "";
      target.replaceChildren(emptyBox("No ideas yet", "Every idea is kept here by day, newest first."));
      return;
    }
    const totalIdeas = index.days.reduce((s, d) => s + (Number(d.count) || 0), 0);
    $("#archive-sub").textContent = totalIdeas + (totalIdeas === 1 ? " idea so far." : " ideas so far.");
    target.replaceChildren(...index.days.map((day) => {
      const n = Number(day.count) || 0;
      const rows = el("div", { class: "rows" }, el("p", { class: "row-meta", text: "Loading…" }));
      const box = el("section", { class: "day" },
        el("h2", { class: "day-head" }, el("span", { text: fmtDay(day.date) }), el("small", { text: n + (n === 1 ? " idea" : " ideas") })),
        rows);
      loadDay(day.date)
        .then((d) => rows.replaceChildren(...d.ideas.map((idea, i) => rowCard(idea, { key: keyOf(day.date, idea, i), date: day.date }))))
        .catch(() => rows.replaceChildren(el("p", { class: "row-meta", text: "Couldn't load this day. Check your connection." })));
      return box;
    }));
  }

  /* ---------- Weekly Mindset ---------- */
  // Six ways of thinking, one per theme family. Worked out on this phone from what you open (1 point)
  // and stash (3 points) each week, Monday to Sunday. A playful mirror, not a personality test.
  const AXES = [
    { id: "systems", name: "Systems", colour: "#FF7AC6", who: "The Builder",
      trait: "pragmatic, structured and mechanism-minded",
      blurb: "You went for how things are put together and why they fail: designs, processes and the hidden plumbing of systems." },
    { id: "decisions", name: "Decisions", colour: "#8B7BFF", who: "The Strategist",
      trait: "analytical, probabilistic and sceptical of easy stories",
      blurb: "You collected tools for thinking straight: bias, odds, evidence and how to choose well when you can't be sure." },
    { id: "science", name: "Science", colour: "#3DD6B5", who: "The Explorer",
      trait: "curious and evidence-hungry, drawn to how the world really works",
      blurb: "You chased mechanisms and surprising findings, and liked it best when the data overturned the story." },
    { id: "people", name: "People", colour: "#FF8A7A", who: "The People-Reader",
      trait: "observant of motives, habits and the quirks behind behaviour",
      blurb: "You were drawn to why people do what they do, at work, at home and in groups." },
    { id: "meaning", name: "Meaning", colour: "#F6C35B", who: "The Reflector",
      trait: "meaning-driven, second-order and focused on principles",
      blurb: "You leaned towards the big questions: how to live, what matters and how to steady your own mind." },
    { id: "history", name: "History", colour: "#FFA64D", who: "The Long-View Thinker",
      trait: "pattern-seeking across time and wary of 'this time is different'",
      blurb: "You looked backwards to understand the present: turning points, unintended consequences and their long tails." }
  ];
  const AXIS_BY_ID = Object.fromEntries(AXES.map((a) => [a.id, a]));
  // Order matters: "Creativity, invention & systems thinking" must land on Systems, not on Decisions via "think".
  const AXIS_MATCH = [
    ["systems", ["creativ", "invent", "system", "engineer", "design"]],
    ["history", ["history", "big idea"]],
    ["science", ["science", "nature"]],
    ["people", ["psych", "behav"]],
    ["meaning", ["philos", "wisdom", "thought for", "living"]],
    ["decisions", ["think", "decision", "probab", "tool"]]
  ];
  function axisOf(theme) {
    const s = String(theme || "").toLowerCase();
    for (const [id, words] of AXIS_MATCH) if (words.some((w) => s.includes(w))) return id;
    return null;
  }
  const TUNE_STEPS = [[0.5, "Less"], [1, "Normal"], [2, "More"]];
  function isTuned() { return Object.values(tune).some((w) => w !== 1); }
  function themeWeight(theme) { const a = axisOf(theme); return (a && tune[a]) || 1; }

  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // Weeks run Monday to Sunday, Irish time.
  function addDays(key, n) { const d = asDate(key); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function mondayOf(key) { const d = asDate(key); return addDays(key, -((d.getUTCDay() + 6) % 7)); }
  function weekLabel(mon) {
    const a = asDate(mon), b = asDate(addDays(mon, 6));
    const f = (d, o) => new Intl.DateTimeFormat("en-IE", Object.assign({ timeZone: "UTC" }, o)).format(d);
    return a.getUTCMonth() === b.getUTCMonth()
      ? f(a, { day: "numeric" }) + "–" + f(b, { day: "numeric", month: "short" })
      : f(a, { day: "numeric", month: "short" }) + " – " + f(b, { day: "numeric", month: "short" });
  }

  function weekData(mon) {
    const end = addDays(mon, 6), inWeek = (k) => k >= mon && k <= end;
    const pts = Object.fromEntries(AXES.map((a) => [a.id, 0]));
    const days = new Set(), stashed = [];
    let nRead = 0;
    for (const r of Object.values(reads)) {
      const dk = dayKey(new Date(r.t)); if (!inWeek(dk)) continue;
      nRead++; days.add(dk); const a = axisOf(r.th); if (a) pts[a] += 1;
    }
    for (const s of Object.values(stash)) {
      const t = Date.parse(s.savedAt); if (isNaN(t)) continue;
      const dk = dayKey(new Date(t)); if (!inWeek(dk)) continue;
      days.add(dk); stashed.push(s); const a = axisOf(s.idea && s.idea.theme); if (a) pts[a] += 3;
    }
    stashed.sort((x, y) => (x.savedAt < y.savedAt ? 1 : -1));
    const total = Object.values(pts).reduce((s, v) => s + v, 0);
    const share = Object.fromEntries(AXES.map((a) => [a.id, total ? Math.round((pts[a.id] / total) * 100) : 0]));
    return { mon, nRead, nStash: stashed.length, days: days.size, stashed, total, share, sparse: stashed.length < 3 && nRead < 6 };
  }

  function profileOf(w) {
    const ranked = AXES.slice().sort((a, b) => w.share[b.id] - w.share[a.id]);
    const top = ranked[0], second = ranked[1], blind = ranked[ranked.length - 1];
    const wide = ranked.filter((a) => w.share[a.id] >= 12);
    if (wide.length >= 4 && w.share[top.id] < 35)
      return { title: "The Polymath", colour: "#8B7BFF", ranked, top, blind, wide,
        trait: "connective and cross-disciplinary, linking ideas between fields",
        blurb: "You didn't settle in one place. You moved across " + wide.length + " fields this week and kept what connected them." };
    if (w.share[second.id] >= 25 && w.share[top.id] - w.share[second.id] <= 10)
      return { title: top.who + ", with a " + second.who.replace(/^The /, "") + " streak", colour: top.colour, ranked, top, blind,
        trait: top.trait + ", with a strong " + second.name.toLowerCase() + " side",
        blurb: top.blurb + " " + second.name + " ran a close second." };
    return { title: top.who, colour: top.colour, ranked, top, blind, trait: top.trait, blurb: top.blurb };
  }

  function narrative(w, p, prev) {
    const out = ["You opened " + plural(w.nRead, "idea") + " and stashed " + w.nStash + ", across " + plural(w.days, "day") + "."];
    if (p.wide) out.push("Your attention spread across " + p.wide.map((a) => a.name).join(", ") + ": the mark of a mind that's " + p.trait + ".");
    else out.push("Your saves leaned towards " + p.top.name + " (" + w.share[p.top.id] + "%): the mark of a mind that's " + p.trait + ".");
    const kept = w.stashed.slice(0, 3).map((s) => "“" + s.idea.title + "”");
    if (kept.length) out.push((kept.length === 1 ? "The idea you kept: " : "Ideas you kept: ") + kept.join(", ") + ".");
    if (prev && !prev.sparse) {
      let best = null, d = 0;
      for (const a of AXES) { const delta = w.share[a.id] - prev.share[a.id]; if (Math.abs(delta) > Math.abs(d)) { d = delta; best = a; } }
      if (best && Math.abs(d) >= 8) out.push("Compared with the week before, you moved " + (d > 0 ? "towards " : "away from ") + best.name + " (" + (d > 0 ? "+" : "") + d + " points).");
    }
    if (w.share[p.blind.id] <= 8) out.push("Blind spot: " + p.blind.name + ". One " + p.blind.name.toLowerCase() + " idea a day would round out your week.");
    return out;
  }

  function radarSvg(w, colour) {
    const NS = "http://www.w3.org/2000/svg", c = 160, R = 100, n = AXES.length;
    const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const pt = (i, r) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
    const max = Math.max(1, ...AXES.map((a) => w.share[a.id]));
    const svg = mk("svg", { viewBox: "-64 0 448 320", class: "radar", role: "img",
      "aria-label": "Thinking map: " + AXES.map((a) => a.name + " " + w.share[a.id] + "%").join(", ") });
    for (const f of [0.25, 0.5, 0.75, 1]) svg.append(mk("polygon", { points: AXES.map((_, i) => pt(i, R * f).join(",")).join(" "), class: "r-grid" }));
    AXES.forEach((_, i) => { const [x, y] = pt(i, R); svg.append(mk("line", { x1: c, y1: c, x2: x, y2: y, class: "r-spoke" })); });
    const r = (a) => R * Math.max(0.12, Math.sqrt(w.share[a.id] / max));   // square root keeps small themes visible
    svg.append(mk("polygon", { points: AXES.map((a, i) => pt(i, r(a)).join(",")).join(" "), class: "r-shape", style: "fill:" + colour + ";stroke:" + colour }));
    AXES.forEach((a, i) => { const [x, y] = pt(i, r(a)); svg.append(mk("circle", { cx: x, cy: y, r: 4, fill: a.colour })); });
    AXES.forEach((a, i) => {
      const [x, y] = pt(i, R + 18);
      const t = mk("text", { x, y: y + 5, class: "r-label", "text-anchor": Math.abs(x - c) < 5 ? "middle" : x > c ? "start" : "end" });
      t.textContent = a.name + " ";
      const p = mk("tspan", { class: "r-pct" }); p.textContent = w.share[a.id] + "%";
      t.append(p); svg.append(t);
    });
    return svg;
  }

  function mindBars(w) {
    return el("div", { class: "mbars" }, ...AXES.slice().sort((a, b) => w.share[b.id] - w.share[a.id]).map((a) => {
      const fill = el("span", { class: "mbar-fill" });
      fill.style.width = w.share[a.id] + "%"; fill.style.background = a.colour;
      return el("div", { class: "mbar" }, el("span", { class: "mbar-name", text: a.name }), el("span", { class: "mbar-track" }, fill), el("span", { class: "mbar-pct", text: w.share[a.id] + "%" }));
    }));
  }

  function setTune(id, v) {
    if (v === 1) delete tune[id]; else tune[id] = v;
    store.set(KEYS.tune, tune);
    const name = AXIS_BY_ID[id].name;
    toast(v === 2 ? "More " + name + " coming up" : v === 0.5 ? "Less " + name + " from now on" : name + " back to normal");
    renderMind();
  }
  function tuneBox(p) {
    const chips = [];
    if (p) {
      const lean = el("button", { type: "button", class: "chip", text: "More " + p.top.name });
      lean.addEventListener("click", () => setTune(p.top.id, 2));
      const fill = el("button", { type: "button", class: "chip", text: "Fill my blind spot: " + p.blind.name });
      fill.addEventListener("click", () => setTune(p.blind.id, 2));
      chips.push(lean, fill);
    }
    if (isTuned()) {
      const reset = el("button", { type: "button", class: "chip ghost", text: "Reset" });
      reset.addEventListener("click", () => { tune = {}; store.set(KEYS.tune, tune); toast("Back to an even mix"); renderMind(); });
      chips.push(reset);
    }
    const rows = AXES.map((a) => {
      const cur = tune[a.id] || 1;
      const seg = el("div", { class: "tseg", role: "radiogroup", "aria-label": a.name });
      for (const [v, label] of TUNE_STEPS) {
        const b = el("button", { type: "button", role: "radio", "aria-checked": String(cur === v), text: label });
        b.addEventListener("click", () => { if ((tune[a.id] || 1) !== v) setTune(a.id, v); });
        seg.append(b);
      }
      const dot = el("i", { class: "tdot" }); dot.style.background = a.colour;
      return el("div", { class: "trow" }, el("span", { class: "tname" }, dot, a.name), seg);
    });
    return el("section", { class: "mcard" }, el("h2", { class: "mh", text: "Tune your next week" }),
      el("p", { class: "mnote", text: "Choose what Refresh idea serves up more or less often." }),
      chips.length ? el("div", { class: "chips" }, ...chips) : null,
      el("div", { class: "trows" }, ...rows));
  }

  // A 4:5 image for Instagram, WhatsApp and the like, drawn on the phone.
  function wrapText(g, text, x, y, maxW, lh) {
    let line = "";
    for (const word of text.split(" ")) {
      const test = line ? line + " " + word : word;
      if (g.measureText(test).width > maxW && line) { g.fillText(line, x, y); line = word; y += lh; } else line = test;
    }
    if (line) g.fillText(line, x, y);
    return y;
  }
  function pill(g, x, y, w, h, colour) { g.fillStyle = colour; g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, h / 2) : g.rect(x, y, w, h); g.fill(); }
  function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; }
  async function shareMind(w, p) {
    try { await document.fonts.ready; } catch (_) {}
    const W = 1080, H = 1350, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#1D1B3A"); bg.addColorStop(1, "#15142A");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(W * 0.85, 120, 10, W * 0.85, 120, 760);
    glow.addColorStop(0, rgba(p.colour, 0.42)); glow.addColorStop(1, rgba(p.colour, 0));
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    const D = "'Bricolage Grotesque', 'Segoe UI', sans-serif", B = "'Figtree', 'Segoe UI', sans-serif";
    g.fillStyle = "#ABA8C9"; g.font = "700 32px " + B; g.fillText("HOW MY MIND WORKED", 90, 150);
    g.fillStyle = "#7D799E"; g.font = "500 32px " + B; g.fillText("Week of " + weekLabel(w.mon), 90, 196);
    const size = p.title.length > 30 ? 70 : p.title.length > 18 ? 82 : 98;
    g.fillStyle = "#EEEDF7"; g.font = "800 " + size + "px " + D;
    let y = wrapText(g, p.title, 90, 300 + size * 0.3, 900, size * 1.08);
    g.fillStyle = p.colour; g.font = "600 38px " + B;
    y = wrapText(g, cap(p.trait) + ".", 90, y + 74, 900, 50);
    g.fillStyle = "#C9C7E0"; g.font = "400 34px " + B;
    y = wrapText(g, p.blurb, 90, y + 70, 900, 48);
    y = Math.min(Math.max(y + 100, 640), H - 560);
    for (const a of p.ranked.slice(0, 4)) {
      g.fillStyle = "#EEEDF7"; g.font = "600 36px " + B; g.textAlign = "left"; g.fillText(a.name, 90, y);
      g.fillStyle = "#ABA8C9"; g.textAlign = "right"; g.fillText(w.share[a.id] + "%", 990, y); g.textAlign = "left";
      pill(g, 90, y + 20, 900, 20, "rgba(255,255,255,0.08)");
      pill(g, 90, y + 20, Math.max(20, (900 * w.share[a.id]) / 100), 20, a.colour);
      y += 104;
    }
    g.fillStyle = "#ABA8C9"; g.font = "500 34px " + B;
    g.fillText(plural(w.nRead, "idea") + " read  ·  " + w.nStash + " stashed  ·  " + plural(w.days, "active day"), 90, H - 150);
    g.fillStyle = "#EEEDF7"; g.font = "800 40px " + D; g.fillText("Daily Idea", 90, H - 84);
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    if (!blob) { toast("Couldn't make the image on this device"); return; }
    const file = new File([blob], "my-week-in-mind.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "How my mind worked this week" }); } catch (_) { /* cancelled */ }
      return;
    }
    const a = el("a", { href: URL.createObjectURL(blob), download: file.name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Image saved");
  }

  let mindWeek = "this";
  function lastMonday() { return addDays(mondayOf(todayKey()), -7); }
  // Last week's report is ready if it has enough to go on and you haven't opened it yet.
  function mindReady() { const m = lastMonday(); return !weekData(m).sparse && store.get(KEYS.mindSeen, "") !== m; }
  function updateMindNudges() {
    const ready = mindReady();
    const dot = $("#mind-dot"); if (dot) dot.hidden = !ready;
    const ban = $("#mind-banner"); if (ban) ban.hidden = !ready;
  }

  function renderMind() {
    const body = $("#mind-body"); if (!body) return;
    const mon = mindWeek === "last" ? lastMonday() : mondayOf(todayKey());
    document.querySelectorAll("#mind-weeks button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.w === mindWeek)));
    $("#mind-sub").textContent = (mindWeek === "last" ? "Last week, " : "This week so far, ") + weekLabel(mon) + ".";
    if (mindWeek === "last") store.set(KEYS.mindSeen, mon);
    updateMindNudges();
    const w = weekData(mon), parts = [];
    if (w.sparse) {
      const meter = (n, of, label) => {
        const fill = el("span", { class: "mbar-fill" }); fill.style.width = Math.min(100, (n / of) * 100) + "%"; fill.style.background = "var(--accent)";
        return el("div", { class: "mbar" }, el("span", { class: "mbar-name", text: label }), el("span", { class: "mbar-track" }, fill), el("span", { class: "mbar-pct", text: Math.min(n, of) + "/" + of }));
      };
      parts.push(el("div", { class: "empty" },
        el("p", { class: "etitle", text: mindWeek === "last" ? "Not much to go on last week" : "Your Mindset is warming up" }),
        el("p", { text: "It's built from what you open and stash. Stash 3 ideas or open 6 in a week to unlock it." }),
        el("div", { class: "mbars" }, meter(w.nStash, 3, "Stashed"), meter(w.nRead, 6, "Opened"))));
      parts.push(tuneBox(null));
    } else {
      const p = profileOf(w);
      const hero = el("section", { class: "mhero" },
        el("span", { class: "mkicker", text: "How your mind worked" }),
        el("h2", { class: "mtitle", text: p.title }),
        el("p", { class: "mtrait", text: cap(p.trait) + "." }),
        el("p", { class: "mblurb", text: p.blurb }));
      hero.style.setProperty("--m", p.colour);
      const stat = (n, label) => el("div", { class: "mstat" }, el("b", { text: String(n) }), el("span", { text: label }));
      const shareBtn = el("button", { type: "button", class: "act" }, icon("share", ""), el("span", { text: "Share as image" }));
      shareBtn.addEventListener("click", () => shareMind(w, p));
      parts.push(hero,
        el("div", { class: "mstats" }, stat(w.nRead, "opened"), stat(w.nStash, "stashed"), stat(w.days, w.days === 1 ? "active day" : "active days")),
        el("section", { class: "mcard" }, el("h2", { class: "mh", text: "Your thinking map" }), radarSvg(w, p.colour), mindBars(w)),
        el("section", { class: "mcard" }, el("h2", { class: "mh", text: "The week in a nutshell" }),
          el("ul", { class: "mlist" }, ...narrative(w, p, weekData(addDays(mon, -7))).map((t) => el("li", { text: t })))),
        el("div", { class: "actions" }, shareBtn),
        tuneBox(p));
    }
    parts.push(el("p", { class: "mnote center", text: "Worked out on this phone from what you open and stash; nothing is sent anywhere. A playful mirror, not a personality test." }));
    body.replaceChildren(...parts);
  }
  document.querySelectorAll("#mind-weeks button").forEach((b) => b.addEventListener("click", () => { mindWeek = b.dataset.w; renderMind(); }));
  $("#mind-banner").addEventListener("click", () => { mindWeek = "last"; show("mind"); });

  /* ---------- Smart top-ups: tell the 7:40 task how many ideas are waiting unread ---------- */
  // Only one number leaves the phone: the unread count, written to status/unread.json on the repo's
  // "status" branch (not main, so the site doesn't rebuild). The task skips the day when it's over 10.
  const GH = { owner: "philipbrett007-stack", repo: "daily-idea", branch: "status", path: "status/unread.json" };
  let gh = store.get(KEYS.gh, null);   // { token, sha, sent: { unread, at }, error }
  function ghFetch(method, body, keepalive) {
    const url = "https://api.github.com/repos/" + GH.owner + "/" + GH.repo + "/contents/" + GH.path + (method === "GET" ? "?ref=" + GH.branch : "");
    const headers = { Authorization: "Bearer " + gh.token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (body) headers["Content-Type"] = "application/json";
    return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, keepalive: !!keepalive, cache: "no-store" });
  }
  async function reportUnread(opts) {
    opts = opts || {};
    if (!gh || !gh.token || !index || !index.days.length) return { ok: false };
    const unread = unreadCount(), now = Date.now();
    if (!opts.force && gh.sent && gh.sent.unread === unread && now - gh.sent.at < 6 * 3600e3) return { ok: true };
    const report = { unread, total: totalCount(), latest_day: index.latest, reported_at: new Date(now).toISOString() };
    const content = btoa(JSON.stringify(report, null, 1) + "\n");
    const put = (sha) => ghFetch("PUT", Object.assign({ message: "Unread: " + unread, content, branch: GH.branch }, sha ? { sha } : {}), opts.keepalive);
    try {
      let r = await put(gh.sha);
      if ((r.status === 409 || r.status === 422) && !opts.keepalive) {   // our copy of the file version is stale: fetch it and retry
        const g = await ghFetch("GET");
        r = await put(g.ok ? (await g.json()).sha : null);
      }
      if (!r.ok) { gh.error = r.status === 401 || r.status === 403 || r.status === 404 ? "key" : "other"; store.set(KEYS.gh, gh); return { ok: false, status: r.status }; }
      try { const j = await r.json(); if (j.content && j.content.sha) gh.sha = j.content.sha; } catch (_) { /* page closing */ }
      gh.sent = { unread, at: now }; delete gh.error; store.set(KEYS.gh, gh);
      return { ok: true };
    } catch (_) { return { ok: false, offline: true }; }
  }

  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago";
  }
  function renderSettings() {
    const st = $("#gh-status"), linked = !!(gh && gh.token);
    $("#gh-form").hidden = linked; $("#gh-linked").hidden = !linked;
    st.className = "gh-status";
    if (!linked) { st.textContent = "Not linked. The 7:40 task adds 5 ideas every morning."; return; }
    if (gh.error === "key") { st.classList.add("bad"); st.textContent = "GitHub didn't accept the key. It may have expired or lack Contents: Read and write. Unlink and add a new one."; return; }
    st.classList.add("good");
    st.textContent = gh.sent
      ? "Linked. Last sent " + ago(gh.sent.at) + ": " + plural(gh.sent.unread, "idea") + " unread, so the next 7:40 run will " + (gh.sent.unread > 10 ? "skip the day." : "add 5.")
      : "Linked. Your unread count will be sent shortly.";
  }
  const sheet = $("#sheet");
  $("#settings").addEventListener("click", () => { renderSettings(); sheet.showModal(); });
  $("#sheet-close").addEventListener("click", () => sheet.close());
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
  $("#gh-link").addEventListener("click", async () => {
    const token = $("#gh-token").value.trim();
    if (!/^(github_pat_|ghp_)[\w]{20,}$/.test(token)) { toast("That doesn't look like a GitHub token"); return; }
    const btn = $("#gh-link"); btn.disabled = true; btn.querySelector("span").textContent = "Linking…";
    gh = { token }; store.set(KEYS.gh, gh);
    const r = await reportUnread({ force: true });
    btn.disabled = false; btn.querySelector("span").textContent = "Link";
    if (r.ok) { $("#gh-token").value = ""; toast("Linked"); }
    else if (r.offline) toast("You're offline. Try again when connected.");
    else { gh = null; store.set(KEYS.gh, null); toast("GitHub didn't accept that key. Check step 4 and try again."); }
    renderSettings();
  });
  $("#gh-send").addEventListener("click", async () => { const r = await reportUnread({ force: true }); toast(r.ok ? "Sent" : "Couldn't send. Check your connection."); renderSettings(); });
  $("#gh-unlink").addEventListener("click", () => { gh = null; store.set(KEYS.gh, null); toast("Unlinked. Delete the key on GitHub too if you like."); renderSettings(); });

  /* ---------- views & loading ---------- */
  function show(name) {
    if (name === "mind" && view !== "mind" && mindReady()) mindWeek = "last";  // a fresh report opens first
    view = name;
    for (const v of ["today", "stash", "mind", "archive"]) $("#view-" + v).hidden = v !== name;
    document.querySelectorAll(".tab").forEach((t) => { if (t.dataset.view === name) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
    if (name === "stash") renderStash();
    if (name === "archive") renderArchive();
    if (name === "mind") renderMind();
    window.scrollTo(0, 0);
  }

  async function load(manual) {
    const rb = $("#refresh"); rb.classList.add("spin");
    const before = index ? index.days.reduce((s, d) => s + (Number(d.count) || 0), 0) : 0;
    try {
      await loadIndex();
      if (index.latest) { try { await loadDay(index.latest, true); } catch (_) { /* renderToday reports it */ } }
      banner(navigator.onLine === false ? "You're offline. Showing ideas saved on this phone." : "");
      lastLoad = Date.now();
      if (manual) {
        const after = index.days.reduce((s, d) => s + (Number(d.count) || 0), 0);
        toast(after > before ? (after - before) + " new idea" + (after - before === 1 ? "" : "s") + " in" : "You're up to date");
      }
    } catch (_) {
      banner("You're offline or the ideas couldn't load. Showing what's saved on this phone.");
      if (!index) index = { latest: null, days: [] };
    }
    rb.classList.remove("spin");
    updateMindNudges();
    reportUnread();
    await renderToday();
    if (view === "archive") renderArchive();
  }

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));
  $("#another").addEventListener("click", newIdea);
  $("#refresh").addEventListener("click", () => load(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { reportUnread({ keepalive: true }); return; }   // leaving the app: send the latest unread count
    if (Date.now() - lastLoad > 15 * 60 * 1000) load(false);
  });
  window.addEventListener("online", () => load(false));

  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; $("#install").hidden = false; });
  $("#install").addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (_) {}
    deferredInstall = null; $("#install").hidden = true;
  });
  window.addEventListener("appinstalled", () => { $("#install").hidden = true; toast("Installed. Find Daily Idea on your home screen."); });

  if ("serviceWorker" in navigator) {
    // When an updated version of the app is installed, reload once so it shows straight away.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").then((r) => r.update()).catch(() => {}); });
  }

  $("#today-h").textContent = greeting();
  renderStashCount();
  load(false);
})();
