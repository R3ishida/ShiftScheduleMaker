/**
 * DataLoader.gs
 * Spreadsheet の各シートからデータを読み込み、内部表現に変換する。
 *
 * 内部表現の主なオブジェクト:
 *   Member { id, name, email, availableFrom, availableTo, note }
 *   Request { name, excludeDates: Set<string>, holidayPref, note }
 *   PrevAssignment { date: 'YYYY-MM-DD', name, shift }
 *   Config { ...key/value pairs }
 */

// ─────────────────────────────────────────────
// メンバー読込
// ─────────────────────────────────────────────
function loadMembers() {
  var sheet = mustGetSheet_(SHEET.MEMBERS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('「' + SHEET.MEMBERS + '」シートにデータがありません');
  }
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  var members = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[COL_MEMBER.ID - 1] && !row[COL_MEMBER.NAME - 1]) continue;
    members.push({
      id: String(row[COL_MEMBER.ID - 1]).trim(),
      name: String(row[COL_MEMBER.NAME - 1]).trim(),
      availableFrom: row[COL_MEMBER.AVAIL_FROM - 1] || null,  // Date or null
      availableTo: row[COL_MEMBER.AVAIL_TO - 1] || null
    });
  }
  return members;
}

// ─────────────────────────────────────────────
// 申請読込（同一メンバーの最新タイムスタンプを採用）
//
// 「氏名」列の値は Form のIDドロップダウンにより
//    「M01 山田太郎」のような ID プレフィックス付き形式が想定。
//   旧データ（氏名のみ）も後方互換でサポートする。
//
// 列順は Google Form の自動生成に任せて、ヘッダー名で列を特定する。
// 想定ヘッダー: 「タイムスタンプ」「氏名」「除外希望日」（+ 旧データの「備考」「年末年始希望」）
//
// members 引数: loadMembers() の結果。ID→正式氏名の解決に使用。
// ─────────────────────────────────────────────
function loadRequests(members) {
  var sheet = getSheetOrNull_(SHEET.REQUESTS);
  if (!sheet) return {};
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return {};

  // ID → 正式氏名 のマップ
  var idToName = {};
  (members || []).forEach(function (m) { idToName[m.id] = m.name; });

  // ヘッダー解析
  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = {
    timestamp: -1,
    name: -1,
    rotation: -1,
    rotationFrom: -1,
    rotationTo: -1,
    excludeDates: -1
  };
  for (var c = 0; c < headerRow.length; c++) {
    var h = String(headerRow[c] || '').trim();
    if (h === 'タイムスタンプ' || /^Timestamp$/i.test(h)) idx.timestamp = c;
    else if (h === '氏名' || h === FORM_QUESTIONS.NAME) idx.name = c;
    else if (h === FORM_QUESTIONS.ROTATION) idx.rotation = c;
    else if (h === FORM_QUESTIONS.ROTATION_FROM) idx.rotationFrom = c;
    else if (h === FORM_QUESTIONS.ROTATION_TO) idx.rotationTo = c;
    else if (h === '除外希望日' || h === FORM_QUESTIONS.EXCLUDE_DATES) idx.excludeDates = c;
  }
  if (idx.name < 0) {
    throw new Error('「' + SHEET.REQUESTS + '」シートに「氏名」列が見つかりません');
  }

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var latest = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rawName = String(row[idx.name] || '').trim();
    if (!rawName) continue;
    var name = resolveMemberName_(rawName, idToName);
    if (!name) continue;
    var ts = idx.timestamp >= 0 ? row[idx.timestamp] : null;
    var datesStr = idx.excludeDates >= 0 ? String(row[idx.excludeDates] || '') : '';
    var rotationStr = idx.rotation >= 0 ? String(row[idx.rotation] || '').trim() : '';
    var rotFromRaw = idx.rotationFrom >= 0 ? row[idx.rotationFrom] : '';
    var rotToRaw = idx.rotationTo >= 0 ? row[idx.rotationTo] : '';
    var entry = {
      name: name,
      excludeDates: parseExcludeDates_(datesStr),
      rotation: parseRotation_(rotationStr, rotFromRaw, rotToRaw)
    };
    var tsMs = ts instanceof Date ? ts.getTime() : 0;
    if (!(name in latest) || latest[name].ts < tsMs) {
      latest[name] = { ts: tsMs, request: entry };
    }
  }
  var requests = {};
  Object.keys(latest).forEach(function (k) { requests[k] = latest[k].request; });
  return requests;
}

/**
 * Form の特殊ローテーション回答を内部表現にパースする。
 *
 * 戻り値:
 *   null（ローテなし／不明）
 *   または { type: '救急'|'小児', from: Date|null, to: Date|null, isFullMonth: bool }
 *
 * 「月全体ローテ」の場合は from/to を null のままで isFullMonth=true として返し、
 * Solver 側で当月の月初〜月末に展開する。
 */
function parseRotation_(rotationStr, fromRaw, toRaw) {
  if (!rotationStr || rotationStr === ROTATION.NONE) return null;

  var type = null;
  var isFullMonth = false;
  if (rotationStr === ROTATION.ER_FULL)         { type = ROTATION_LABEL.ER;  isFullMonth = true; }
  else if (rotationStr === ROTATION.PED_FULL)   { type = ROTATION_LABEL.PED; isFullMonth = true; }
  else if (rotationStr === ROTATION.ER_PARTIAL) { type = ROTATION_LABEL.ER;  isFullMonth = false; }
  else if (rotationStr === ROTATION.PED_PARTIAL){ type = ROTATION_LABEL.PED; isFullMonth = false; }
  else return null;

  var from = null, to = null;
  if (!isFullMonth) {
    from = parseRotationDate_(fromRaw);
    to   = parseRotationDate_(toRaw);
  }
  return { type: type, from: from, to: to, isFullMonth: isFullMonth };
}

function parseRotationDate_(raw) {
  if (raw instanceof Date) return raw;
  var s = String(raw || '').trim();
  if (!s) return null;
  return parseDateLoose_(s);
}

/**
 * Form の「氏名」フィールドの値を正式氏名に解決する。
 *
 * 入力例:
 *   "M01 山田太郎"  → 先頭トークン "M01" がIDマップにある → "山田太郎"
 *   "M01"            → 値そのものがIDマップのキー → "山田太郎"
 *   "山田太郎"       → 旧データ。そのまま返す
 */
function resolveMemberName_(value, idToName) {
  if (!value) return '';
  // 値そのものが ID
  if (idToName[value]) return idToName[value];
  // 先頭トークン（半角スペース・タブ・全角スペースで区切る）
  var firstToken = value.split(/[\s\t\u3000]+/)[0];
  if (firstToken && idToName[firstToken]) return idToName[firstToken];
  // 旧データ：氏名そのもの
  return value;
}

/**
 * 除外日文字列をパースして Set 風オブジェクトに変換する。
 * Form のチェックボックス回答（"2026-06-01（月）, 2026-06-15（月）祝"）にも、
 * 旧来のテキスト入力（"2026-06-03, 2026/6/10"）にも対応する。
 *
 * 各トークンの先頭にある YYYY[-/.]M[-/.]D を抽出する部分マッチ方式。
 */
function parseExcludeDates_(str) {
  var result = {};
  if (!str) return result;
  var tokens = String(str).split(/[\s,、,]+/);
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i].trim();
    if (!t) continue;
    var d = parseDateLoose_(t);
    if (d) {
      result[formatDate_(d)] = true;
    }
  }
  return result;
}

function parseDateLoose_(s) {
  // トークン先頭の 'YYYY-MM-DD' / 'YYYY/MM/DD' / 'YYYY.MM.DD' を抽出
  // 後続の "（月）" や "祝" などは無視
  var m = s.match(/(\d{4})[\-\/\.](\d{1,2})[\-\/\.](\d{1,2})/);
  if (m) {
    var y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
    var date = new Date(y, mo, d);
    if (date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d) {
      return date;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// 前月実績読込
// ─────────────────────────────────────────────
function loadPrevAssignments() {
  var sheet = getSheetOrNull_(SHEET.PREV_ACTUAL);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  var result = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var date = row[COL_PREV.DATE - 1];
    if (!(date instanceof Date)) continue;
    var aName = String(row[COL_PREV.A - 1] || '').trim();
    var bName = String(row[COL_PREV.B - 1] || '').trim();
    if (aName) result.push({ date: formatDate_(date), name: aName, shift: SHIFT_A });
    if (bName) result.push({ date: formatDate_(date), name: bName, shift: SHIFT_B });
  }
  return result;
}

// ─────────────────────────────────────────────
// 祝日読込（シート優先、無ければ Calendar API）
// ─────────────────────────────────────────────
function loadHolidays(year, month) {
  var sheet = getSheetOrNull_(SHEET.HOLIDAYS);
  if (sheet && sheet.getLastRow() >= 2) {
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    var set = {};
    for (var i = 0; i < values.length; i++) {
      var d = values[i][COL_HOLIDAY.DATE - 1];
      if (d instanceof Date) {
        if (d.getFullYear() === year && (d.getMonth() + 1) === month) {
          set[formatDate_(d)] = true;
        }
      }
    }
    if (Object.keys(set).length > 0) return set;
  }
  // CalendarApp 経由
  return fetchJapanHolidays_(year, month);
}

function fetchJapanHolidays_(year, month) {
  var set = {};
  try {
    var cal = CalendarApp.getCalendarById(JAPAN_HOLIDAY_CALENDAR_ID);
    if (!cal) return set;
    var start = new Date(year, month - 1, 1);
    var end = new Date(year, month, 0, 23, 59, 59);
    var events = cal.getEvents(start, end);
    for (var i = 0; i < events.length; i++) {
      var d = events[i].getStartTime();
      set[formatDate_(d)] = true;
    }
  } catch (e) {
    Logger.log('祝日カレンダー取得失敗: ' + e);
  }
  return set;
}

// ─────────────────────────────────────────────
// 設定読込
// ─────────────────────────────────────────────
function loadConfig() {
  var sheet = mustGetSheet_(SHEET.CONFIG);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('「' + SHEET.CONFIG + '」シートにデータがありません');
  }
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var cfg = {};
  for (var i = 0; i < values.length; i++) {
    var key = String(values[i][0] || '').trim();
    var val = values[i][1];
    if (key) cfg[key] = val;
  }
  // 既定値で穴埋め
  return {
    targetYearMonth: parseYearMonth_(cfg['対象年月']),
    minGapDays: numOrDefault_(cfg['最小間隔（日）'], DEFAULTS.MIN_GAP_DAYS),
    weekendMax: numOrDefault_(cfg['土日祝上限（人/月）'], DEFAULTS.WEEKEND_MAX),
    maxPerMonth: numOrDefault_(cfg['月当直回数 上限'], DEFAULTS.MAX_PER_MONTH),
    targetCenter: numOrDefault_(cfg['月当直回数 中心'], DEFAULTS.TARGET_CENTER),
    shortGapWindow: numOrDefault_(cfg['短間隔ペナルティ窓（日）'], DEFAULTS.SHORT_GAP_WINDOW),
    pdfFolderId: String(cfg['PDF出力先フォルダID'] || '').trim(),
    greedyTries: numOrDefault_(cfg['試行回数（貪欲）'], DEFAULTS.GREEDY_TRIES),
    localSearchLimitSec: numOrDefault_(cfg['局所探索 上限秒数'], DEFAULTS.LOCAL_SEARCH_LIMIT_SEC),
    randomSeed: parseSeed_(cfg['ランダムシード']),
    validateRequests: parseBoolish_(cfg['申請チェック'], DEFAULTS.VALIDATE_REQUESTS)
  };
}

/**
 * 「ランダムシード」を解釈する。
 *   - 空欄 / "auto" / 0 → 毎回違う結果（時刻ベース）
 *   - 数値           → 固定（再現可能）
 */
function parseSeed_(v) {
  if (v === '' || v === null || v === undefined) {
    return (new Date()).getTime() & 0x7FFFFFFF;
  }
  if (typeof v === 'string' && v.trim().toLowerCase() === 'auto') {
    return (new Date()).getTime() & 0x7FFFFFFF;
  }
  var n = Number(v);
  if (isNaN(n) || n === 0) {
    return (new Date()).getTime() & 0x7FFFFFFF;
  }
  return n;
}

// "ON"/"OFF"/true/false/"はい"/"いいえ" などを真偽値に正規化
function parseBoolish_(v, def) {
  if (v === '' || v === null || v === undefined) return def;
  if (typeof v === 'boolean') return v;
  var s = String(v).trim().toLowerCase();
  if (s === 'on' || s === 'true' || s === '1' || s === 'はい' || s === '実施' || s === '有') return true;
  if (s === 'off' || s === 'false' || s === '0' || s === 'いいえ' || s === '省略' || s === '無' || s === 'スキップ') return false;
  return def;
}

/**
 * 目標回数テーブルを読み込む。
 *
 * 「目標回数」シート（任意）:
 *   1列目: 実効日下限（その日数 "以上" で適用）
 *   2列目: 当直回数
 *
 * 例:
 *    0 → 0   （実効 0〜5 日）
 *    6 → 1   （実効 6〜10 日）
 *   11 → 2   （実効 11〜15 日）
 *   16 → 3   （実効 16 日以上）
 *
 * 戻り値:
 *   [{ minDays: number, count: number }, ...]   下限の昇順にソート済み
 *   テーブル未定義 / 空 のときは null を返す（Solver 側で Hare quota に fallback）
 */
function loadTargetTable() {
  var sheet = getSheetOrNull_(SHEET.TARGET_TABLE);
  if (!sheet) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var table = [];
  for (var i = 0; i < values.length; i++) {
    var raw = values[i][COL_TARGET_TABLE.MIN_DAYS - 1];
    var c   = values[i][COL_TARGET_TABLE.COUNT - 1];
    if (raw === '' || raw === null || raw === undefined) continue;
    var minDays = Number(raw);
    var count = Number(c);
    if (isNaN(minDays) || isNaN(count)) continue;
    table.push({ minDays: minDays, count: count });
  }
  if (table.length === 0) return null;
  table.sort(function (a, b) { return a.minDays - b.minDays; });
  return table;
}

/**
 * 目標回数テーブルを使って、実効稼働日数 → 当直回数 を引く。
 * 「最大の minDays ≤ effDays」を満たす行の count を返す。該当が無ければ 0。
 */
function lookupTargetCount_(table, effDays) {
  if (!table || table.length === 0) return null;
  var found = null;
  for (var i = 0; i < table.length; i++) {
    if (effDays >= table[i].minDays) found = table[i].count;
    else break;
  }
  return found === null ? 0 : found;
}

function parseYearMonth_(value) {
  if (value instanceof Date) {
    return { year: value.getFullYear(), month: value.getMonth() + 1 };
  }
  var s = String(value || '').trim();
  var m = s.match(/^(\d{4})[\-\/\.](\d{1,2})$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  throw new Error('対象年月の書式が不正です: ' + s + '（例: 2026-06）');
}

function numOrDefault_(v, def) {
  if (v === '' || v === null || v === undefined) return def;
  var n = Number(v);
  return isNaN(n) ? def : n;
}

// ─────────────────────────────────────────────
// 共通ユーティリティ
// ─────────────────────────────────────────────
function mustGetSheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) {
    throw new Error('シート「' + name + '」が見つかりません');
  }
  return sh;
}

function getSheetOrNull_(name) {
  return SpreadsheetApp.getActive().getSheetByName(name);
}

function formatDate_(d) {
  return Utilities.formatDate(d, DEFAULTS.TIMEZONE, 'yyyy-MM-dd');
}

function dateFromString_(s) {
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dayDiff_(d1, d2) {
  // d1, d2 が 'YYYY-MM-DD' 文字列の場合
  var a = dateFromString_(d1).getTime();
  var b = dateFromString_(d2).getTime();
  return Math.round((a - b) / (24 * 3600 * 1000));
}
