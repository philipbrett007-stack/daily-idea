/* Daily Idea — phone app logic.
   Data comes from ideas/index.json and ideas/YYYY-MM-DD.json, written each morning by the scheduled Claude task.
   Everything personal (what you've read, your stash) stays in this phone's storage. */
(function () {
  "use strict";

  const TZ = "Europe/Dublin";
  const KEYS = { revealed: "di.revealed.v1", stash: "di.stash.v1", seen: "di.seen.v1", pulled: "di.pulled.v1" };

  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage full or blocked */ } }
  };

  let index = null;               // { latest, days: [{date, count, titles}] }
  let indexMissing = false;
  const dayCache = new Map();     // date -> { date, ideas: [...] }
  let revealed = store.get(KEYS.revealed, {});   // deckDate -> how many shown
  let stash = store.get(KEYS.stash, {});         // key -> { date, idea, savedAt }
  let seen = new Set(store.get(KEYS.seen, []));  // keys read
  let pulled = store.get(KEYS.pulled, {});       // deckDate -> [keys from earlier days]
  let view = "today";
  let lastLoad = 0;
  let deferredInstall = null;

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
  const asDate = (key) => new Date(key + "T12:00:00Z");
  function fmtDay(key) {
    if (key === dayKey(new Date())) return "Today";
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
  const keyOf = (date, idea, i) => date + "#" + (idea && idea.id ? String(idea.id) : String(i));

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }
  function banner(msg) { const b = $("#banner"); b.textContent = msg || ""; b.hidden = !msg; }

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
  function deckDate() {
    if (!index || !index.latest) return null;
    const today = dayKey(new Date());
    return index.days.some((d) => d.date === today) ? today : index.latest;
  }

  /* ---------- card ---------- */
  function block(label, content) { return el("div", { class: "block" }, el("div", { class: "label", text: label }), content); }

  function card(idea, ctx) {
    const key = ctx.key;
    const d = el("details", { class: "card" + (ctx.fresh ? " enter" : ""), "data-key": key });
    d.open = !!ctx.open;

    const meta = el("div", { class: "meta" },
      ctx.pos ? el("span", { class: "no", text: "Idea " + ctx.pos + (ctx.total ? "/" + ctx.total : "") }) : el("span", { class: "no", text: fmtShort(ctx.date) }),
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
      let thumbSrc = null;
      const looksLikeImage = (u) => /\.(jpe?g|png|webp|gif|svg)(\?|#|$)/i.test(u) || /^https:\/\/upload\.wikimedia\.org\//.test(u);
      const tu = safeUrl(v.thumb_url);
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

  function markSeen(key) { if (!seen.has(key)) { seen.add(key); store.set(KEYS.seen, Array.from(seen).slice(-3000)); } }

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
    const cardsEl = $("#today-cards"), btn = $("#another"), note = $("#another-note");
    const today = dayKey(new Date());
    $("#today-date").textContent = longFmt.format(asDate(today));
    const dd = deckDate();
    if (!dd) {
      $("#today-h").textContent = "Today's ideas";
      $("#today-sub").textContent = indexMissing ? "Your first set of ideas arrives at 9:00." : "No ideas yet.";
      cardsEl.replaceChildren(emptyBox("Nothing here yet", "Each morning at 9:00 a fresh set of ideas lands here. Pull the refresh button at the top to check."));
      btn.hidden = true; note.textContent = ""; return;
    }
    let deck;
    try { deck = await loadDay(dd); }
    catch (_) {
      cardsEl.replaceChildren(emptyBox("Couldn't load the ideas", "Check your connection and tap refresh at the top."));
      btn.hidden = true; note.textContent = ""; return;
    }
    const total = deck.ideas.length;
    const isToday = dd === today;
    $("#today-h").textContent = isToday ? "Today's ideas" : "Latest ideas";
    $("#today-sub").textContent = isToday
      ? (total === 1 ? "One idea today." : total + " ideas today. Start with the pick, then tap for more.")
      : "Today's set arrives at 9:00. Here's the latest, from " + (fmtDay(dd) === "Yesterday" ? "yesterday" : fmtDay(dd)) + ".";

    let n = Math.max(1, Math.min(total, revealed[dd] || 1));
    const extraKeys = (pulled[dd] || []).slice();
    const freshKey = opts && opts.freshKey;

    const nodes = [];
    deck.ideas.slice(0, n).forEach((idea, i) => {
      const key = keyOf(dd, idea, i);
      const isLast = i === n - 1 && !extraKeys.length;
      nodes.push(card(idea, { key, date: dd, pos: i + 1, total, open: isLast || key === freshKey, fresh: key === freshKey }));
    });
    for (const k of extraKeys) {
      const date = k.split("#")[0];
      try {
        const day = await loadDay(date);
        const i = day.ideas.findIndex((x, j) => keyOf(date, x, j) === k);
        if (i < 0) continue;
        const isLast = k === extraKeys[extraKeys.length - 1];
        nodes.push(card(day.ideas[i], { key: k, date, fromDay: date, open: isLast, fresh: k === freshKey }));
      } catch (_) { /* skip if that day can't load */ }
    }
    cardsEl.replaceChildren(...nodes);

    btn.hidden = false; btn.disabled = false;
    if (n < total) {
      $("#another-label").textContent = "Another idea";
      note.textContent = n + " of " + total + (isToday ? " today" : "");
    } else {
      const next = await findUnseenEarlier(dd, true);
      if (next) {
        $("#another-label").textContent = "Dip into an earlier day";
        note.textContent = "That's all " + total + (isToday ? " of today's." : ".") + " New set at 9:00.";
      } else {
        btn.hidden = true;
        note.textContent = "You've read every idea so far. New set at 9:00.";
      }
    }
  }

  async function findUnseenEarlier(dd, probeOnly) {
    if (!index) return null;
    const taken = new Set(pulled[dd] || []);
    for (const day of index.days) {
      if (day.date === dd) continue;
      let d;
      try { d = await loadDay(day.date); } catch (_) { continue; }
      for (let i = 0; i < d.ideas.length; i++) {
        const k = keyOf(day.date, d.ideas[i], i);
        if (!seen.has(k) && !taken.has(k)) return k;
      }
      if (probeOnly && dayCache.size > 40) break;
    }
    return null;
  }

  async function another() {
    const dd = deckDate(); if (!dd) return;
    const btn = $("#another"); btn.disabled = true;
    const deck = dayCache.get(dd); if (!deck) { btn.disabled = false; return; }
    const n = Math.max(1, Math.min(deck.ideas.length, revealed[dd] || 1));
    let freshKey = null;
    if (n < deck.ideas.length) {
      revealed[dd] = n + 1; store.set(KEYS.revealed, revealed);
      freshKey = keyOf(dd, deck.ideas[n], n);
    } else {
      const k = await findUnseenEarlier(dd, false);
      if (!k) { btn.disabled = false; await renderToday(); return; }
      pulled[dd] = (pulled[dd] || []).concat(k); store.set(KEYS.pulled, pulled);
      freshKey = k;
    }
    document.querySelectorAll("#today-cards details[open]").forEach((d) => { d.open = false; });
    await renderToday({ freshKey });
    const fresh = document.querySelector('#today-cards [data-key="' + CSS.escape(freshKey) + '"]');
    if (fresh) fresh.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
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
      target.replaceChildren(emptyBox("No ideas yet", "Every morning's set is kept here, newest first."));
      return;
    }
    const totalIdeas = index.days.reduce((s, d) => s + (Number(d.count) || 0), 0);
    $("#archive-sub").textContent = totalIdeas + (totalIdeas === 1 ? " idea over " : " ideas over ") + index.days.length + (index.days.length === 1 ? " day." : " days.");
    target.replaceChildren(...index.days.map((day) => {
      const det = el("details", { class: "day" });
      const sum = el("summary", null,
        el("span", { class: "day-name", text: fmtDay(day.date) }),
        el("span", { class: "day-count", text: (Number(day.count) || 0) + ((Number(day.count) || 0) === 1 ? " idea" : " ideas") }));
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
    const before = index && index.latest;
    try {
      await loadIndex();
      const dd = deckDate();
      if (dd) { try { await loadDay(dd, true); } catch (_) { /* renderToday reports it */ } }
      banner(navigator.onLine === false ? "You're offline. Showing ideas saved on this phone." : "");
      lastLoad = Date.now();
      if (manual) toast(index.latest && index.latest !== before ? "New ideas are in" : "You're up to date");
    } catch (_) {
      banner("You're offline or the ideas couldn't load. Showing what's saved on this phone.");
      if (!index) index = { latest: null, days: [] };
    }
    rb.classList.remove("spin");
    await renderToday();
    if (view === "archive") renderArchive();
  }

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));
  $("#another").addEventListener("click", another);
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
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }

  renderStashCount();
  load(false);
})();
