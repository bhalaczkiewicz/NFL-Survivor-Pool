/** ===================== CONFIG ===================== **/
/** If you want to point to an existing spreadsheet, paste its ID or full URL here.
 *  Leave empty "" to auto-create one named "NFL_Picks_Storage".
 */
var SHEET_ID_OR_URL = "";         // e.g. "1AbCdEFGhIJKlmnOPQRstuVwxyz123..." or full https URL
var SHEET_TAB       = "Picks";    // tab for picks
var LIVES_TAB       = "Lives";    // tab for lives
var MAX_LIVES       = 5;          // lives per user per season

/** ===================== MENU / SIDEBAR / WEB APP ===================== **/

function onOpen() {
  DocumentApp.getUi()
    .createMenu('NFL Picks')
    .addItem('Open Picker', 'showSidebar')
    .addToUi();
}

function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('NFL Survivor Picker');
  DocumentApp.getUi().showSidebar(html);
}

// Optional: lets you deploy as a standalone web app (Deploy → Web app)
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('NFL Survivor Picker');
}

/** ===================== IDENTITY (viewer email) ===================== **/

function getViewerEmailPublic() { return getViewerEmail_(); }

/** Returns the current viewer's email, or '' if unavailable. */
function getViewerEmail_() {
  // Works on most Google Workspace domains:
  var e = Session.getActiveUser().getEmail() || '';
  if (e) return e;

  // Fallback via People API (enable Advanced Service + Cloud API if you want this)
  try {
    var me = People.People.get('people/me', { personFields: 'emailAddresses' });
    if (me && me.emailAddresses && me.emailAddresses.length) {
      return String(me.emailAddresses[0].value || '');
    }
  } catch (err) { /* ignore */ }

  return '';
}

/** ===================== DEFAULT YEAR / WEEK (auto) ===================== **/

function getDefaultYearWeek() {
  var now = new Date();
  var year = now.getFullYear();

  var cache = CacheService.getScriptCache();
  var key = 'wk:' + year;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var chosen = resolveCurrentOrNextWeek_(year) || { year: year, week: 1 };
  cache.put(key, JSON.stringify(chosen), 6 * 60 * 60); // cache 6h
  return chosen;
}

/** Probe weeks; return current (around now) else next upcoming else 1. */
function resolveCurrentOrNextWeek_(year) {
  var nowMs = Date.now();
  var bestUpcomingStart = null, bestUpcomingWeek = null;

  for (var w = 1; w <= 22; w++) {
    var url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
      + '?year=' + encodeURIComponent(year)
      + '&week=' + encodeURIComponent(w)
      + '&seasontype=2';

    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) continue;

    var data = JSON.parse(resp.getContentText());
    var events = (data && data.events) ? data.events : [];
    if (!events.length) continue;

    var minStart = null, maxStart = null;
    for (var i = 0; i < events.length; i++) {
      var iso = events[i] && events[i].date;
      if (!iso) continue;
      var t = new Date(iso).getTime();
      if (!isFinite(t)) continue;
      if (minStart === null || t < minStart) minStart = t;
      if (maxStart === null || t > maxStart) maxStart = t;
    }
    if (minStart === null) continue;

    var curWindowStart = minStart - 24 * 3600 * 1000;
    var curWindowEnd   = maxStart + 24 * 3600 * 1000;

    if (nowMs >= curWindowStart && nowMs <= curWindowEnd) {
      return { year: year, week: w };
    }
    if (minStart > nowMs) {
      if (bestUpcomingStart === null || minStart < bestUpcomingStart) {
        bestUpcomingStart = minStart;
        bestUpcomingWeek = w;
      }
    }
  }
  if (bestUpcomingWeek !== null) return { year: year, week: bestUpcomingWeek };
  return { year: year, week: 1 };
}

/** ===================== ESPN SCOREBOARD (fetch + parse) ===================== **/

// SAFE cache: only cache if response < ~95KB to avoid "Argument too large"
function fetchScoreboard_(year, week) {
  var y = Number(year), w = Number(week);
  var cache = CacheService.getScriptCache();
  var key = 'sb:' + y + ':' + w;

  var hit = cache.get(key);
  if (hit) {
    try { return JSON.parse(hit); } catch (_) { /* refetch */ }
  }

  var url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
          + '?year=' + encodeURIComponent(y)
          + '&week=' + encodeURIComponent(w)
          + '&seasontype=2';

  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('ESPN error HTTP ' + resp.getResponseCode());
  }
  var data = JSON.parse(resp.getContentText());

  try {
    var text = JSON.stringify(data);
    if (text && text.length < 95000) cache.put(key, text, 60); // 60s cache
  } catch (e) { /* too large, skip caching */ }

  return data;
}

/** Find a game by team abbreviations; returns minimal status. */
function findGameByAbbr_(data, teamAbbr, oppAbbr) {
  var events = (data && data.events) ? data.events : [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var cmp = ev && ev.competitions && ev.competitions[0];
    if (!cmp || !cmp.competitors || cmp.competitors.length < 2) continue;

    var home = cmp.competitors.find(function(c){ return c.homeAway === 'home'; });
    var away = cmp.competitors.find(function(c){ return c.homeAway === 'away'; });
    if (!home || !away) continue;

    var h = home.team && (home.team.abbreviation || home.team.shortDisplayName || home.team.displayName);
    var a = away.team && (away.team.abbreviation || away.team.shortDisplayName || away.team.displayName);
    if (!h || !a) continue;

    var iso = ev.date || '';
    var status = (cmp.status && cmp.status.type) || (ev.status && ev.status.type) || {};
    var state = (status.state || '').toLowerCase(); // 'pre' | 'in' | 'post'
    var completed = !!status.completed;

    var t = String(teamAbbr).toUpperCase(), o = String(oppAbbr).toUpperCase();
    var AU = String(a).toUpperCase(), HU = String(h).toUpperCase();
    var matches = (t === AU && o === HU) || (t === HU && o === AU);

    if (matches) {
      return { iso: iso, state: state, completed: completed, away: a, home: h, cmp: cmp };
    }
  }
  return null;
}

/** Compact per-game payload with logos for the sidebar.
 * Returns: { games: [ [awayAbbr, homeAbbr, kickoffISO, shortWhen, awayLogo, homeLogo] ] }
 */
function getNflGamesLite(year, week) {
  var y = Number(year); if (!Number.isFinite(y) || y < 2000) y = (new Date()).getFullYear();
  var w = Number(week); if (!Number.isFinite(w) || w < 1 || w > 22) w = 1;

  var data = fetchScoreboard_(y, w);
  var events = (data && data.events) ? data.events : [];

  var tz = Session.getScriptTimeZone() || 'America/Phoenix';
  var out = [];

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var cmp = ev && ev.competitions && ev.competitions[0];
    if (!cmp || !cmp.competitors || cmp.competitors.length < 2) continue;

    var home = cmp.competitors.find(function(c){ return c.homeAway === 'home'; });
    var away = cmp.competitors.find(function(c){ return c.homeAway === 'away'; });
    if (!home || !away) continue;

    var hAbbr = (home.team && (home.team.abbreviation || home.team.shortDisplayName || home.team.displayName)) || '';
    var aAbbr = (away.team && (away.team.abbreviation || away.team.shortDisplayName || away.team.displayName)) || '';

    var hLogo = (home.team && (home.team.logo || (home.team.logos && home.team.logos[0] && home.team.logos[0].href))) || '';
    var aLogo = (away.team && (away.team.logo || (away.team.logos && away.team.logos[0] && away.team.logos[0].href))) || '';

    var iso = ev.date || '';
    var when = iso ? Utilities.formatDate(new Date(iso), tz, 'MM/dd HH:mm') : '';

    out.push([aAbbr, hAbbr, iso, when, aLogo, hLogo]);
  }
  if (out.length > 64) out = out.slice(0, 64);
  return { games: out };
}

/** ===================== STORAGE (Google Sheet) ===================== **/

function _normalizeSheetId_(input) {
  if (!input) return "";
  input = String(input).trim();
  if (input.startsWith("http")) {
    var m = input.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (m && m[1]) return m[1];
    throw new Error("Could not extract spreadsheet ID from URL. Expecting /d/<ID>/ in the link.");
  }
  return input; // already an ID
}

function getOrCreateSheet_() {
  var ss, sh;
  var id = _normalizeSheetId_(SHEET_ID_OR_URL);

  if (id) {
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (e) {
      throw new Error("Could not open spreadsheet by SHEET_ID_OR_URL. Check the ID/URL and access.\n" + e);
    }
  } else {
    // No ID/URL provided → auto-create
    ss = SpreadsheetApp.create('NFL_Picks_Storage');
    id = ss.getId();
    SHEET_ID_OR_URL = id; // note: not persisted; set constant permanently later if desired
  }

  // Ensure the picks tab exists with expected columns
  sh = ss.getSheetByName(SHEET_TAB) || ss.insertSheet(SHEET_TAB);

  // Header with two extra columns for results bookkeeping
  var expected = ['Timestamp','Year','Week','User','Team','Opponent','KickoffISO','Result','ResultApplied'];
  if (sh.getLastRow() === 0) {
    sh.appendRow(expected);
  } else {
    var hdr = sh.getRange(1,1,1,expected.length).getValues()[0].map(String);
    if (hdr.length < expected.length || expected.some(function(h,i){ return (hdr[i]||'') !== h; })) {
      sh.getRange(1,1,1,expected.length).setValues([expected]);
    }
  }
  return sh;
}

function getOrCreateLivesSheet_() {
  var id = _normalizeSheetId_(SHEET_ID_OR_URL);
  if (!id) throw new Error("Picks spreadsheet not found.");
  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(LIVES_TAB) || ss.insertSheet(LIVES_TAB);
  var expected = ['Year','User','Lives'];
  if (sh.getLastRow() === 0) {
    sh.appendRow(expected);
  } else {
    var hdr = sh.getRange(1,1,1,expected.length).getValues()[0].map(String);
    if (hdr.length < expected.length || expected.some(function(h,i){ return (hdr[i]||'') !== h; })) {
      sh.getRange(1,1,1,expected.length).setValues([expected]);
    }
  }
  return sh;
}

function getLivesRow_(year, email) {
  var sh = getOrCreateLivesSheet_();
  var vals = sh.getDataRange().getValues(); // [hdr,...]
  var target = String(email).toLowerCase();
  for (var i = 1; i < vals.length; i++) {
    var r = vals[i]; // Year, User, Lives
    if (String(r[0]) === String(year) && String(r[1]).toLowerCase() === target) {
      var lives = Number(r[2]); if (!Number.isFinite(lives)) lives = MAX_LIVES;
      return { row: i + 1, lives: lives, sheet: sh };
    }
  }
  // create a row initialized to MAX_LIVES
  var newRow = [year, email, MAX_LIVES];
  sh.appendRow(newRow);
  return { row: sh.getLastRow(), lives: MAX_LIVES, sheet: sh };
}

/** Current pick for viewer (year/week) with live state. */
function getCurrentPickForViewer(year, week) {
  var email = getViewerEmail_();
  if (!email) return { team: '', opponent: '', kickoffISO: '', state: '' };

  var sh = getOrCreateSheet_();
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[1]) === String(year) &&
        String(r[2]) === String(week) &&
        String(r[3]).toLowerCase() === String(email).toLowerCase()) {
      var team = String(r[4] || '');
      var opp  = String(r[5] || '');
      var iso  = String(r[6] || '');
      var data = fetchScoreboard_(year, week);
      var info = findGameByAbbr_(data, team, opp) || {};
      return { team: team, opponent: opp, kickoffISO: iso, state: (info.state || '') };
    }
  }
  return { team: '', opponent: '', kickoffISO: '', state: '' };
}

function getCurrentPickForViewerPublic(year, week) {
  return getCurrentPickForViewer(year, week);
}

/** ===================== SURVIVOR RULE (used teams by viewer/year) ===================== **/

function getUsedTeamsForViewer(year) {
  var userEmail = getViewerEmail_();
  if (!userEmail) return { teams: [] };

  var y = Number(year);
  if (!Number.isFinite(y)) y = (new Date()).getFullYear();

  var sh = getOrCreateSheet_();
  var vals = sh.getDataRange().getValues();
  var used = {};
  for (var i = 1; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[1]) === String(y) &&
        String(r[3]).toLowerCase() === String(userEmail).toLowerCase()) {
      var t = String(r[4] || '').toUpperCase();
      if (t) used[t] = true;
    }
  }
  return { teams: Object.keys(used) };
}

/** ===================== UPSERT HELPER ===================== **/

function upsertPickRow_(sh, y, w, email, team, opponent, kickoffISO) {
  // Try to find an existing row for (user, year, week)
  var vals = sh.getDataRange().getValues();  // includes header
  var target = String(email).toLowerCase();
  var existingRow = null;

  for (var i = 1; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[1]) === String(y) &&
        String(r[2]) === String(w) &&
        String(r[3]).toLowerCase() === target) {
      existingRow = i + 1; // 1-based row index
      break;
    }
  }

  var now = new Date();
  // Timestamp, Year, Week, User, Team, Opponent, KickoffISO, Result, ResultApplied
  var rowValues = [now, y, w, email, team, opponent, kickoffISO || '', 'PENDING', false];

  if (existingRow) {
    // Overwrite + reset to PENDING (since user changed pick before kickoff)
    sh.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sh.appendRow(rowValues);
  }
}

/** ===================== SUBMIT (identity + kickoff locks + UPSERT) ===================== **/

function submitPick(year, week, userLabel, team, opponent, _kickoffISO, _lockAtKickoff) {
  var userEmail = getViewerEmail_();
  if (!userEmail) throw new Error('Could not verify your Google account email.');

  if (!year || !week || !team) throw new Error('Missing required fields.');
  var y = Number(year), w = Number(week);
  if (!Number.isFinite(y) || !Number.isFinite(w)) throw new Error('Invalid year/week.');

  // Take a lock to avoid concurrent writes
  var lock = LockService.getScriptLock();
  lock.waitLock(10000); // up to 10s
  try {
    // 1) Live scoreboard: verify selected game hasn't started/finished
    var data = fetchScoreboard_(y, w);
    var target = findGameByAbbr_(data, team, opponent);
    if (!target) throw new Error('Could not verify the selected game.');
    if (target.state !== 'pre') throw new Error('That game has already started or finished.');

    // 2) If a pick exists, only allow change if THEIR current pick is still PRE
    var sh = getOrCreateSheet_();
    var vals = sh.getDataRange().getValues();
    var existingRow = null, existingTeam = '', existingOpp = '', existingIso = '';

    for (var i = 1; i < vals.length; i++) {
      var r = vals[i];
      if (String(r[1]) === String(y) &&
          String(r[2]) === String(w) &&
          String(r[3]).toLowerCase() === String(userEmail).toLowerCase()) {
        existingRow = i + 1;
        existingTeam = String(r[4] || '');
        existingOpp  = String(r[5] || '');
        existingIso  = String(r[6] || '');
        break;
      }
    }

    if (existingRow) {
      var curInfo = findGameByAbbr_(data, existingTeam, existingOpp);
      var curState = curInfo ? (curInfo.state || '') : '';
      if (!curInfo) {
        if (existingIso && new Date(existingIso).getTime() <= Date.now()) {
          throw new Error('Your current pick is locked (kickoff passed).');
        }
      } else if (curState !== 'pre') {
        throw new Error('Your current pick is locked (game started or finished).');
      }
    }

    // 3) UPSERT the row (Timestamp is the pick datetime)
    upsertPickRow_(sh, y, w, userEmail, team, opponent, target.iso || '');

    return true;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** ===================== RESULTS / LIVES ===================== **/

function evaluatePickResult_(data, teamAbbr, oppAbbr) {
  var info = findGameByAbbr_(data, teamAbbr, oppAbbr);
  if (!info) return { state: 'unknown', win: null };

  var events = (data && data.events) ? data.events : [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var cmp = ev && ev.competitions && ev.competitions[0];
    if (!cmp || !cmp.competitors || cmp.competitors.length < 2) continue;

    var home = cmp.competitors.find(function(c){ return c.homeAway === 'home'; });
    var away = cmp.competitors.find(function(c){ return c.homeAway === 'away'; });
    if (!home || !away) continue;

    var h = home.team && (home.team.abbreviation || home.team.shortDisplayName || home.team.displayName);
    var a = away.team && (away.team.abbreviation || away.team.shortDisplayName || away.team.displayName);
    var tU = String(teamAbbr).toUpperCase();
    var oU = String(oppAbbr).toUpperCase();
    if (!h || !a) continue;

    var AU = String(a).toUpperCase(), HU = String(h).toUpperCase();
    var matches = (tU === AU && oU === HU) || (tU === HU && oU === AU);
    if (!matches) continue;

    var status = (cmp.status && cmp.status.type) || (ev.status && ev.status.type) || {};
    var state = (status.state || '').toLowerCase(); // 'pre'|'in'|'post'
    if (state !== 'post') return { state: state || 'pre', win: null };

    // Prefer ESPN winner flag; fallback to scores
    var tComp = (tU === AU) ? away : home;
    var oComp = (tU === AU) ? home : away;

    var winner = null;
    if (tComp && typeof tComp.winner === 'boolean') {
      winner = !!tComp.winner;
    } else {
      var ts = parseInt(tComp && tComp.score, 10);
      var os = parseInt(oComp && oComp.score, 10);
      if (Number.isFinite(ts) && Number.isFinite(os)) {
        if (ts > os) winner = true;
        else if (ts < os) winner = false;
        else winner = null; // tie -> no loss (adjust if ties should count as losses)
      }
    }
    return { state: 'post', win: winner };
  }
  return { state: 'unknown', win: null };
}

function processLivesForViewer_(year) {
  var email = getViewerEmail_();
  if (!email) return MAX_LIVES;

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = getOrCreateSheet_();
    var livesRow = getLivesRow_(year, email);
    var lives = livesRow.lives;

    // small cache of scoreboards by week
    var vals = sh.getDataRange().getValues();
    var boardCache = {}; // week -> data

    for (var i = 1; i < vals.length; i++) {
      var r = vals[i]; // Timestamp,Year,Week,User,Team,Opponent,ISO,Result,Applied
      if (String(r[1]) !== String(year)) continue;
      if (String(r[3]).toLowerCase() !== String(email).toLowerCase()) continue;

      var resultApplied = (String(r[8]).toLowerCase() === 'true');
      if (resultApplied) continue; // already processed

      var w = Number(r[2]);
      var t = String(r[4] || '').toUpperCase();
      var o = String(r[5] || '').toUpperCase();
      if (!Number.isFinite(w) || !t) continue;

      // Fetch this week's board (cached)
      if (!boardCache[w]) boardCache[w] = fetchScoreboard_(year, w);
      var outcome = evaluatePickResult_(boardCache[w], t, o);

      if (outcome.state === 'post') {
        var isWin = outcome.win === true;
        var isLoss = outcome.win === false; // tie => no change; change to (outcome.win !== true) if ties are losses

        // Mark result on Picks row
        var rowIdx = i + 1;
        sh.getRange(rowIdx, 8).setValue(isWin ? 'W' : (isLoss ? 'L' : 'TIE'));
        sh.getRange(rowIdx, 9).setValue(true);

        // Apply life change once
        if (isLoss && lives > 0) {
          lives = lives - 1;
        }
      }
    }

    // Persist lives
    lives = Math.max(0, Math.min(MAX_LIVES, lives));
    livesRow.sheet.getRange(livesRow.row, 3).setValue(lives);

    return lives;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function getLivesForViewerPublic(year) {
  var y = Number(year);
  if (!Number.isFinite(y)) y = (new Date()).getFullYear();
  var lives = processLivesForViewer_(y);
  return { lives: lives, max: MAX_LIVES };
}
