/* Daily Idea — phone app logic.
   Ideas come from ideas/index.json and ideas/YYYY-MM-DD.json, written by the scheduled Claude task.
   "New idea" (or swiping the card left) swaps in an idea you haven't seen: today's first, then anything
   in the bank, up to 100 a day. Everything personal (what you've read, your stash) stays on this phone. */
(function () {
  "use strict";

  const TZ = "Europe/Dublin";
  const DAILY_LIMIT = 100;
  const KEYS = { stash: "di.stash.v1", seen: "di.seen.v1", shown: "di.shown.v2", taps: "di.taps.v2" };

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

  // Next idea: the newest day's ideas first (in order), then a random unseen idea from the rest of the bank.
  async function nextUnseen() {
    if (!index || !index.days.length) return null;
    const shownToday = new Set(shown[todayKey()] || []);
    const free = (k) => !seen.has(k) && !shownToday.has(k);
    const latest = index.latest;
    try {
      const d = await loadDay(latest);
      for (let i = 0; i < d.ideas.length; i++) { const k = keyOf(latest, d.ideas[i], i); if (free(k)) return k; }
    } catch (_) { /* fall through to the bank */ }
    const days = index.days.filter((x) => x.date !== latest && seenCount(x.date) < (Number(x.count) || 0)).map((x) => x.date);
    for (let i = days.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [days[i], days[j]] = [days[j], days[i]]; }
    for (const date of days) {
      let d; try { d = await loadDay(date); } catch (_) { continue; }
      const pool = d.ideas.map((x, i) => keyOf(date, x, i)).filter(free);
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
    return null;
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
    if (ted) return { kind: "iframe", src: "https://embed.ted.com/talks/" + ted[1], poster: safeUrl(v.thumb_url), open: u, site: "TED" };
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
    markSeen(ctx.key);
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
      markSeen(ctx.key);
    });
    return d;
  }

  function markSeen(key) { if (!seen.has(key)) { seen.add(key); store.set(KEYS.seen, Array.from(seen).slice(-5000)); } }

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
  }

  /* ---------- Today ---------- */
  function emptyBox(title, text) { return el("div", { class: "empty" }, el("p", { class: "etitle", text: title }), el("p", { text })); }

  // New batches of 10 researched ideas start arriving at these Dublin times (the scheduled task's run times).
  const BATCH_SIZE = 10;
  const BATCH_TIMES = [[7, 40, "7:40"], [17, 40, "17:40"]];
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

  /* ---------- views & loading ---------- */
  function show(name) {
    view = name;
    for (const v of ["today", "stash", "archive"]) $("#view-" + v).hidden = v !== name;
    document.querySelectorAll(".tab").forEach((t) => { if (t.dataset.view === name) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
    if (name === "stash") renderStash();
    if (name === "archive") renderArchive();
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
    await renderToday();
    if (view === "archive") renderArchive();
  }

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));
  $("#another").addEventListener("click", newIdea);
  $("#refresh").addEventListener("click", () => load(true));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastLoad > 15 * 60 * 1000) load(false); });
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
