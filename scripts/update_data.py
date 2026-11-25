#!/usr/bin/env python3
"""
Liam Neeson Tracker - nightly data updater.

What it does, in order:
  1. Confirms Liam Neeson's TMDB person ID with the search endpoint.
  2. Downloads his combined film + TV credits (acting and crew).
  3. Fetches extra details for each title (budget, box office, director...),
     using a cache so a normal night only fetches NEW titles. Once a week
     (Sunday, or with --full) every title is refreshed.
  4. Classifies every credit (Lead, Supporting, Voice role, Himself...).
  5. Writes data/credits.json and adds any new titles to data/screentime.csv
     (never touching minutes you've already typed in).
  6. Fetches the latest Liam Neeson headlines from Google News -> data/news.json.
  7. Updates data/meta.json, but only if something actually changed.

Only uses the Python standard library - nothing to install.

Usage:
  TMDB_TOKEN=xxxx python3 scripts/update_data.py          # normal run
  TMDB_TOKEN=xxxx python3 scripts/update_data.py --full   # refresh everything
  python3 scripts/update_data.py --news-only              # just the news
"""

import csv
import datetime as dt
import email.utils
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE_FILE = os.path.join(DATA, "cache", "tmdb_details.json")
CREDITS_FILE = os.path.join(DATA, "credits.json")
NEWS_FILE = os.path.join(DATA, "news.json")
META_FILE = os.path.join(DATA, "meta.json")
SCREENTIME_FILE = os.path.join(DATA, "screentime.csv")
OVERRIDES_FILE = os.path.join(DATA, "overrides.csv")

API = "https://api.themoviedb.org/3"
EXPECTED_PERSON_ID = 3896
PERSON_NAME = "Liam Neeson"
NEWS_URL = ("https://news.google.com/rss/search?q=%22Liam+Neeson%22"
            "&hl=en-IE&gl=IE&ceid=IE:en")
NEWS_MAX_ITEMS = 20
NEWS_MAX_AGE_DAYS = 60

REQUEST_GAP_SECONDS = 0.06  # ~16 requests/second, well under TMDB's limit
USER_AGENT = "LiamNeesonTracker/1.0 (unofficial fan site; GitHub Actions)"

SCREENTIME_HEADER = ["tmdb_id", "title", "year", "type", "screentime_minutes"]
OVERRIDES_HEADER = ["tmdb_id", "type", "field", "value", "note"]

TODAY = dt.date.today()


def log(*args):
    print(*args, flush=True)


# --------------------------------------------------------------------------
# TMDB access
# --------------------------------------------------------------------------
class TMDB:
    def __init__(self, token):
        self.token = token.strip()
        # A "Read Access Token" is long and starts with "eyJ"; a short
        # "API Key" goes in the URL instead. Both are supported.
        self.bearer = self.token.startswith("eyJ") or len(self.token) > 40
        self.last_call = 0.0
        self.calls = 0

    def get(self, path, **params):
        if not self.bearer:
            params["api_key"] = self.token
        url = API + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        if self.bearer:
            headers["Authorization"] = "Bearer " + self.token
        for attempt in range(6):
            wait = REQUEST_GAP_SECONDS - (time.time() - self.last_call)
            if wait > 0:
                time.sleep(wait)
            self.last_call = time.time()
            self.calls += 1
            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 429:  # rate limited: wait as told, then retry
                    delay = int(e.headers.get("Retry-After") or 2) + 1
                    log(f"  rate limited, waiting {delay}s")
                    time.sleep(delay)
                    continue
                if e.code == 404:
                    return None
                if e.code in (401, 403):
                    sys.exit("TMDB rejected the API key/token (HTTP %s). "
                             "Check the TMDB_TOKEN secret." % e.code)
                if e.code >= 500:
                    time.sleep(2 ** attempt)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError) as e:
                log(f"  network error ({e}), retrying")
                time.sleep(2 ** attempt)
        raise RuntimeError("TMDB request kept failing: " + path)


def confirm_person_id(tmdb):
    res = tmdb.get("/search/person", query=PERSON_NAME) or {}
    matches = [r for r in res.get("results", [])
               if r.get("name", "").lower() == PERSON_NAME.lower()]
    if not matches:
        log(f"WARNING: search found no exact match; using {EXPECTED_PERSON_ID}")
        return EXPECTED_PERSON_ID, None
    best = max(matches, key=lambda r: r.get("popularity", 0))
    if best["id"] != EXPECTED_PERSON_ID:
        log(f"WARNING: search returned ID {best['id']}, expected "
            f"{EXPECTED_PERSON_ID}. Using {best['id']}.")
    else:
        log(f"Confirmed: {PERSON_NAME} is TMDB person {best['id']}")
    return best["id"], best.get("profile_path")


# --------------------------------------------------------------------------
# Title details (cached)
# --------------------------------------------------------------------------
def slim_movie(d):
    crew = (d.get("credits") or {}).get("crew", [])
    return {
        "title": d.get("title"),
        "status": d.get("status"),
        "release_date": d.get("release_date") or None,
        "genres": [g["name"] for g in d.get("genres", [])],
        "runtime": d.get("runtime") or None,
        "budget": d.get("budget") or None,
        "revenue": d.get("revenue") or None,
        "vote_average": d.get("vote_average") or None,
        "vote_count": d.get("vote_count") or 0,
        "directors": [c["name"] for c in crew if c.get("job") == "Director"],
        "poster_path": d.get("poster_path"),
        "overview": d.get("overview") or "",
        "imdb_id": d.get("imdb_id"),
    }


def slim_tv(d):
    runtimes = d.get("episode_run_time") or []
    return {
        "title": d.get("name"),
        "status": d.get("status"),
        "first_air_date": d.get("first_air_date") or None,
        "last_air_date": d.get("last_air_date") or None,
        "genres": [g["name"] for g in d.get("genres", [])],
        "runtime": runtimes[0] if runtimes else None,
        "number_of_episodes": d.get("number_of_episodes") or None,
        "vote_average": d.get("vote_average") or None,
        "vote_count": d.get("vote_count") or 0,
        "creators": [c["name"] for c in d.get("created_by", [])],
        "poster_path": d.get("poster_path"),
        "overview": d.get("overview") or "",
    }


def slim_tv_credit(d):
    """Which episodes/years Liam appears in, from /credit/{credit_id}."""
    media = (d or {}).get("media") or {}
    dates = [e.get("air_date") for e in media.get("episodes", []) if e.get("air_date")]
    if not dates:
        dates = [s.get("air_date") for s in media.get("seasons", []) if s.get("air_date")]
    dates.sort()
    return {"first": dates[0] if dates else None,
            "last": dates[-1] if dates else None,
            "episodes_listed": len(media.get("episodes", []))}


UNRELEASED = {"Rumored", "Planned", "In Production", "Post Production"}


def is_upcoming_movie(det):
    date = det.get("release_date")
    if det.get("status") in UNRELEASED:
        return True
    if not date:
        return det.get("status") != "Released"
    return date > TODAY.isoformat()


def load_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def fetch_details(tmdb, cache, titles, tv_credit_ids, full_refresh):
    """titles: set of (media, id). tv_credit_ids: credit ids for TV cast."""
    fetched = 0
    for media, tid in sorted(titles):
        key = f"{media}:{tid}"
        cached = cache.get(key)
        stale = cached is None or full_refresh
        # Upcoming films change often (dates, budgets) - re-check them nightly.
        if cached and media == "movie" and is_upcoming_movie(cached):
            stale = True
        if cached and media == "tv" and cached.get("status") in (
                "In Production", "Planned", "Returning Series", "Pilot"):
            stale = stale or not cached.get("first_air_date")
        if not stale:
            continue
        if media == "movie":
            d = tmdb.get(f"/movie/{tid}", append_to_response="credits")
            if d:
                cache[key] = slim_movie(d)
        else:
            d = tmdb.get(f"/tv/{tid}")
            if d:
                cache[key] = slim_tv(d)
        fetched += 1
        if fetched % 25 == 0:
            log(f"  fetched {fetched} titles...")
    for cid in sorted(tv_credit_ids):
        key = f"credit:{cid}"
        if key in cache and not full_refresh and cache[key].get("first"):
            continue
        cache[key] = slim_tv_credit(tmdb.get(f"/credit/{cid}"))
        fetched += 1
    log(f"Fetched details for {fetched} titles/credits "
        f"({'full weekly refresh' if full_refresh else 'new or upcoming only'})")
    # Forget titles he is no longer credited on.
    wanted = {f"{m}:{i}" for m, i in titles} | {f"credit:{c}" for c in tv_credit_ids}
    for k in list(cache):
        if k not in wanted:
            del cache[k]


# --------------------------------------------------------------------------
# Role classification
# --------------------------------------------------------------------------
HIMSELF_RE = re.compile(r"^\s*(him)?self\b|\bhimself\b|^\s*liam neeson\s*$", re.I)
TALK_GENRES = {"Talk", "News", "Reality", "Documentary"}


def classify(media, character, order, episode_count, total_episodes, genres):
    ch = (character or "").strip()
    low = ch.lower()
    if "narrator" in low:
        return "Narrator"
    if HIMSELF_RE.search(ch):
        return "Himself"
    if not ch and set(genres) & TALK_GENRES:
        return "Himself"
    if "voice" in low:
        return "Voice role"
    if "uncredited" in low or "archive footage" in low:
        return "Cameo / small role"
    if media == "movie":
        if order is None:
            return "Supporting"
        if order <= 2:
            return "Lead"
        if order <= 9:
            return "Supporting"
        return "Cameo / small role"
    # TV: judge by how many of the show's episodes he's in.
    eps = episode_count or 0
    total = total_episodes or 0
    if total and eps / total >= 0.5 and (total <= 6 or eps >= 3):
        return "Lead"
    if eps >= 3:
        return "Supporting"
    return "Cameo / small role"


# --------------------------------------------------------------------------
# Build the credits list
# --------------------------------------------------------------------------
def year_of(date):
    return int(date[:4]) if date and len(date) >= 4 and date[:4].isdigit() else None


def build_credits(raw, cache):
    """Merge raw combined_credits into one row per title per credit kind."""
    rows = {}
    for kind in ("cast", "crew"):
        for c in raw.get(kind, []):
            media = c.get("media_type")
            if media not in ("movie", "tv") or c.get("adult"):
                continue
            key = f"{media}:{c['id']}:{kind}"
            row = rows.get(key)
            if row is None:
                row = rows[key] = {"media": media, "id": c["id"], "credit": kind,
                                   "characters": [], "jobs": [], "order": None,
                                   "episode_count": 0, "credit_ids": [],
                                   "fallback": c}
            if kind == "cast":
                ch = (c.get("character") or "").strip()
                if ch and ch not in row["characters"]:
                    row["characters"].append(ch)
                if c.get("order") is not None:
                    row["order"] = c["order"] if row["order"] is None else min(row["order"], c["order"])
            else:
                if c.get("job") and c["job"] not in row["jobs"]:
                    row["jobs"].append(c["job"])
            row["episode_count"] += c.get("episode_count") or 0
            row["credit_ids"].append(c["credit_id"])

    out = []
    for r in rows.values():
        media, tid = r["media"], r["id"]
        det = cache.get(f"{media}:{tid}") or {}
        if media == "movie" and det.get("status") == "Canceled":
            log(f"  skipping cancelled project: {det.get('title')}")
            continue
        if media == "tv" and det.get("number_of_episodes"):
            # The same role is sometimes listed twice; never exceed the show's total.
            r["episode_count"] = min(r["episode_count"], det["number_of_episodes"])
        fb = r["fallback"]
        genres = det.get("genres") or []
        character = " / ".join(r["characters"])
        item = {
            "key": f"{media}:{tid}",
            "id": tid,
            "media": media,
            "credit": r["credit"],
            "title": det.get("title") or fb.get("title") or fb.get("name"),
            "character": character if r["credit"] == "cast" else None,
            "jobs": r["jobs"] or None,
            "order": r["order"],
            "genres": genres,
            "rating": round(det["vote_average"], 2) if det.get("vote_average") else None,
            "votes": det.get("vote_count") or 0,
            "poster": det.get("poster_path") or fb.get("poster_path"),
            "overview": det.get("overview") or fb.get("overview") or "",
            "runtime": det.get("runtime"),
        }
        if media == "movie":
            date = det.get("release_date") or fb.get("release_date") or None
            item.update({
                "date": date,
                "year": year_of(date),
                "budget": det.get("budget"),
                "revenue": det.get("revenue"),
                "director": det.get("directors") or None,
                "upcoming": is_upcoming_movie(det) if det else (not date or date > TODAY.isoformat()),
                "status": det.get("status"),
            })
            total_eps = None
        else:
            first = last = None
            for cid in r["credit_ids"]:
                cr = cache.get(f"credit:{cid}") or {}
                if cr.get("first") and (first is None or cr["first"] < first):
                    first = cr["first"]
                if cr.get("last") and (last is None or cr["last"] > last):
                    last = cr["last"]
            first = first or fb.get("first_credit_air_date") or det.get("first_air_date") or fb.get("first_air_date")
            last = last or first
            total_eps = det.get("number_of_episodes")
            item.update({
                "date": first,
                "year": year_of(first),
                "year_end": year_of(last),
                "episodes": r["episode_count"] or None,
                "show_episodes": total_eps,
                "director": det.get("creators") or None,  # shown as "Created by"
                "upcoming": (not first) or first > TODAY.isoformat(),
                "status": det.get("status"),
            })
        if r["credit"] == "crew":
            item["role_type"] = "Crew"
        else:
            item["role_type"] = classify(media, character, r["order"], r["episode_count"],
                                         total_eps, genres)
        out.append(item)

    out.sort(key=lambda x: (x["date"] or "9999", x["title"] or "", x["credit"]))
    return out


# --------------------------------------------------------------------------
# CSV files you edit by hand
# --------------------------------------------------------------------------
def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def update_screentime_csv(credits):
    """Append new titles. Existing rows (and your minutes) are never changed."""
    existing_rows = read_csv(SCREENTIME_FILE)
    have = {((r.get("tmdb_id") or "").strip(), (r.get("type") or "").strip().lower())
            for r in existing_rows}
    new = []
    seen = set()
    for c in credits:
        if c["credit"] != "cast" or c["role_type"] == "Himself":
            continue
        k = (str(c["id"]), c["media"])
        if k in have or k in seen:
            continue
        seen.add(k)
        new.append({"tmdb_id": c["id"], "title": c["title"], "year": c["year"] or "",
                    "type": c["media"], "screentime_minutes": ""})
    if not os.path.exists(SCREENTIME_FILE):
        with open(SCREENTIME_FILE, "w", encoding="utf-8", newline="") as f:
            csv.writer(f).writerow(SCREENTIME_HEADER)
    if new:
        # Append only, so nothing you've typed is ever rewritten.
        with open(SCREENTIME_FILE, "rb") as f:
            content = f.read()
        with open(SCREENTIME_FILE, "a", encoding="utf-8", newline="") as f:
            if content and not content.endswith(b"\n"):
                f.write("\r\n" if b"\r\n" in content else "\n")
            w = csv.DictWriter(f, fieldnames=SCREENTIME_HEADER, extrasaction="ignore")
            w.writerows(new)
    log(f"screentime.csv: {len(existing_rows)} existing rows kept, {len(new)} new titles added")


def ensure_overrides_csv():
    if not os.path.exists(OVERRIDES_FILE):
        with open(OVERRIDES_FILE, "w", encoding="utf-8", newline="") as f:
            csv.writer(f).writerow(OVERRIDES_HEADER)


# --------------------------------------------------------------------------
# News (Google News RSS)
# --------------------------------------------------------------------------
def norm_title(t):
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


def fetch_news():
    req = urllib.request.Request(NEWS_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        root = ET.fromstring(resp.read())
    items = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        src_el = it.find("source")
        source = (src_el.text or "").strip() if src_el is not None else ""
        if source and title.endswith(" - " + source):
            title = title[: -len(" - " + source)].strip()
        try:
            when = email.utils.parsedate_to_datetime(it.findtext("pubDate"))
            when = when.astimezone(dt.timezone.utc)
        except (TypeError, ValueError):
            continue
        if title and link:
            items.append({"title": title, "source": source, "link": link,
                          "date": when.strftime("%Y-%m-%dT%H:%M:%SZ")})
    return items


def update_news():
    old = []
    if os.path.exists(NEWS_FILE):
        with open(NEWS_FILE, encoding="utf-8") as f:
            old = json.load(f).get("items", [])
    try:
        fresh = fetch_news()
    except Exception as e:  # news is a nice-to-have: never fail the whole run
        log(f"WARNING: could not fetch news ({e}); keeping previous headlines")
        fresh = []
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=NEWS_MAX_AGE_DAYS)
              ).strftime("%Y-%m-%dT%H:%M:%SZ")
    merged, seen = [], set()
    for item in sorted(fresh + old, key=lambda x: x["date"], reverse=True):
        k = norm_title(item["title"])
        if k in seen or item["link"] in seen or item["date"] < cutoff:
            continue
        seen.add(k)
        seen.add(item["link"])
        merged.append(item)
    merged = merged[:NEWS_MAX_ITEMS]
    log(f"News: {len(fresh)} fetched, {len(merged)} kept")
    return write_if_changed(NEWS_FILE, {"items": merged})


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def write_if_changed(path, obj, indent=None):
    text = json.dumps(obj, ensure_ascii=False, indent=indent, sort_keys=False)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            if f.read() == text:
                return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return True


def update_meta(credits_changed, news_changed, extra=None):
    meta = {}
    if os.path.exists(META_FILE):
        with open(META_FILE, encoding="utf-8") as f:
            meta = json.load(f)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if credits_changed:
        meta["credits_updated"] = now
    if news_changed:
        meta["news_updated"] = now
    if credits_changed or news_changed:
        meta["last_updated"] = now
    if extra:
        meta.update(extra)
    write_if_changed(META_FILE, meta, indent=2)


# --------------------------------------------------------------------------
def main():
    args = set(sys.argv[1:])
    os.makedirs(os.path.join(DATA, "cache"), exist_ok=True)
    ensure_overrides_csv()

    credits_changed = False
    extra = {}
    if "--news-only" not in args:
        token = os.environ.get("TMDB_TOKEN", "").strip()
        if not token:
            sys.exit("TMDB_TOKEN is not set. Add it as a GitHub Secret (see README).")
        full = "--full" in args or TODAY.weekday() == 6 or os.environ.get("FULL_REFRESH") == "true"
        tmdb = TMDB(token)
        person_id, profile = confirm_person_id(tmdb)
        raw = tmdb.get(f"/person/{person_id}/combined_credits")
        if not raw or not (raw.get("cast") or raw.get("crew")):
            sys.exit("TMDB returned no credits - stopping so we don't wipe the data.")
        log(f"Combined credits: {len(raw.get('cast', []))} cast, {len(raw.get('crew', []))} crew")

        titles = {(c["media_type"], c["id"]) for c in raw.get("cast", []) + raw.get("crew", [])
                  if c.get("media_type") in ("movie", "tv") and not c.get("adult")}
        tv_credit_ids = {c["credit_id"] for c in raw.get("cast", []) if c.get("media_type") == "tv"}
        cache = load_cache()
        fetch_details(tmdb, cache, titles, tv_credit_ids, full)
        write_if_changed(CACHE_FILE, dict(sorted(cache.items())), indent=0)

        credits = build_credits(raw, cache)
        payload = {"person": {"id": person_id, "name": PERSON_NAME, "profile_path": profile},
                   "credits": credits}
        credits_changed = write_if_changed(CREDITS_FILE, payload)
        update_screentime_csv(credits)
        extra = {"person_id": person_id}
        log(f"credits.json: {len(credits)} credits ({'changed' if credits_changed else 'no change'}); "
            f"{tmdb.calls} TMDB requests")

    news_changed = update_news()
    update_meta(credits_changed, news_changed, extra)
    log("Done.")


if __name__ == "__main__":
    main()
