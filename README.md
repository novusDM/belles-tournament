# NCS 10U Texas Blowout — Live Tournament Tracker

A self-contained tracker for the NCS *10U Texas Blowout on Turf* (10U Open).
Fans of any team can follow schedules, scores, standings, eliminations, and the
live bracket. Nothing to configure — push to Netlify and it works.

## How it works

```
  ┌─ scrape-tournament.mjs (runs every 30 min on Netlify cron)
  │     scrapes NCS with cheerio → writes JSON to Netlify Blobs
  │
  ├─ get-tournament.mjs (public read endpoint)
  │     serves the cached JSON; scrapes once inline if cache is cold/stale
  │
  └─ index.html (the page everyone opens)
        reads /api/tournament, re-checks every 2 min, no keys in the browser
```

- **No API keys.** NCS pages are parsed directly with cheerio — no LLM, no cost.
- **One shared cache.** Every viewer reads the same Blobs-stored snapshot, so a
  hundred parents open the page and NCS still only gets hit once per 30 min.
- **Truly automatic.** The scheduled function runs server-side whether or not
  anyone has the page open.

## Deploy

1. Push this folder to a GitHub repo.
2. In Netlify: **Add new site → Import from Git**, pick the repo.
3. Leave build command empty; publish directory is `.`. Deploy.

That's it. Netlify auto-installs the dependencies, registers the scheduled
function, and enables Blobs. The first visit triggers an inline scrape so you
don't have to wait for the first cron tick.

Drop it on a subdomain like `tourney.belles.team` via Netlify domain settings.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The tracker UI (schedule / standings / bracket tabs) |
| `lib/scrape.mjs` | Fetch + cheerio parsing for all three NCS pages |
| `netlify/functions/scrape-tournament.mjs` | Scheduled 30-min cache refresher |
| `netlify/functions/get-tournament.mjs` | Public read endpoint with cold-start fallback |
| `netlify.toml` | Functions config + `/api/tournament` redirect |

## Adapting to another event

Change the `EVENT` and `DIVISION` constants at the top of `lib/scrape.mjs`.
Everything else is generic.

## A couple of notes

- **Score detection is verified** against a completed NCS event. NCS prefixes
  each team cell with that team's score once a game is final (e.g. "4  Athletics
  Mercado" / "8  2033 Texas Glory") and also puts the pair in the middle cell
  ("4 - 8"); the parser reads both. Team names with leading years like "2033
  Texas Glory" are preserved correctly.
- **Bracket structure is real and live.** It parses NCS's printable bracket
  (Diamond seeds 1–16, Gold 17–32, Silver 33+), each with a winners side and an
  elimination side, including every game's date, time, field, and the
  Winner-of/Loser-of progression. Seed slots show as "Seed N" until pool play
  sets the final standings; the moment NCS assigns seeds (populates the rank
  column on the standings page), seed N auto-resolves to the team ranked N.
  Scores are merged in from the regular bracket page by bracket + game number
  as games complete.
- **"Eliminated"** is computed best-effort from the elimination brackets: a team
  is flagged out once it loses a final bracket game and appears in no remaining
  game. Double-elim edge cases may lag by a game.
