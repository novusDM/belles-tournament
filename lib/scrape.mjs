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
  printBracket: `${BASE}/PrintBracket/${EVENT}?division=${DIVISION}`,
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
// --- bracket parsing ----------------------------------------------------
//
// The bracket lives on the printable page, which is a tree (not a table):
// three named brackets (Diamond #1-16, Gold #17-32, Silver #33+), each with a
// Winners side and an "Elimination Bracket" side. Every game block is:
//   #1 / Seed 1   <- top team (a seed slot, or "Winner/Loser of Game N")
//   Game 1 | 6/13 | 5:30 PM
//   Field 5 @ Old Celina Park
//   #16 / Seed 16 <- bottom team
// Once games are played, scores show on the regular Bracket page (a table),
// which we merge in by bracket name + game number.

const BRACKET_NAMES = ['Diamond', 'Gold', 'Silver', 'Bronze', 'Copper'];
const isAnchor = (s) => s.match(/^Game\s+(\d+)\s*\|\s*(\d+\/\d+)\s*\|\s*(\d+:\d+\s*[AP]M)$/i);
const isFieldLine = (s) => /^Field\b/i.test(s);
const isBadge = (s) => /^#\d+$/.test(s);
const isDecor = (s) => /^(If Necessary|.*Bracket Champion)$/i.test(s);
const isElimSection = (s) => /^Elimination Bracket$/i.test(s);
const isBracketName = (s) => BRACKET_NAMES.includes(s);
const isTeamLabel = (s) =>
  s && !isBadge(s) && !isAnchor(s) && !isFieldLine(s) && !isDecor(s) &&
  !isElimSection(s) && !isBracketName(s);

// Turn raw HTML into trimmed text lines, preserving block boundaries so each
// of NCS's labels lands on its own line.
function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|h[1-6]|td|tr|li|em|i|b|strong|span|a)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&nbsp;/g, ' ')
    .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export async function scrapeBracket() {
  const html = await getHtml(URLS.printBracket);
  const lines = htmlToLines(html);
  const brackets = [];
  let cur = null;
  let section = 'Winners Bracket';

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (isBracketName(ln)) { cur = { name: ln, games: [] }; brackets.push(cur); section = 'Winners Bracket'; continue; }
    if (isElimSection(ln)) { section = 'Elimination Bracket'; continue; }

    const m = isAnchor(ln);
    if (m && cur) {
      // top team = nearest label above (skip seed badges)
      let top = null;
      for (let j = i - 1; j >= 0; j--) {
        if (isBadge(lines[j])) continue;
        if (isTeamLabel(lines[j])) { top = lines[j]; }
        break;
      }
      // field line directly below the anchor
      let field = '', k = i + 1;
      if (k < lines.length && isFieldLine(lines[k])) {
        field = (lines[k].match(/^(Field\s+\d+)/i) || [])[1] || lines[k].replace(/\s*@.*$/, '');
        k++;
      }
      // bottom team = next label after the field line (skip badges)
      let bottom = null;
      for (let j = k; j < lines.length; j++) {
        if (isBadge(lines[j])) continue;
        if (isTeamLabel(lines[j])) { bottom = lines[j]; }
        break;
      }

      cur.games.push({
        gameNum: m[1],
        date: normalizeDate(m[2]),
        time: m[3].toUpperCase().replace(/\s+/, ' '),
        field,
        round: section,
        team1: top || 'TBD',
        team2: bottom || 'TBD',
        seed1: seedOf(top),
        seed2: seedOf(bottom),
        score1: null,
        score2: null,
        status: 'upcoming',
      });
    }
  }

  // Merge in any posted scores + real team names from the regular bracket page.
  try {
    await mergeBracketScores(brackets);
  } catch { /* scores just won't show yet */ }

  return { brackets };
}

// "Seed 7" -> 7, otherwise null (Winner/Loser placeholders, real names).
function seedOf(label) {
  if (!label) return null;
  const m = label.match(/^Seed\s+(\d+)$/i);
  return m ? parseInt(m[1], 10) : null;
}

// "6/13" -> "Fri" so the UI groups bracket games by weekday like the schedule.
function normalizeDate(md) {
  const map = { '6/12': 'Thu', '6/13': 'Fri', '6/14': 'Sat', '6/15': 'Sun' };
  return map[md] || md;
}

// The regular Bracket page renders completed games as tables (one per bracket
// section). Pull scores + real team names and merge by bracket name + gameNum.
async function mergeBracketScores(brackets) {
  const html = await getHtml(URLS.bracket);
  const $ = cheerio.load(html);

  $('h3, h4, h5').each((_, h) => {
    const name = $(h).text().replace(/\s+/g, ' ').trim().split(/\s/)[0];
    const bracket = brackets.find((b) => b.name === name);
    if (!bracket) return;
    const $table = $(h).nextAll('table').first();
    if (!$table.length) return;

    parseGameTable($, $table).forEach((played) => {
      const game = bracket.games.find((g) => g.gameNum === played.gameNum);
      if (!game) return;
      if (played.team1 && played.team1 !== 'TBD') game.team1 = played.team1;
      if (played.team2 && played.team2 !== 'TBD') game.team2 = played.team2;
      game.score1 = played.score1;
      game.score2 = played.score2;
      game.status = played.status;
    });
  });
}

// Replace "Seed N" slots with the real team once NCS assigns final seeds.
// Seed N == the team ranked N in the standings table.
function applySeeds(brackets, standings) {
  const seedToTeam = {};
  for (const pool of standings.pools || []) {
    for (const t of pool.teams || []) {
      if (t.rank && t.name) seedToTeam[t.rank] = t.name;
    }
  }
  if (!Object.keys(seedToTeam).length) return; // seeds not assigned yet

  for (const b of brackets) {
    for (const g of b.games) {
      if (g.seed1 && seedToTeam[g.seed1]) g.team1 = `#${g.seed1} ${seedToTeam[g.seed1]}`;
      if (g.seed2 && seedToTeam[g.seed2]) g.team2 = `#${g.seed2} ${seedToTeam[g.seed2]}`;
    }
  }
}

// Best-effort elimination flag: a team is "out" if it lost a final
// elimination-bracket game and appears in no later non-final game.
function applyElimination(standings, bracketData) {
  const allBracketGames = (bracketData.brackets || []).flatMap((b) => b.games || []);
  const lostFinal = new Set();
  const stillPlaying = new Set();

  // Bracket team labels may carry a "#7 " seed prefix; strip it to match the
  // plain standings name, and ignore unresolved placeholder slots.
  const baseName = (s) => (s || '').replace(/^#\d+\s+/, '').trim();
  const isPlaceholder = (s) => /^(#?\d+\s+)?(seed|winner|loser)\b/i.test(s || '') || s === 'TBD';

  for (const g of allBracketGames) {
    if (g.status === 'final' && g.score1 != null && g.score2 != null) {
      const loser = g.score1 < g.score2 ? g.team1 : g.team2;
      if (loser && !isPlaceholder(loser)) lostFinal.add(baseName(loser));
    } else {
      [g.team1, g.team2].forEach((tm) => {
        if (tm && !isPlaceholder(tm)) stillPlaying.add(baseName(tm));
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

  applySeeds(bracket.brackets || [], standings);
  applyElimination(standings, bracket);

  return {
    schedule,
    standings,
    bracket,
    fetchedAt: Date.now(),
  };
}
