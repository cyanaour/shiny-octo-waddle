# Liam Neeson Tracker

An unofficial fan website that tracks Liam Neeson's film and TV career as an interactive infographic.

**Live site:** https://cyanaour.github.io/shiny-octo-waddle/

It costs nothing to run. GitHub hosts the website (GitHub Pages) and runs the nightly update (GitHub Actions). The film data comes from the free TMDB API.

---

## How it updates itself

Every night at about 03:17 UTC, GitHub runs the workflow **"Update data and publish site"**. It:

1. Asks TMDB for all of Liam Neeson's film and TV credits (acting and producing).
2. Downloads details (budget, box office, director, poster and so on) only for **new** titles. Every Sunday it re-downloads everything in case TMDB corrected something. Unreleased films are re-checked every night.
3. Sorts each credit into a role type: Lead, Supporting, Cameo / small role, Voice role, Narrator, Himself or Crew.
4. Adds any new titles to `data/screentime.csv`, with the minutes left blank.
5. Fetches the latest 20 Liam Neeson headlines from Google News. It drops duplicates and anything older than 60 days.
6. Saves the results in the `data/` folder and **commits only if something changed**. Then it republishes the website.

Your TMDB key is stored as a GitHub Secret called `TMDB_TOKEN`. It is never part of the website.

## Run the update by hand

1. Open the repository on GitHub and click the **Actions** tab.
2. In the left-hand list, click **Update data and publish site**.
3. Click the grey **Run workflow** button on the right, then the green **Run workflow** button.
   - To re-download every title, tick **"Re-download details for every title"** first.
4. Wait about a minute. A green tick means it worked; a red cross means it failed (click it to see why).

## Add screen time (minutes on screen)

No website provides screen time, so you type it in. Each row of `data/screentime.csv` is one title:

```
tmdb_id,title,year,type,screentime_minutes
8681,Taken,2008,movie,61
```

Fill in the **last column** only, as a whole number of minutes. Leave it empty if you don't know. The website shows "—" for blanks, and every total says "X of Y titles recorded". The nightly update only **adds** new rows. It never changes a row you've edited.

**Option A: in your web browser (easiest)**
1. On GitHub, open the `data` folder, then click `screentime.csv`.
2. Click the **pencil icon** (Edit this file) at the top right of the file.
3. Find the title (press Ctrl+F / Cmd+F), click at the end of its line after the last comma, and type the minutes, e.g. `,movie,` becomes `,movie,61`.
4. Click the green **Commit changes…** button, then **Commit changes** again.
5. The site updates by itself within 1–2 minutes.

**Option B: in Excel**
1. On GitHub, open `data/screentime.csv` and click the **Download raw file** icon (the downward arrow).
2. Open it in Excel and type minutes in the `screentime_minutes` column. Don't change the other columns.
3. Click **File → Save As** and choose **CSV UTF-8 (Comma delimited) (*.csv)**. Keep the name `screentime.csv`. Don't save it as .xlsx.
4. On GitHub, open the `data` folder and click **Add file → Upload files**. Drag your file in, then click **Commit changes**. It replaces the old one.

Tip: Excel may show an ID such as `1234567` as `1.23E+06`. That's only how it's displayed, and the saved file is fine.

## Fix wrong data (overrides)

If TMDB has something wrong, such as a missing budget or a role you'd classify differently, add a line to `data/overrides.csv` the same way as above. Don't change the code. Each line fixes one field of one title:

```
tmdb_id,type,field,value,note
8681,movie,budget,25000000,Studio figure
424,movie,role_type,Lead,
12345,tv,episodes,6,
99999,movie,hide,yes,Not really his film
```

- **tmdb_id**: the number in the title's TMDB address. For example, themoviedb.org/movie/**8681**-taken is 8681. Every title on the site has a "View on TMDB" link.
- **type**: `movie` or `tv`.
- **field**: one of `role_type`, `budget`, `revenue`, `rating`, `runtime`, `year`, `title`, `character`, `director`, `genres` (separate several with `;`), `episodes`, `upcoming` (yes/no) or `hide` (yes removes the title from the site).
- **role_type values**: `Lead`, `Supporting`, `Cameo / small role`, `Voice role`, `Narrator`, `Himself`, `Crew`.
- **value**: the correct value. Money is in US dollars; commas are fine if the value is in quotes, e.g. `"25,000,000"`.

Overrides apply as soon as the site republishes, 1–2 minutes after you commit.

## How roles are classified

| Role | Rule |
|---|---|
| Narrator | character name contains "narrator" |
| Himself | character is "Self", "Himself" or "Liam Neeson", or blank on a talk/news/reality/documentary title |
| Voice role | character name contains "voice" |
| Cameo / small role | marked "uncredited" or "archive footage"; films billed 11th or lower; TV with 1–2 episodes |
| Lead | films billed 1st–3rd; TV shows where he's in at least half the episodes |
| Supporting | everything else |
| Crew | producer, executive producer, etc. |

"Himself" appearances are hidden by default. Switch them on with the toggle in the filters.

## If the nightly update ever stops

GitHub pauses scheduled workflows in a repository with no activity for 60 days. The nightly news commits normally keep it active. As a safety net, the workflow writes a small `data/keepalive.txt` file if 45 days pass without a commit. If it is ever paused anyway:

1. Go to the **Actions** tab and click **Update data and publish site**.
2. You'll see a yellow banner saying the workflow was disabled. Click **Enable workflow**.
3. Click **Run workflow** (see above) to update straight away.

GitHub emails the repository owner when a run fails, so you will hear about problems.

## Files

| File | What it is |
|---|---|
| `index.html`, `assets/` | The website (plain HTML, CSS, JavaScript; charts by Apache ECharts) |
| `scripts/update_data.py` | The nightly data script (Python, no extra installs) |
| `.github/workflows/update.yml` | The nightly / manual GitHub Actions workflow |
| `data/credits.json` | Generated: every credit, already classified |
| `data/news.json`, `data/meta.json` | Generated: headlines and "last updated" info |
| `data/cache/tmdb_details.json` | Generated: saved TMDB details, so each night only new titles are fetched |
| `data/screentime.csv` | **You edit**: minutes on screen |
| `data/overrides.csv` | **You edit**: corrections |

To run the script on your own computer (optional): `TMDB_TOKEN=your_token python3 scripts/update_data.py`. Add `--full` to refresh everything. To preview the site, run `python3 -m http.server` and open http://localhost:8000.

---

This website uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB. Unofficial fan site, not affiliated with Liam Neeson or TMDB. Headlines via Google News; links go to the original publishers.
