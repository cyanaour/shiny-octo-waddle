/* Liam Neeson Tracker - all filtering happens here, in the browser.
 * Data is loaded once from data/*.json and data/*.csv. */
(() => {
  "use strict";

  // ------------------------------------------------------------------ constants
  const ROLE_ORDER = ["Lead", "Supporting", "Cameo / small role", "Voice role", "Narrator", "Crew", "Himself"];
  // Colour-blind-checked palette (validated against the dark surface).
  const ROLE_COLORS = {
    "Lead": "#5B8DEF", "Supporting": "#D97E52", "Cameo / small role": "#2BA89C",
    "Voice role": "#A27BE6", "Narrator": "#6FA34A", "Crew": "#B0892A", "Himself": "#D9668F",
  };
  const MEDIA_COLORS = { movie: "#5B8DEF", tv: "#D97E52" };
  const MEDIA_LABEL = { movie: "Film", tv: "TV" };
  const IMG = "https://image.tmdb.org/t/p/";
  const PAGE = 40;
  const MIN_VOTES_AVG = 20;     // titles need this many votes to count in the average rating
  const MIN_VOTES_TOP = 100;    // ...and this many to make the "highest rated" top 10
  const T = { text: "#eef1f7", text2: "#aeb4c2", text3: "#7d8496", grid: "rgba(255,255,255,.06)", axis: "rgba(255,255,255,.14)", surface: "#11131b" };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------------ state
  let ALL = [];             // every credit row (after overrides + screen time)
  let BOUNDS = {};          // min/max for sliders
  let VIEW = [];            // rows passing the filters
  let sortKey = "date", sortDir = "desc";
  let shown = PAGE;
  let expanded = null;      // uid of expanded row
  const charts = {};
  const state = defaults();

  function defaults() {
    return { q: "", media: "all", status: "all", y0: null, y1: null, r0: 0, r1: 10, b0: 0, b1: null,
             roles: new Set(), genres: new Set(), himself: false };
  }

  // ------------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtInt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-IE"));
  function fmtMoney(n, short = true) {
    if (!n) return "—";
    if (!short) return "$" + Math.round(n).toLocaleString("en-US");
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M";
    if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K";
    return "$" + n;
  }
  function fmtMinutes(m) {
    if (m == null) return "—";
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60), r = Math.round(m % 60);
    return h + "h" + (r ? " " + String(r).padStart(2, "0") + "m" : "");
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
    return d.toLocaleDateString("en-IE", { day: "numeric", month: "short", year: "numeric" });
  }
  function ago(iso) {
    const days = Math.floor((Date.now() - new Date(iso)) / 864e5);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return days + " days ago";
    return fmtDate(iso);
  }
  const yearLabel = (c) => (c.year ? (c.media === "tv" && c.year_end && c.year_end !== c.year ? `${c.year}–${String(c.year_end).slice(2)}` : String(c.year)) : "TBA");

  /** Small CSV parser that copes with quotes, Excel's BOM and Windows line endings. */
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const rows = []; let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === "," || ch === ";" && !text.slice(0, 200).includes(",")) { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += ch;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    return rows.filter((r) => r.some((v) => v.trim() !== ""))
      .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
  }
  const num = (v) => { const n = parseFloat(String(v).replace(/[$,£€\s]/g, "")); return isFinite(n) ? n : null; };
  const normType = (t) => { t = String(t || "").toLowerCase(); return t.startsWith("tv") || t.startsWith("ser") ? "tv" : "movie"; };

  async function getJSON(url, fallback) {
    try { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw 0; return await r.json(); }
    catch { return fallback; }
  }
  async function getText(url) {
    try { const r = await fetch(url, { cache: "no-cache" }); return r.ok ? await r.text() : ""; }
    catch { return ""; }
  }

  // ------------------------------------------------------------------ data prep
  function applyOverrides(rows, overrides) {
    const numeric = new Set(["budget", "revenue", "rating", "votes", "runtime", "year", "year_end", "episodes", "order"]);
    const out = [];
    const byKey = new Map();
    rows.forEach((r) => { (byKey.get(r.key) || byKey.set(r.key, []).get(r.key)).push(r); });
    const drop = new Set();
    for (const o of overrides) {
      const key = normType(o.type) + ":" + parseInt(o.tmdb_id, 10);
      const field = (o.field || "").trim().toLowerCase().replace(/\s+/g, "_");
      const targets = byKey.get(key);
      if (!targets || !field) continue;
      let val = o.value;
      for (const r of targets) {
        if (field === "role_type" || field === "role") {
          if (r.credit === "crew") continue;
          const match = ROLE_ORDER.find((x) => x.toLowerCase().startsWith(val.toLowerCase().slice(0, 4)));
          r.role_type = match || val;
        } else if (field === "hide" || field === "exclude" || field === "hidden") {
          if (/^(y|yes|true|1)$/i.test(val)) drop.add(key);
        } else if (field === "upcoming") {
          r.upcoming = /^(y|yes|true|1)$/i.test(val);
        } else if (field === "genres") {
          r.genres = val.split(/[;|/]/).map((s) => s.trim()).filter(Boolean);
        } else if (field === "director") {
          r.director = val.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
        } else if (numeric.has(field)) {
          r[field] = val === "" ? null : num(val);
          if (field === "year") r.date = r[field] ? `${r[field]}-01-01` : null;
        } else {
          r[field] = val;
        }
      }
    }
    rows.forEach((r) => { if (!drop.has(r.key)) out.push(r); });
    return out;
  }

  function prepare(credits, screenRows, overrides) {
    const minutes = new Map();
    for (const s of screenRows) {
      const m = num(s.screentime_minutes);
      if (m != null && s.tmdb_id) minutes.set(normType(s.type) + ":" + parseInt(s.tmdb_id, 10), m);
    }
    let rows = credits.map((c) => ({ ...c, uid: c.key + ":" + c.credit }));
    rows = applyOverrides(rows, overrides);
    rows.forEach((r) => {
      r.minutes = r.credit === "cast" ? (minutes.get(r.key) ?? null) : null;
      r.searchText = [r.title, r.character, ...(r.jobs || [])].join(" ").toLowerCase();
      r.genres = r.genres || [];
    });
    return rows;
  }

  // ------------------------------------------------------------------ filtering
  function passes(r, s = state) {
    if (r.role_type === "Himself") { if (!s.himself) return false; }
    else if (s.roles.size && !s.roles.has(r.role_type)) return false;
    if (s.media !== "all" && r.media !== s.media) return false;
    if (s.status === "released" && r.upcoming) return false;
    if (s.status === "upcoming" && !r.upcoming) return false;
    const yearFull = s.y0 <= BOUNDS.y0 && s.y1 >= BOUNDS.y1;
    if (!yearFull && (r.year == null || r.year < s.y0 || r.year > s.y1)) return false;
    const ratingFull = s.r0 <= 0 && s.r1 >= 10;
    if (!ratingFull && (r.rating == null || r.rating < s.r0 || r.rating > s.r1)) return false;
    const budgetFull = s.b0 <= 0 && s.b1 >= BOUNDS.b1;
    if (!budgetFull) {
      const b = (r.budget || 0) / 1e6;
      if (!r.budget || b < s.b0 || b > s.b1) return false;
    }
    if (s.genres.size && !r.genres.some((g) => s.genres.has(g))) return false;
    if (s.q && !r.searchText.includes(s.q.toLowerCase())) return false;
    return true;
  }

  /** One entry per title (a title can have an acting row and a producer row). */
  function uniqueTitles(rows) {
    const m = new Map();
    for (const r of rows) { const e = m.get(r.key); if (!e || (e.credit === "crew" && r.credit === "cast")) m.set(r.key, r); }
    return [...m.values()];
  }

  // ------------------------------------------------------------------ URL state
  function readURL() {
    const p = new URLSearchParams(location.search);
    const range = (v) => (v || "").split("-").map(Number);
    if (p.has("q")) state.q = p.get("q");
    if (["movie", "tv"].includes(p.get("type"))) state.media = p.get("type");
    if (["released", "upcoming"].includes(p.get("status"))) state.status = p.get("status");
    if (p.has("years")) { const [a, b] = range(p.get("years")); if (a && b) { state.y0 = a; state.y1 = b; } }
    if (p.has("rating")) { const [a, b] = range(p.get("rating")); if (isFinite(a) && isFinite(b)) { state.r0 = a; state.r1 = b; } }
    if (p.has("budget")) { const [a, b] = range(p.get("budget")); if (isFinite(a) && isFinite(b)) { state.b0 = a; state.b1 = b; } }
    if (p.has("roles")) p.get("roles").split(",").forEach((r) => ROLE_ORDER.includes(r) && state.roles.add(r));
    if (p.has("genres")) p.get("genres").split(",").filter(Boolean).forEach((g) => state.genres.add(g));
    if (p.get("himself") === "1") state.himself = true;
    if (p.has("sort")) { const [k, d] = p.get("sort").split(":"); if (k) { sortKey = k; sortDir = d === "asc" ? "asc" : "desc"; } }
  }
  function writeURL() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.media !== "all") p.set("type", state.media);
    if (state.status !== "all") p.set("status", state.status);
    if (state.y0 > BOUNDS.y0 || state.y1 < BOUNDS.y1) p.set("years", `${state.y0}-${state.y1}`);
    if (state.r0 > 0 || state.r1 < 10) p.set("rating", `${state.r0}-${state.r1}`);
    if (state.b0 > 0 || state.b1 < BOUNDS.b1) p.set("budget", `${state.b0}-${state.b1}`);
    if (state.roles.size) p.set("roles", [...state.roles].join(","));
    if (state.genres.size) p.set("genres", [...state.genres].join(","));
    if (state.himself) p.set("himself", "1");
    if (sortKey !== "date" || sortDir !== "desc") p.set("sort", `${sortKey}:${sortDir}`);
    const qs = p.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    return [...p.keys()].filter((k) => k !== "sort").length;
  }

  // ------------------------------------------------------------------ filter UI
  function dualRange(el, { min, max, step, lo, hi, fmt, onInput, note }) {
    const id = el.id;
    el.innerHTML = `
      <div class="range-head"><span id="${id}-l">${esc(el.dataset.label)}</span><output id="${id}-o" aria-live="off"></output></div>
      <div class="dual"><div class="rail"></div><div class="fill"></div>
        <input type="range" aria-label="Minimum ${esc(el.dataset.label.toLowerCase())}" min="${min}" max="${max}" step="${step}" value="${lo}">
        <input type="range" aria-label="Maximum ${esc(el.dataset.label.toLowerCase())}" min="${min}" max="${max}" step="${step}" value="${hi}">
      </div>${note ? `<p class="range-note">${esc(note)}</p>` : ""}`;
    const [a, b] = el.querySelectorAll("input");
    const fill = $(".fill", el), out = $("output", el);
    function paint() {
      const x = +a.value, y = +b.value;
      fill.style.left = ((x - min) / (max - min)) * 100 + "%";
      fill.style.right = (100 - ((y - min) / (max - min)) * 100) + "%";
      out.textContent = `${fmt(x)} – ${fmt(y)}`;
      a.setAttribute("aria-valuetext", fmt(x)); b.setAttribute("aria-valuetext", fmt(y));
    }
    function handle(e) {
      if (+a.value > +b.value) { if (e.target === a) a.value = b.value; else b.value = a.value; }
      // keep the thumb you're dragging on top
      a.style.zIndex = e.target === a ? 3 : 2; b.style.zIndex = e.target === b ? 3 : 2;
      paint(); onInput(+a.value, +b.value);
    }
    a.addEventListener("input", handle); b.addEventListener("input", handle);
    paint();
    return { set(x, y) { a.value = x; b.value = y; paint(); } };
  }

  let sliders = {};
  function buildFilters() {
    sliders.year = dualRange($("#f-year"), { min: BOUNDS.y0, max: BOUNDS.y1, step: 1, lo: state.y0, hi: state.y1,
      fmt: (v) => String(v), onInput: (x, y) => { state.y0 = x; state.y1 = y; schedule(); } });
    sliders.rating = dualRange($("#f-rating"), { min: 0, max: 10, step: 0.5, lo: state.r0, hi: state.r1,
      fmt: (v) => (+v).toFixed(1), onInput: (x, y) => { state.r0 = x; state.r1 = y; schedule(); },
      note: "Narrowing this hides unrated titles." });
    sliders.budget = dualRange($("#f-budget"), { min: 0, max: BOUNDS.b1, step: 5, lo: state.b0, hi: state.b1,
      fmt: (v) => (v >= BOUNDS.b1 ? `$${v}M+` : `$${v}M`), onInput: (x, y) => { state.b0 = x; state.b1 = y; schedule(); },
      note: "Narrowing this shows only films with a known budget." });

    const roleCounts = {}; ALL.forEach((r) => (roleCounts[r.role_type] = (roleCounts[r.role_type] || 0) + 1));
    $("#f-roles").innerHTML = ROLE_ORDER.filter((r) => r !== "Himself" && roleCounts[r]).map((r) =>
      `<button type="button" class="chip" data-role="${esc(r)}" aria-pressed="${state.roles.has(r)}">
         <span class="dot" style="background:${ROLE_COLORS[r]}"></span>${esc(r)} <span class="n">${roleCounts[r]}</span></button>`).join("");
    const gCounts = {}; uniqueTitles(ALL.filter((r) => r.role_type !== "Himself")).forEach((r) => r.genres.forEach((g) => (gCounts[g] = (gCounts[g] || 0) + 1)));
    $("#f-genres").innerHTML = Object.entries(gCounts).sort((a, b) => b[1] - a[1]).map(([g, n]) =>
      `<button type="button" class="chip" data-genre="${esc(g)}" aria-pressed="${state.genres.has(g)}">${esc(g)} <span class="n">${n}</span></button>`).join("");

    $("#f-roles").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      toggleSet(state.roles, b.dataset.role); b.setAttribute("aria-pressed", state.roles.has(b.dataset.role)); schedule();
    });
    $("#f-genres").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      toggleSet(state.genres, b.dataset.genre); b.setAttribute("aria-pressed", state.genres.has(b.dataset.genre)); schedule();
    });
    $("#f-himself").addEventListener("change", (e) => { state.himself = e.target.checked; schedule(); });
    let qt; $("#f-q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim(); schedule(); }, 180); });
    document.querySelectorAll('input[name="media"]').forEach((i) => i.addEventListener("change", () => { state.media = i.value; schedule(); }));
    document.querySelectorAll('input[name="status"]').forEach((i) => i.addEventListener("change", () => { state.status = i.value; schedule(); }));
    $("#f-reset").addEventListener("click", resetFilters);
    $("#f-share").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(location.href); toast("Link copied: it opens this exact view"); }
      catch { toast("Copy the address bar to share this view"); }
    });
    $("#f-done").addEventListener("click", () => {
      $("#filters-toggle").setAttribute("aria-expanded", "false"); $(".filters").classList.remove("open");
      $("#charts-h").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    });
    const tog = $("#filters-toggle");
    tog.addEventListener("click", () => {
      const open = tog.getAttribute("aria-expanded") !== "true";
      tog.setAttribute("aria-expanded", open); $(".filters").classList.toggle("open", open);
    });
    syncControls();
  }
  const toggleSet = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));

  function syncControls() {
    $("#f-q").value = state.q;
    document.querySelectorAll('input[name="media"]').forEach((i) => (i.checked = i.value === state.media));
    document.querySelectorAll('input[name="status"]').forEach((i) => (i.checked = i.value === state.status));
    $("#f-himself").checked = state.himself;
    document.querySelectorAll("[data-role]").forEach((b) => b.setAttribute("aria-pressed", state.roles.has(b.dataset.role)));
    document.querySelectorAll("[data-genre]").forEach((b) => b.setAttribute("aria-pressed", state.genres.has(b.dataset.genre)));
    sliders.year.set(state.y0, state.y1); sliders.rating.set(state.r0, state.r1); sliders.budget.set(state.b0, state.b1);
    $("#sort-select").value = `${sortKey}:${sortDir}`;
  }

  function resetFilters() {
    Object.assign(state, defaults(), { y0: BOUNDS.y0, y1: BOUNDS.y1, b1: BOUNDS.b1 });
    syncControls(); update(); toast("Filters reset");
  }

  let raf;
  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); }

  function update() {
    VIEW = ALL.filter((r) => passes(r));
    shown = PAGE; expanded = null;
    const active = writeURL();
    const badge = $("#filters-count"); badge.hidden = !active; badge.textContent = active;
    const titles = uniqueTitles(VIEW).length;
    $("#result-count").textContent = `${titles} title${titles === 1 ? "" : "s"} match`;
    $("#f-done").textContent = `Show ${titles} result${titles === 1 ? "" : "s"}`;
    renderStats(); renderCharts(); renderTops(); renderTable();
  }

  // ------------------------------------------------------------------ stat tiles
  const tileValues = {};
  function renderStats() {
    const t = uniqueTitles(VIEW);
    const films = t.filter((r) => r.media === "movie");
    const tv = t.filter((r) => r.media === "tv");
    const eps = tv.reduce((s, r) => s + (r.credit === "cast" ? r.episodes || 0 : 0), 0);
    const released = t.filter((r) => !r.upcoming && r.year);
    const y0 = Math.min(...released.map((r) => r.year)), y1 = Math.max(...released.map((r) => r.year), ...released.map((r) => r.year_end || 0));
    const box = films.reduce((s, r) => s + (r.revenue || 0), 0);
    const boxN = films.filter((r) => r.revenue).length;
    const rated = t.filter((r) => r.rating && r.votes >= MIN_VOTES_AVG);
    const avg = rated.length ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : null;
    const actingTitles = t.filter((r) => r.credit === "cast");
    const recorded = actingTitles.filter((r) => r.minutes != null);
    const mins = recorded.reduce((s, r) => s + r.minutes, 0);
    const upcoming = t.filter((r) => r.upcoming).length;

    const tiles = [
      { id: "films", label: "Films", value: films.length, fmt: fmtInt, sub: upcoming ? `${films.filter((r) => r.upcoming).length} upcoming` : "released & upcoming" },
      { id: "series", label: "TV series", value: tv.length, fmt: fmtInt, sub: tv.length ? "shows appeared in" : "none in view" },
      { id: "eps", label: "TV episodes", value: eps, fmt: fmtInt, sub: "episodes he's in" },
      { id: "years", label: "Years active", value: isFinite(y0) ? y1 - y0 + 1 : null, fmt: fmtInt, sub: isFinite(y0) ? `${y0} – ${y1}` : "—" },
      { id: "box", label: "Total box office", value: box, fmt: (v) => fmtMoney(v), sub: `worldwide, ${boxN} film${boxN === 1 ? "" : "s"} with figures` },
      { id: "rating", label: "Average rating", value: avg, fmt: (v) => (v == null ? "—" : v.toFixed(2)), sub: `TMDB, ${rated.length} rated title${rated.length === 1 ? "" : "s"}` },
      { id: "screen", label: "Screen time", value: recorded.length ? mins : null, fmt: (v) => (v == null ? "—" : fmtMinutes(v)), sub: `${recorded.length} of ${actingTitles.length} titles recorded` },
    ];
    const box_ = $("#stats");
    if (!box_.children.length) {
      box_.innerHTML = tiles.map((t) => `<div class="stat" id="s-${t.id}"><p class="label">${t.label}</p><p class="value">—</p><p class="sub"></p></div>`).join("");
    }
    for (const tile of tiles) {
      const el = $("#s-" + tile.id);
      $(".sub", el).textContent = tile.sub;
      el.classList.toggle("dim", tile.value == null || tile.value === 0);
      countTo($(".value", el), tileValues[tile.id] ?? 0, tile.value, tile.fmt);
      tileValues[tile.id] = tile.value ?? 0;
    }
  }
  function countTo(el, from, to, fmt) {
    if (to == null) { el.textContent = fmt(null); return; }
    if (reduceMotion || from === to) { el.textContent = fmt(to); return; }
    const start = performance.now(), dur = 550;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(el._raf); el._raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ charts
  const baseText = { color: T.text2, fontFamily: "Inter, system-ui, sans-serif", fontSize: 12 };
  const tooltipBase = {
    backgroundColor: "rgba(17,19,27,.92)", borderColor: "rgba(255,255,255,.14)", borderWidth: 1, padding: [8, 12],
    textStyle: { color: T.text, fontFamily: "Inter, system-ui, sans-serif", fontSize: 13 },
    extraCssText: "border-radius:12px;box-shadow:0 16px 40px -12px #000;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);",
  };
  const axisCommon = {
    axisLine: { lineStyle: { color: T.axis } }, axisTick: { show: false },
    axisLabel: { color: T.text3, fontSize: 11 }, splitLine: { lineStyle: { color: T.grid } },
  };
  const anim = { animationDuration: reduceMotion ? 0 : 600, animationDurationUpdate: reduceMotion ? 0 : 500, animationEasingUpdate: "cubicOut" };

  function chart(id) {
    if (!charts[id]) {
      const el = document.getElementById(id);
      charts[id] = echarts.init(el, null, { renderer: "canvas" });
      charts[id].on("click", (p) => p.data && p.data.uid && openDetail(p.data.uid));
    }
    return charts[id];
  }
  function empty(id, msg) {
    if (charts[id]) { charts[id].dispose(); delete charts[id]; }
    const el = document.getElementById(id);
    el.innerHTML = `<div class="chart-empty">${esc(msg)}</div>`;
    el.setAttribute("aria-label", msg);
  }
  function describe(id, text) { document.getElementById(id).setAttribute("aria-label", text); }

  function renderCharts() {
    if (!window.echarts) return;
    const t = uniqueTitles(VIEW);

    // 1. Credits per year (stacked film / TV)
    const years = t.filter((r) => r.year);
    if (!years.length) empty("c-years", "No titles with a known year in this view.");
    else {
      const y0 = Math.min(...years.map((r) => r.year)), y1 = Math.max(...years.map((r) => r.year));
      const cats = []; for (let y = y0; y <= y1; y++) cats.push(String(y));
      const count = (m) => cats.map((y) => years.filter((r) => r.media === m && String(r.year) === y).length);
      const film = count("movie"), tv = count("tv");
      const series = [["movie", film], ["tv", tv]].filter(([, d]) => d.some(Boolean)).map(([m, d]) => ({
        name: MEDIA_LABEL[m], type: "bar", stack: "a", data: d, barMaxWidth: 18,
        itemStyle: { color: MEDIA_COLORS[m], borderRadius: m === "tv" || !tv.some(Boolean) ? [4, 4, 0, 0] : 0, borderColor: T.surface, borderWidth: 1 },
        emphasis: { focus: "series" },
      }));
      chart("c-years").setOption({
        ...anim, textStyle: baseText,
        legend: { top: 0, right: 0, textStyle: { color: T.text2 }, itemWidth: 12, itemHeight: 12, icon: "roundRect" },
        grid: { left: 34, right: 8, top: 34, bottom: 28 },
        tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(157,184,255,.07)" } } },
        xAxis: { type: "category", data: cats, ...axisCommon, splitLine: { show: false } },
        yAxis: { type: "value", minInterval: 1, ...axisCommon },
        series,
      }, true);
      const peak = cats.map((y, i) => [y, film[i] + tv[i]]).sort((a, b) => b[1] - a[1])[0];
      describe("c-years", `Bar chart of credits per year from ${y0} to ${y1}. Busiest year: ${peak[0]} with ${peak[1]} titles.`);
    }

    // 2. Genres (horizontal bars, sorted)
    const gc = {}; t.forEach((r) => r.genres.forEach((g) => (gc[g] = (gc[g] || 0) + 1)));
    const gEntries = Object.entries(gc).sort((a, b) => b[1] - a[1]).slice(0, 12).reverse();
    if (!gEntries.length) empty("c-genres", "No genre data in this view.");
    else {
      chart("c-genres").setOption({
        ...anim, textStyle: baseText,
        grid: { left: 8, right: 36, top: 6, bottom: 6, containLabel: true },
        tooltip: { ...tooltipBase, trigger: "item", formatter: (p) => `<b>${esc(p.name)}</b><br>${p.value} title${p.value === 1 ? "" : "s"}` },
        xAxis: { type: "value", show: false },
        yAxis: { type: "category", data: gEntries.map((e) => e[0]), ...axisCommon, axisLine: { show: false }, axisLabel: { color: T.text2, fontSize: 12 } },
        series: [{ type: "bar", data: gEntries.map((e) => e[1]), barMaxWidth: 16, itemStyle: { color: "#5B8DEF", borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: "right", color: T.text2, fontSize: 11 } }],
      }, true);
      const top = gEntries[gEntries.length - 1];
      describe("c-genres", `Bar chart of genres. Most common: ${top[0]} with ${top[1]} titles.`);
    }

    // 3. Role types
    const rc = {}; VIEW.forEach((r) => (rc[r.role_type] = (rc[r.role_type] || 0) + 1));
    const rEntries = ROLE_ORDER.filter((r) => rc[r]).map((r) => [r, rc[r]]).reverse();
    if (!rEntries.length) empty("c-roles", "No credits in this view.");
    else {
      chart("c-roles").setOption({
        ...anim, textStyle: baseText,
        grid: { left: 8, right: 36, top: 6, bottom: 6, containLabel: true },
        tooltip: { ...tooltipBase, trigger: "item", formatter: (p) => `<b>${esc(p.name)}</b><br>${p.value} credit${p.value === 1 ? "" : "s"}` },
        xAxis: { type: "value", show: false },
        yAxis: { type: "category", data: rEntries.map((e) => e[0]), ...axisCommon, axisLine: { show: false }, axisLabel: { color: T.text2, fontSize: 12 } },
        series: [{ type: "bar", barMaxWidth: 16, data: rEntries.map(([r, n]) => ({ value: n, name: r, itemStyle: { color: ROLE_COLORS[r] || "#8f8577", borderRadius: [0, 4, 4, 0] } })),
          label: { show: true, position: "right", color: T.text2, fontSize: 11 } }],
      }, true);
      describe("c-roles", "Bar chart of role types: " + rEntries.slice().reverse().map(([r, n]) => `${r} ${n}`).join(", ") + ".");
    }

    // 4. Rating over time (scatter)
    const rated = t.filter((r) => r.rating && r.date && r.votes >= 5);
    if (!rated.length) empty("c-ratings", "No rated titles in this view.");
    else {
      const maxV = Math.max(...rated.map((r) => r.votes));
      const big = document.getElementById("c-ratings").clientWidth > 600;
      const size = (v) => (big ? 7 : 5) + (big ? 17 : 11) * Math.sqrt(v / maxV);
      const ser = ["movie", "tv"].map((m) => ({
        name: MEDIA_LABEL[m], type: "scatter",
        data: rated.filter((r) => r.media === m).map((r) => ({ value: [r.date, r.rating, r.votes], uid: r.uid, name: r.title, r })),
        symbolSize: (v) => size(v[2]),
        itemStyle: { color: MEDIA_COLORS[m], opacity: 0.85, borderColor: T.surface, borderWidth: 1.5 },
        emphasis: { scale: 1.3, itemStyle: { borderColor: "#fff" } },
      })).filter((s) => s.data.length);
      chart("c-ratings").setOption({
        ...anim, textStyle: baseText,
        legend: { top: 0, right: 0, textStyle: { color: T.text2 }, itemWidth: 12, itemHeight: 12 },
        grid: { left: 34, right: 12, top: 34, bottom: 28 },
        tooltip: { ...tooltipBase, trigger: "item", formatter: (p) => {
          const r = p.data.r; return `<b>${esc(r.title)}</b> (${yearLabel(r)})<br>★ ${r.rating.toFixed(1)} · ${fmtInt(r.votes)} votes<br><span style="color:${T.text3}">${esc(r.role_type)}${r.character ? " · " + esc(r.character) : ""}</span><br><span style="color:${T.text3}">Click for details</span>`; } },
        xAxis: { type: "time", ...axisCommon, splitLine: { show: false } },
        yAxis: { type: "value", min: (v) => Math.max(0, Math.floor(v.min)), max: 10, ...axisCommon },
        series: ser,
      }, true);
      const best = rated.filter((r) => r.votes >= MIN_VOTES_TOP).sort((a, b) => b.rating - a.rating)[0] || rated[0];
      describe("c-ratings", `Scatter chart of ${rated.length} titles' TMDB ratings over time. Highest rated with 100+ votes: ${best.title} (${best.rating.toFixed(1)}).`);
    }

    // 5. Budget vs box office (log-log scatter, break-even line)
    const money = t.filter((r) => r.media === "movie" && r.budget && r.revenue && r.budget >= 1e5 && r.revenue >= 1e4);
    if (!money.length) empty("c-money", "No films with both budget and box office figures in this view.");
    else {
      const lo = Math.min(...money.flatMap((r) => [r.budget, r.revenue])), hi = Math.max(...money.flatMap((r) => [r.budget, r.revenue]));
      const roles = ROLE_ORDER.filter((x) => money.some((r) => r.role_type === x));
      chart("c-money").setOption({
        ...anim, textStyle: baseText,
        legend: { top: 0, right: 0, data: roles, textStyle: { color: T.text2 }, itemWidth: 12, itemHeight: 12 },
        grid: { left: 66, right: 30, top: 44, bottom: 44 },
        tooltip: { ...tooltipBase, trigger: "item", formatter: (p) => {
          if (!p.data.r) return ""; const r = p.data.r, x = r.revenue / r.budget;
          return `<b>${esc(r.title)}</b> (${r.year || "TBA"})<br>Budget ${fmtMoney(r.budget)} · Box office ${fmtMoney(r.revenue)}<br>${x >= 1 ? "Earned " + x.toFixed(1) + "× its budget" : "Earned " + Math.round(x * 100) + "% of its budget"}<br><span style="color:${T.text3}">${esc(r.role_type)} · Click for details</span>`; } },
        xAxis: { type: "log", name: "Budget", nameLocation: "middle", nameGap: 28, nameTextStyle: { color: T.text3 }, ...axisCommon, axisLabel: { color: T.text3, fontSize: 11, formatter: (v) => fmtMoney(v) } },
        yAxis: { type: "log", name: "Box office", nameLocation: "middle", nameGap: 54, nameTextStyle: { color: T.text3 }, ...axisCommon, axisLabel: { color: T.text3, fontSize: 11, formatter: (v) => fmtMoney(v) } },
        series: [
          ...roles.map((role, i) => ({
            name: role, type: "scatter", symbolSize: 11,
            data: money.filter((r) => r.role_type === role).map((r) => ({ value: [r.budget, r.revenue], uid: r.uid, name: r.title, r })),
            itemStyle: { color: ROLE_COLORS[role], opacity: 0.9, borderColor: T.surface, borderWidth: 1.5 },
            emphasis: { scale: 1.4, itemStyle: { borderColor: "#fff" } },
          })),
          { name: "Break-even", type: "line", silent: true, symbol: "none", z: 1, data: [[lo, lo], [hi, hi]],
            lineStyle: { color: T.text3, type: "dashed", width: 1 }, tooltip: { show: false },
            endLabel: { show: true, formatter: "Break-even", color: T.text3, fontSize: 11, offset: [-70, -12] } },
        ],
      }, true);
      const hits = money.filter((r) => r.revenue > r.budget).length;
      describe("c-money", `Scatter chart of ${money.length} films' budget against box office. ${hits} earned more than their budget.`);
    }

    // 6. Screen time by year
    const acting = t.filter((r) => r.credit === "cast");
    const st = acting.filter((r) => r.minutes != null && r.year);
    $("#c-screen-sub").textContent = `Minutes on screen, from titles recorded so far: ${st.length} of ${acting.length} titles recorded`;
    if (!st.length) empty("c-screen", "No screen time recorded yet for these titles. Add minutes to data/screentime.csv (see the README) and they'll appear here.");
    else {
      const y0 = Math.min(...st.map((r) => r.year)), y1 = Math.max(...st.map((r) => r.year));
      const cats = []; for (let y = y0; y <= y1; y++) cats.push(String(y));
      const sum = cats.map((y) => st.filter((r) => String(r.year) === y).reduce((s, r) => s + r.minutes, 0));
      chart("c-screen").setOption({
        ...anim, textStyle: baseText,
        grid: { left: 44, right: 8, top: 16, bottom: 28 },
        tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: "rgba(157,184,255,.07)" } },
          formatter: (ps) => { const y = ps[0].name; const list = st.filter((r) => String(r.year) === y);
            return `<b>${y}</b>: ${fmtMinutes(ps[0].value)}<br>` + list.map((r) => `<span style="color:${T.text3}">${esc(r.title)}: ${fmtMinutes(r.minutes)}</span>`).join("<br>"); } },
        xAxis: { type: "category", data: cats, ...axisCommon, splitLine: { show: false } },
        yAxis: { type: "value", ...axisCommon, axisLabel: { color: T.text3, fontSize: 11, formatter: (v) => v + "m" } },
        series: [{ type: "bar", data: sum, barMaxWidth: 18, itemStyle: { color: "#5B8DEF", borderRadius: [4, 4, 0, 0] } }],
      }, true);
      describe("c-screen", `Bar chart of recorded screen time per year; ${st.length} of ${acting.length} titles recorded.`);
    }
  }

  // ------------------------------------------------------------------ top tens
  function renderTops() {
    const t = uniqueTitles(VIEW);
    const lists = [
      { h: "Highest rated", note: `min. ${MIN_VOTES_TOP} votes`, rows: t.filter((r) => r.rating && r.votes >= MIN_VOTES_TOP).sort((a, b) => b.rating - a.rating), v: (r) => "★ " + r.rating.toFixed(1) },
      { h: "Highest grossing", rows: t.filter((r) => r.revenue).sort((a, b) => b.revenue - a.revenue), v: (r) => fmtMoney(r.revenue) },
      { h: "Biggest budget", rows: t.filter((r) => r.budget).sort((a, b) => b.budget - a.budget), v: (r) => fmtMoney(r.budget) },
      { h: "Longest screen time", rows: t.filter((r) => r.minutes != null).sort((a, b) => b.minutes - a.minutes), v: (r) => fmtMinutes(r.minutes), emptyMsg: "No screen time recorded yet." },
      { h: "Most TV episodes", rows: t.filter((r) => r.media === "tv" && r.episodes).sort((a, b) => b.episodes - a.episodes), v: (r) => r.episodes + " ep" + (r.episodes === 1 ? "" : "s") },
    ];
    $("#tops").innerHTML = lists.map((l) => `
      <div class="card top"><h3>${l.h}${l.note ? ` <span class="hint" style="font:12px var(--font-ui)">${l.note}</span>` : ""}</h3>
        ${l.rows.length ? `<ol>${l.rows.slice(0, 10).map((r) => `<li><button type="button" data-uid="${esc(r.uid)}" title="${esc(r.title)}">
          <span class="t">${esc(r.title)}<small>${yearLabel(r)}</small></span><span class="v">${l.v(r)}</span></button></li>`).join("")}</ol>`
        : `<p class="empty">${l.emptyMsg || "Nothing matches the current filters."}</p>`}
      </div>`).join("");
  }

  // ------------------------------------------------------------------ table
  function sortRows(rows) {
    const k = sortKey, dir = sortDir === "asc" ? 1 : -1;
    const val = (r) => {
      if (k === "date") return r.date || (r.upcoming ? "9999" : "0000");
      if (k === "character") return (r.character || (r.jobs || []).join(", ") || "").toLowerCase();
      if (k === "title" || k === "media" || k === "role_type") return String(r[k] || "").toLowerCase();
      return r[k];
    };
    return rows.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1; if (y == null) return -1;   // blanks always last
      return (x < y ? -1 : x > y ? 1 : 0) * dir || String(a.title).localeCompare(b.title);
    });
  }

  function renderTable() {
    const rows = sortRows(VIEW);
    document.querySelectorAll(".credits th").forEach((th) =>
      th.setAttribute("aria-sort", th.dataset.sort === sortKey ? (sortDir === "asc" ? "ascending" : "descending") : "none"));
    const body = $("#credits-body");
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" class="muted" style="padding:24px;text-align:center">Nothing matches these filters. <button class="btn btn-ghost" type="button" onclick="document.getElementById('f-reset').click()">Reset filters</button></td></tr>`;
      $("#show-more").hidden = true; return;
    }
    body.innerHTML = rows.slice(0, shown).map((r, i) => rowHTML(r, i) + (expanded === r.uid ? detailHTML(r) : "")).join("");
    const left = rows.length - shown;
    const more = $("#show-more"); more.hidden = left <= 0;
    more.textContent = `Show ${Math.min(left, PAGE)} more (${left} left)`;
  }

  function rowHTML(r, i) {
    const who = r.credit === "crew" ? (r.jobs || []).join(", ") : r.character || "—";
    const sub = r.media === "tv" && r.episodes ? `${r.episodes} episode${r.episodes === 1 ? "" : "s"}` : r.director && r.media === "movie" ? "dir. " + r.director.slice(0, 2).join(", ") : "";
    return `<tr class="row" tabindex="0" data-uid="${esc(r.uid)}" aria-expanded="${expanded === r.uid}" aria-controls="d-${esc(r.uid)}" style="animation-delay:${Math.min(i, 20) * 12}ms">
      <td>${yearLabel(r)}</td>
      <td class="title-cell"><span class="caret" aria-hidden="true">›</span>${esc(r.title)}${r.upcoming ? '<span class="pill up">Upcoming</span>' : ""}<span class="sub">${esc(sub)}</span></td>
      <td class="hide-sm">${MEDIA_LABEL[r.media]}</td>
      <td><span class="tag"><i style="background:${ROLE_COLORS[r.role_type] || "#8f8577"}"></i><span>${esc(r.role_type)}</span></span></td>
      <td class="hide-md">${esc(who)}</td>
      <td class="num">${r.rating ? r.rating.toFixed(1) : '<span class="muted">—</span>'}</td>
      <td class="num hide-sm">${r.revenue ? fmtMoney(r.revenue) : '<span class="muted">—</span>'}</td>
      <td class="num hide-md">${r.minutes != null ? fmtMinutes(r.minutes) : '<span class="muted">—</span>'}</td>
    </tr>`;
  }

  function detailHTML(r) {
    const url = `https://www.themoviedb.org/${r.media}/${r.id}`;
    const fact = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    const facts = [
      fact(r.credit === "crew" ? "Job" : "Character", esc(r.credit === "crew" ? (r.jobs || []).join(", ") : r.character || "—")),
      fact("Role type", esc(r.role_type)),
      fact(r.media === "tv" ? "Created by" : "Director", esc((r.director || []).join(", ") || "—")),
      fact(r.media === "tv" ? "His episodes" : "Released", r.media === "tv" ? (r.episodes ? `${r.episodes}${r.show_episodes ? " of " + r.show_episodes : ""} (${yearLabel(r)})` : "—") : (r.upcoming && !r.date ? "TBA" : fmtDate(r.date))),
      fact("Runtime", r.runtime ? r.runtime + " min" + (r.media === "tv" ? " / ep" : "") : "—"),
      r.media === "movie" ? fact("Budget", fmtMoney(r.budget, false)) : "",
      r.media === "movie" ? fact("Box office", fmtMoney(r.revenue, false)) : "",
      fact("TMDB rating", r.rating ? `★ ${r.rating.toFixed(1)} <span class="muted">(${fmtInt(r.votes)} votes)</span>` : "—"),
      fact("Screen time", r.credit === "crew" ? "n/a" : fmtMinutes(r.minutes)),
      fact("Genres", esc(r.genres.join(", ") || "—")),
    ].join("");
    const poster = r.poster
      ? `<img class="poster" loading="lazy" src="${IMG}w342${esc(r.poster)}" srcset="${IMG}w185${esc(r.poster)} 185w, ${IMG}w342${esc(r.poster)} 342w" sizes="(min-width:720px) 154px, 110px" alt="Poster for ${esc(r.title)}">`
      : `<div class="poster none">No poster</div>`;
    return `<tr class="detail" id="d-${esc(r.uid)}"><td colspan="8"><div class="detail-inner">${poster}
      <div><h4>${esc(r.title)} <span class="muted" style="font-size:18px">${yearLabel(r)}</span></h4>
      <p class="overview">${esc(r.overview || "No overview available.")}</p>
      <dl class="facts">${facts}</dl>
      <div class="detail-actions">
        ${r.trailer ? `<button type="button" class="btn play" data-trailer="${esc(r.trailer)}" data-title="${esc(r.title)}"><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>Play trailer</button>` : ""}
        <a class="btn btn-ghost" href="${url}" target="_blank" rel="noopener">View on TMDB ↗</a>
      </div></div></div></td></tr>`;
  }

  function toggleRow(uid) {
    expanded = expanded === uid ? null : uid;
    renderTable();
    const tr = document.querySelector(`tr.row[data-uid="${CSS.escape(uid)}"]`);
    if (tr) tr.focus({ preventScroll: true });
  }

  function openDetail(uid) {
    const rows = sortRows(VIEW);
    const idx = rows.findIndex((r) => r.uid === uid);
    if (idx < 0) return;
    if (idx >= shown) shown = Math.ceil((idx + 1) / PAGE) * PAGE;
    expanded = uid; renderTable();
    const tr = document.querySelector(`tr.row[data-uid="${CSS.escape(uid)}"]`);
    if (tr) { tr.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" }); tr.focus({ preventScroll: true }); }
  }

  function bindTable() {
    const body = $("#credits-body");
    body.addEventListener("click", (e) => { const tr = e.target.closest("tr.row"); if (tr) toggleRow(tr.dataset.uid); });
    body.addEventListener("keydown", (e) => {
      const tr = e.target.closest("tr.row"); if (!tr) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRow(tr.dataset.uid); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const all = [...body.querySelectorAll("tr.row")]; const i = all.indexOf(tr);
        const next = all[i + (e.key === "ArrowDown" ? 1 : -1)]; if (next) next.focus();
      }
    });
    document.querySelectorAll(".credits th").forEach((th) => {
      th.tabIndex = 0;
      const go = () => {
        const k = th.dataset.sort;
        if (sortKey === k) sortDir = sortDir === "asc" ? "desc" : "asc";
        else { sortKey = k; sortDir = ["title", "media", "role_type", "character"].includes(k) ? "asc" : "desc"; }
        $("#sort-select").value = `${sortKey}:${sortDir}`;
        writeURL(); renderTable();
      };
      th.addEventListener("click", go);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
    $("#sort-select").addEventListener("change", (e) => { [sortKey, sortDir] = e.target.value.split(":"); writeURL(); renderTable(); });
    $("#show-more").addEventListener("click", () => {
      const first = shown; shown += PAGE; renderTable();
      const next = document.querySelectorAll("#credits-body tr.row")[first]; if (next) next.focus();
    });
    body.addEventListener("click", (e) => { const b = e.target.closest("button[data-trailer]"); if (b) openTrailer(b.dataset.trailer, b.dataset.title, b); });
    $("#tops").addEventListener("click", (e) => { const b = e.target.closest("button[data-uid]"); if (b) openDetail(b.dataset.uid); });
  }

  // ------------------------------------------------------------------ news
  function renderNews(news) {
    const items = (news.items || []).slice(0, 20);
    $("#news").innerHTML = items.length ? items.map((n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">
        <span class="h">${esc(n.title)}</span><span class="m"><b>${esc(n.source || "News")}</b> · <time datetime="${esc(n.date)}">${ago(n.date)}</time></span></a></li>`).join("")
      : `<li class="muted">No recent headlines.</li>`;
  }

  // ------------------------------------------------------------------ trailer player
  let trailerOpener = null;
  function openTrailer(key, title, opener) {
    const dlg = $("#trailer");
    trailerOpener = opener;
    $("#trailer-title").textContent = title + " — trailer";
    $("#trailer-frame").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?autoplay=1&rel=0&modestbranding=1"
      title="${esc(title)} trailer" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
    $("#trailer-yt").href = "https://www.youtube.com/watch?v=" + encodeURIComponent(key);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    document.body.classList.add("modal-open");
  }
  function closeTrailer() {
    const dlg = $("#trailer");
    $("#trailer-frame").innerHTML = "";          // stops the video
    if (dlg.open) dlg.close();
    document.body.classList.remove("modal-open");
    if (trailerOpener) trailerOpener.focus();
  }
  function bindTrailer() {
    const dlg = $("#trailer");
    $("#trailer-close").addEventListener("click", closeTrailer);
    dlg.addEventListener("close", () => { if ($("#trailer-frame").innerHTML) closeTrailer(); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeTrailer(); });  // click outside the player
  }

  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    const [credits, meta, news, screenCSV, overCSV] = await Promise.all([
      getJSON("data/credits.json", { credits: [] }), getJSON("data/meta.json", {}), getJSON("data/news.json", { items: [] }),
      getText("data/screentime.csv"), getText("data/overrides.csv"),
    ]);
    $("#last-updated").textContent = meta.last_updated ? fmtDate(meta.last_updated) : "—";
    if (meta.last_updated) $("#last-updated").setAttribute("datetime", meta.last_updated);
    renderNews(news);
    const prof = credits.person && credits.person.profile_path;
    if (prof) {
      const img = new Image();
      img.onload = () => { const el = $("#portrait"); el.style.backgroundImage = `url("${img.src}")`; el.classList.add("loaded"); };
      img.src = IMG + "h632" + prof;
    }

    ALL = prepare(credits.credits || [], parseCSV(screenCSV), parseCSV(overCSV));
    const years = ALL.map((r) => r.year).filter(Boolean);
    const budgets = ALL.map((r) => r.budget || 0);
    BOUNDS = { y0: Math.min(...years), y1: Math.max(...years), b1: Math.max(50, Math.ceil(Math.max(...budgets) / 1e6 / 10) * 10) };
    state.y0 = BOUNDS.y0; state.y1 = BOUNDS.y1; state.b1 = BOUNDS.b1;
    readURL();
    state.y0 = Math.max(BOUNDS.y0, Math.min(state.y0, BOUNDS.y1)); state.y1 = Math.min(BOUNDS.y1, Math.max(state.y1, state.y0));
    state.b1 = Math.min(state.b1, BOUNDS.b1);

    buildFilters(); bindTable(); bindTrailer(); update();

    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 120); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
