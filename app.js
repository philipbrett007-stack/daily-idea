/* Daily Idea — phone app logic.
   Ideas come from ideas/index.json and ideas/YYYY-MM-DD.json, written by the scheduled Claude task.
   "New idea" swaps in an idea you haven't seen yet: today's first, then anything in the bank, up to 100 a day.
   Everything personal (what you've read, your stash) stays in this phone's storage. */
(function () {
  "use strict";

  const TZ = "Europe/Dublin";
  const DAILY_LIMIT = 100;
  const KEYS = { stash: "di.stash.v1", seen: "di.seen.v1", shown: "di.shown.v2", taps: "di.taps.v2" };

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
    image: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 16.5l4-4.5 3 3 2.5-2.5 2.5 4z" fill="currentColor"/><circle cx="15.5" cy="9" r="1.4" fill="currentColor"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M10 14l4-4M9 7h-1a5 5 0 000 10h1M15 7h1a5 5 0 010 10h-1" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
    caret: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M9 6.5v11L18 12z" fill="currentColor"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function icon(name, cls) { const s = el("span", { class: cls }); s.innerHTML = ICONS[name] || ICONS.link; return s; }

  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
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
  async function getJSON(path) {
    const r = await fetch(path, { cache: "no-cache" });
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
    try {
      const data = await getJSON("ideas/index.json");
      const days = (Array.isArray(data.days) ? data.days : [])
        .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      index = { latest: days.length ? days[0].date : null, days };
      indexMissing = false;
    } catch (e) {
      if (e.status === 404) { index = { latest: null, days: [] }; indexMissing = true; }
      else throw e;
    }
  }
  async function loadDay(date, fresh) {
    if (!fresh && dayCache.has(date)) return dayCache.get(date);
    const d = normaliseDay(await getJSON("ideas/" + date + ".json"), date);
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

  // Next idea for the New idea button: today's newest set first (in order), then a random unseen idea from the bank.
  async function nextUnseen() {
    if (!index || !index.days.length) return null;
    const today = todayKey();
    const shownToday = new Set(shown[today] || []);
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

  /* ---------- card ---------- */
  function block(label, content) { return el("div", { class: "block" }, el("div", { class: "label", text: label }), content); }

  function card(idea, ctx) {
    const key = ctx.key;
    const d = el("details", { class: "card" + (ctx.fresh ? " enter" : ""), "data-key": key });
    d.open = !!ctx.open;

    const meta = el("div", { class: "meta" },
      ctx.pos ? el("span", { class: "no", text: "Idea " + ctx.pos + (ctx.total ? "/" + ctx.total : "") })
              : el("span", { class: "no", text: ctx.label || fmtShort(ctx.date) }),
      idea.theme ? el("span", { text: String(idea.theme) }) : null,
      idea.featured ? el("span", { class: "pill", text: "Pick of the day" }) : null,
      ctx.fromDay ? el("span", { class: "pill", text: "From " + fmtShort(ctx.fromDay) }) : null);
    const head = el("div", { class: "titlerow" }, el("h3", { class: "title", text: String(idea.title) }), icon("caret", "caret"));
    d.append(el("summary", null, meta, head));

    const body = el("div", { class: "body" });

    if (idea.idea) {
      const box = el("div", { class: "idea" });
      for (const p of String(idea.idea).split(/\n\s*\n/)) if (p.trim()) box.append(el("p", { text: p.trim() }));
      body.append(box);
    }

    if (typeof idea.sketch_svg === "string") {
      const s = idea.sketch_svg.trim();
      if (s.startsWith("<svg") && s.length < 80000 && !/<script|<foreignObject|\son\w+\s*=|href\s*=\s*["']?(?!#)/i.test(s)) {
        body.append(el("figure", { class: "sketch" },
          el("img", { src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s), alt: idea.sketch_alt ? String(idea.sketch_alt) : "Sketch explaining the idea", loading: "lazy" }),
          idea.sketch_alt ? el("figcaption", { text: String(idea.sketch_alt) }) : null));
      }
    }

    if (Array.isArray(idea.why) && idea.why.length) {
      body.append(block("Why it holds up", el("ul", { class: "why" }, ...idea.why.map((w) => el("li", { text: String(w) })))));
    }

    const v = idea.visual, vu = v && safeUrl(v.url);
    if (vu) {
      const yt = ytId(vu);
      const kind = yt || v.type === "video" ? "video" : v.type === "image" ? "image" : "link";
      const a = el("a", { class: "visual", href: vu, target: "_blank", rel: "noopener noreferrer" });
      const looksLikeImage = (u) => /\.(jpe?g|png|webp|gif|svg)(\?|#|$)/i.test(u) || /^https:\/\/upload\.wikimedia\.org\//.test(u);
      const tu = safeUrl(v.thumb_url);
      let thumbSrc = null;
      if (yt) thumbSrc = "https://i.ytimg.com/vi/" + yt + "/hqdefault.jpg";
      else if (tu && looksLikeImage(tu)) thumbSrc = tu;
      else if (kind === "image" && looksLikeImage(vu)) thumbSrc = vu;
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
      body.append(block(kind === "video" ? "Watch" : "See it", a));
    }

    if (idea.try_this) {
      body.append(el("div", { class: "try" }, el("div", { class: "label", text: "Try this today" }), el("p", { text: String(idea.try_this) })));
    }

    const srcs = (Array.isArray(idea.sources) ? idea.sources : []).map((s) => ({ t: s && s.title, u: s && safeUrl(s.url) })).filter((s) => s.u);
    if (srcs.length) {
      body.append(block("Go deeper", el("ul", { class: "sources" },
        ...srcs.map((s) => el("li", null, el("a", { href: s.u, target: "_blank", rel: "noopener noreferrer", text: s.t ? String(s.t) : host(s.u) }))))));
    }

    const isStashed = !!stash[key];
    const shareBtn = el("button", { type: "button", class: "chip" }, icon("share", ""), "Share");
    shareBtn.addEventListener("click", () => share(idea));
    const stashBtn = el("button", { type: "button", class: "chip", "aria-pressed": String(isStashed) }, isStashed ? "Stashed" : "Stash");
    stashBtn.addEventListener("click", () => toggleStash(key, ctx.date, idea, stashBtn));
    body.append(el("div", { class: "foot" }, shareBtn, stashBtn));

    d.append(body);
    d.addEventListener("toggle", () => { if (d.open) markSeen(key); });
    if (d.open) markSeen(key);
    return d;
  }

  function markSeen(key) { if (!seen.has(key)) { seen.add(key); store.set(KEYS.seen, Array.from(seen).slice(-5000)); } }

  async function share(idea) {
    const src = (Array.isArray(idea.sources) ? idea.sources : []).map((s) => s && safeUrl(s.url)).find(Boolean);
    const text = idea.title + "\n\n" + (idea.idea || "") + (src ? "\n\nSource: " + src : "");
    if (navigator.share) { try { await navigator.share({ title: idea.title, text }); } catch (_) { /* cancelled */ } return; }
    try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); } catch (_) { toast("Couldn't share on this device"); }
  }

  function toggleStash(key, date, idea, btn) {
    if (stash[key]) { delete stash[key]; toast("Removed from Stash"); }
    else { stash[key] = { date, idea, savedAt: new Date().toISOString() }; toast("Stashed"); }
    store.set(KEYS.stash, stash);
    const on = !!stash[key];
    document.querySelectorAll('[data-key="' + CSS.escape(key) + '"] .foot .chip[aria-pressed]').forEach((b) => {
      b.setAttribute("aria-pressed", String(on)); b.textContent = on ? "Stashed" : "Stash";
    });
    if (btn) { btn.setAttribute("aria-pressed", String(on)); btn.textContent = on ? "Stashed" : "Stash"; }
    renderStashCount();
    if (view === "stash") renderStash();
  }

  /* ---------- Today ---------- */
  function emptyBox(title, text) { return el("div", { class: "empty" }, el("p", { class: "etitle", text: title }), el("p", { text })); }

  async function renderToday(opts) {
    const cardsEl = $("#today-cards"), btn = $("#another"), ask = $("#ask-claude"), note = $("#another-note");
    const earlier = $("#earlier"), earlierCards = $("#earlier-cards");
    const today = todayKey();
    $("#today-date").textContent = longFmt.format(asDate(today));

    if (!index || !index.days.length) {
      $("#today-sub").textContent = indexMissing ? "Your first ideas arrive at 9:00." : "No ideas yet.";
      cardsEl.replaceChildren(emptyBox("Nothing here yet", "Each morning a fresh set of ideas lands here. Tap refresh at the top to check."));
      btn.hidden = true; ask.hidden = true; earlier.hidden = true; note.textContent = ""; return;
    }

    let list = (shown[today] || []).slice();
    if (!list.length) {
      let k = await nextUnseen();
      if (!k) { try { const d = await loadDay(index.latest); if (d.ideas.length) k = keyOf(index.latest, d.ideas[0], 0); } catch (_) {} }
      if (k) { list = [k]; shown[today] = list; store.set(KEYS.shown, shown); }
    }

    const nodes = [];
    let current = null;
    for (let i = list.length - 1; i >= 0 && !current; i--) {
      try { current = await ideaByKey(list[i]); if (current) current.key = list[i]; } catch (_) { current = null; }
    }
    if (!current) {
      cardsEl.replaceChildren(emptyBox("Couldn't load the idea", "Check your connection and tap refresh at the top."));
      btn.hidden = true; ask.hidden = true; earlier.hidden = true; note.textContent = ""; return;
    }
    nodes.push(card(current.idea, {
      key: current.key, date: current.date, open: true, fresh: opts && opts.fresh,
      label: current.date === today ? "Today" : null, fromDay: current.date !== today ? current.date : null
    }));
    cardsEl.replaceChildren(...nodes);

    // Earlier today: everything shown before the current card, newest first, collapsed
    const prev = list.slice(0, -1).reverse();
    const prevNodes = [];
    for (const k of prev) {
      try { const r = await ideaByKey(k); if (r) prevNodes.push(card(r.idea, { key: k, date: r.date, open: false, fromDay: r.date !== today ? r.date : null })); } catch (_) {}
    }
    earlier.hidden = !prevNodes.length;
    earlierCards.replaceChildren(...prevNodes);

    // Button state
    const used = taps[today] || 0;
    $("#today-sub").textContent = "Not for you? Tap New idea for another.";
    if (used >= DAILY_LIMIT) {
      btn.hidden = false; btn.disabled = true; ask.hidden = true;
      $("#another-label").textContent = "That's 100 for today";
      note.textContent = "Fresh ideas arrive at 9:00 tomorrow.";
      return;
    }
    const hasNext = !!(await nextUnseen());
    if (hasNext) {
      btn.hidden = false; btn.disabled = false; ask.hidden = true;
      $("#another-label").textContent = "New idea";
      note.textContent = used ? used + " of " + DAILY_LIMIT + " used today" : "Up to " + DAILY_LIMIT + " a day";
    } else {
      btn.hidden = true; ask.hidden = false;
      note.textContent = "You've read every idea in the bank. Claude can research a fresh one in about 5 minutes; tap refresh here afterwards.";
    }
  }

  async function newIdea() {
    if (busy) return;
    const today = todayKey();
    if ((taps[today] || 0) >= DAILY_LIMIT) return;
    busy = true;
    const btn = $("#another"); btn.disabled = true;
    try {
      let k = await nextUnseen();
      if (!k) { try { await loadIndex(); dayCache.delete(index.latest); } catch (_) {} k = await nextUnseen(); }
      if (k) {
        const list = shown[today] || [];
        if (list.length) markSeen(list[list.length - 1]);
        shown[today] = list.concat(k); taps[today] = (taps[today] || 0) + 1;
        store.set(KEYS.shown, shown); store.set(KEYS.taps, taps);
      }
      await renderToday({ fresh: !!k });
      if (k) window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
    } finally {
      busy = false;
      if ((taps[today] || 0) < DAILY_LIMIT) btn.disabled = false;
    }
  }

  /* ---------- Stash ---------- */
  function renderStashCount() {
    const n = Object.keys(stash).length, c = $("#stash-count");
    c.textContent = n; c.hidden = n === 0;
  }
  function renderStash() {
    const list = Object.entries(stash).sort((a, b) => (a[1].savedAt < b[1].savedAt ? 1 : -1));
    $("#stash-sub").textContent = list.length ? list.length + (list.length === 1 ? " idea saved." : " ideas saved.") : "";
    const target = $("#stash-cards");
    if (!list.length) { target.replaceChildren(emptyBox("Nothing stashed yet", "Tap Stash on any card to keep it here. Your stash lives on this phone and works offline.")); return; }
    target.replaceChildren(...list.map(([key, s]) => card(s.idea, { key, date: s.date, open: false })));
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
    $("#archive-sub").textContent = totalIdeas + (totalIdeas === 1 ? " idea over " : " ideas over ") + index.days.length + (index.days.length === 1 ? " day." : " days.");
    target.replaceChildren(...index.days.map((day) => {
      const n = Number(day.count) || 0;
      const det = el("details", { class: "day" });
      const sum = el("summary", null,
        el("span", { class: "day-name", text: fmtDay(day.date) }),
        el("span", { class: "day-count", text: n + (n === 1 ? " idea" : " ideas") }));
      const body = el("div", { class: "day-body" });
      det.append(sum, body);
      det.addEventListener("toggle", async () => {
        if (!det.open || body.childElementCount) return;
        body.append(el("p", { class: "sub", text: "Loading…" }));
        try {
          const d = await loadDay(day.date);
          body.replaceChildren(...d.ideas.map((idea, i) => card(idea, { key: keyOf(day.date, idea, i), date: day.date, pos: i + 1, total: d.ideas.length, open: false })));
        } catch (_) { body.replaceChildren(el("p", { class: "sub", text: "Couldn't load this day. Check your connection." })); }
      });
      return det;
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
    // When an updated version of the app is installed, reload once so the new version shows straight away.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").then((r) => r.update()).catch(() => {}); });
  }

  renderStashCount();
  load(false);
})();
