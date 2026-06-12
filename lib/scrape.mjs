// Shared scraping + parsing logic for the NCS 10U Texas Blowout tracker.
// Imported by both the scheduled function (writes the cache) and the
// get-tournament function (reads the cache, falls back to a live scrape).
//
// NCS renders plain HTML tables, so we parse them with cheerio. No API key,
// no LLM, no per-request cost. If NCS changes their markup, the selectors in
// here are the only thing that needs adjusting.

import * as cheerio from 'cheerio';

const EVENT = '11618/10u-texas-blowout-on-turf';
const DIVISION = '10U%20OPEN';
const BASE = 'https://playncs.com/fastpitch/Events';

export const URLS = {
  schedule:  `${BASE}/Schedule/${EVENT}?division=${DIVISION}`,
  standings: `${BASE}/Standings/${EVENT}?division=${DIVISION}`,
  bracket:   `${BASE}/Bracket/${EVENT}?division=${DIVISION}`,
};

// Fetch a page as HTML with a browser-like UA (some hosts 403 a bare fetch).
async function getHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`NCS ${url} returned ${res.status}`);
  return res.text();
}

// --- helpers -------------------------------------------------------------

// Pull a score pair out of a cell. NCS puts the score in the middle "vs"
// cell once a game is final, usually like "7 - 2" or "7-2". Returns
// [s1, s2] as integers, or null if no score is present.
function parseScorePair(text) {
  if (!text) return null;
  const m = text.replace(/\u2013|\u2014/g, '-').match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

// NCS prefixes each team cell with that team's score once a game is final,
// e.g. "4  Athletics Mercado..." and "8  2033 Texas Glory". Strip a leading
// 1-2 digit score (a space must follow) and return { name, score }. The
// "1-2 digit + space" rule avoids eating year-style team names like
// "2033 Texas Glory" or "1516 Texas Glory".
function splitTeamCell(text) {
  if (!text) return { name: '', score: null };
  let clean = text.replace(/\s+/g, ' ').trim();
  let score = null;
  const lead = clean.match(/^(\d{1,2})\s+(.*)$/);
  if (lead) {
    score = parseInt(lead[1], 10);
    clean = lead[2].trim();
  }
  return { name: clean, score };
}

// "1 Game 7   Fri 9:00 AM" -> { gameNum, date, time }
function parseGameCell(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const numMatch = clean.match(/Game\s+(\d+)/i);
  const gameNum = numMatch ? numMatch[1] : (clean.match(/^(\d+)/) || [])[1] || '';
  const dayMatch = clean.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/);
  const timeMatch = clean.match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
  return {
    gameNum,
    date: dayMatch ? dayMatch[1] : '',
    time: timeMatch ? timeMatch[1].toUpperCase().replace(/\s+/, ' ') : '',
  };
}

// NCS field names duplicate the venue, e.g.
//   "Bob Jones Softball Complex Turf 6 BJSC 6"  -> "BJSC 6"
//   "Southwest Park Field 1 Southwest Park Field 1" -> "Field 1"
// Prefer a trailing abbreviation+number; fall back to "Field N".
function shortField(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const abbr = clean.match(/\b([A-Z]{3,5})\s*(\d+)\b\s*$/);
  if (abbr) return `${abbr[1]} ${abbr[2]}`;
  const field = clean.match(/Field\s+(\d+)/i);
  if (field) return `Field ${field[1]}`;
  return clean.split(' ').slice(0, 3).join(' ');
}

function statusFromScore(s1, s2) {
  return (s1 != null && s2 != null) ? 'final' : 'upcoming';
}

// Parse one schedule/bracket-style table into game objects. NCS rows are:
// [ game | date/time | field | team1 | vs/score | team2 ].
function parseGameTable($, $table) {
  const games = [];
  $table.find('tbody tr, tr').each((_, tr) => {
    const $cells = $(tr).find('td');
    if ($cells.length < 5) return; // header / spacer rows

    const cellText = (i) => $($cells[i]).text().replace(/\s+/g, ' ').trim();
    const { gameNum, date, time } = parseGameCell(cellText(0));
    if (!gameNum) return;

    const field = shortField(cellText(2));

    // Teams are the last two link/text cells; the cell between them holds
    // the score when final. Handle both 6-col and score-appended layouts.
    const t1 = splitTeamCell(cellText(3));
    const middle = $cells.length >= 6 ? cellText(4) : '';
    const t2 = splitTeamCell(cellText($cells.length >= 6 ? 5 : 4));

    let s1 = t1.score, s2 = t2.score;
    const mid = parseScorePair(middle);
    if (mid) { s1 = mid[0]; s2 = mid[1]; }

    games.push({
      gameNum,
      date,
      time,
      field,
      team1: t1.name || 'TBD',
      team2: t2.name || 'TBD',
      score1: s1 ?? null,
      score2: s2 ?? null,
      status: statusFromScore(s1, s2),
    });
  });
  return games;
}

// --- public parsers ------------------------------------------------------

export async function scrapeSchedule() {
  const html = await getHtml(URLS.schedule);
  const $ = cheerio.load(html);
  // The schedule table is the main table on the page with a Game header.
  let games = [];
  $('table').each((_, t) => {
    const head = $(t).find('th').text().toLowerCase();
    if (head.includes('game') && head.includes('team')) {
      games = games.concat(parseGameTable($, $(t)));
    }
  });
  return { games };
}

export async function scrapeStandings() {
  const html = await getHtml(URLS.standings);
  const $ = cheerio.load(html);
  const pools = [];

  $('table').each((_, t) => {
    const head = $(t).find('th').text().toLowerCase();
    if (!head.includes('team') || !head.includes('pts')) return;

    // Pool name: a nearby heading, but skip NCS's own page headings like
    // "10U OPEN Standings" — those aren't real pool names.
    let poolName = '';
    const prevHead = $(t).prevAll('h3,h4,h5').first().text().replace(/\s+/g, ' ').trim();
    if (prevHead && prevHead.length < 30 && !/standings|division|bracket|schedule/i.test(prevHead)) {
      poolName = prevHead;
    }

    const teams = [];
    $(t).find('tbody tr, tr').each((__, tr) => {
      const $cells = $(tr).find('td');
      if ($cells.length < 6) return;
      const txt = (i) => $($cells[i]).text().replace(/\s+/g, ' ').trim();

      const rankRaw = txt(0);
      const name = txt(1);
      if (!name) return;

      // W-L-T comes as "2-1-0". Columns after: RA, RD, RS, PTS.
      const wlt = (txt(2).match(/(\d+)-(\d+)-(\d+)/) || []);
      const nums = $cells.slice(3).map((_, c) => $(c).text().trim()).get();
      const toInt = (v) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return isNaN(n) ? 0 : n; };

      teams.push({
        rank: toInt(rankRaw) || (teams.length + 1),
        name,
        w: toInt(wlt[1]), l: toInt(wlt[2]), t: toInt(wlt[3]),
        ra: toInt(nums[0]),          // runs allowed
        rs: toInt(nums[2] ?? nums[0]), // runs scored
        pts: toInt(nums[nums.length - 1]),
        eliminated: false, // filled in later from bracket results
      });
    });

    if (teams.length) pools.push({ poolName: poolName || 'Overall standings', teams });
  });

  return { pools };
}

// Bracket page has one or more named sections, each introduced by a heading
// directly followed by a games table. Bracket names vary by event ("Diamond",
// "Gold", "Silver", "10U Elite", etc.), so we don't match a fixed list — we
// take any heading whose next table looks like a games table.
export async function scrapeBracket() {
  const html = await getHtml(URLS.bracket);
  const $ = cheerio.load(html);
  const brackets = [];

  $('h3, h4, h5').each((_, h) => {
    const raw = $(h).text().replace(/\s+/g, ' ').trim();
    if (!raw) return;

    // Skip the page's nav/section headings that aren't bracket titles.
    if (/^(schedule|standings|bracket|event|tournament|select division)/i.test(raw)) return;

    // The bracket title is the leading text before any print-link URL.
    const name = raw.split(/\s*\//)[0].split('[')[0].trim();
    if (!name || name.length > 40) return;

    const $table = $(h).nextAll('table').first();
    if (!$table.length) return;
    const head = $table.find('th').text().toLowerCase();
    if (!head.includes('game') || !head.includes('team')) return;

    const games = parseGameTable($, $table).map((g) => ({ ...g, round: roundLabel(g) }));
    if (games.length) brackets.push({ name, games });
  });

  return { brackets };
}

// Best-effort round labeling from a game's matchup text.
function roundLabel(g) {
  const a = `${g.team1} ${g.team2}`.toLowerCase();
  if (a.includes('seed')) return 'Round of 16';
  if (a.includes('loser')) return 'Elimination';
  // Winner-of-winner games progress; we can't perfectly name them without
  // the full tree, so group the rest under Championship bracket.
  return 'Championship bracket';
}

// Best-effort elimination flag: a team is "out" if it lost a final
// elimination-bracket game and appears in no later non-final game.
function applyElimination(standings, bracketData) {
  const allBracketGames = (bracketData.brackets || []).flatMap((b) => b.games || []);
  const lostFinal = new Set();
  const stillPlaying = new Set();

  for (const g of allBracketGames) {
    if (g.status === 'final' && g.score1 != null && g.score2 != null) {
      const loser = g.score1 < g.score2 ? g.team1 : g.team2;
      if (loser && !/^(seed|winner|loser)/i.test(loser)) lostFinal.add(loser);
    } else {
      // unplayed game: both named teams are still alive
      [g.team1, g.team2].forEach((tm) => {
        if (tm && !/^(seed|winner|loser)/i.test(tm)) stillPlaying.add(tm);
      });
    }
  }

  for (const pool of standings.pools || []) {
    for (const team of pool.teams || []) {
      if (lostFinal.has(team.name) && !stillPlaying.has(team.name)) {
        team.eliminated = true;
      }
    }
  }
  return standings;
}

// One call that gathers everything and returns the full cache payload.
export async function scrapeAll() {
  const [schedule, standings, bracket] = await Promise.all([
    scrapeSchedule().catch((e) => ({ games: [], error: e.message })),
    scrapeStandings().catch((e) => ({ pools: [], error: e.message })),
    scrapeBracket().catch((e) => ({ brackets: [], error: e.message })),
  ]);

  applyElimination(standings, bracket);

  return {
    schedule,
    standings,
    bracket,
    fetchedAt: Date.now(),
  };
}
