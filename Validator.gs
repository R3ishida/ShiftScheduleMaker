/**
 * Validator.gs
 * 申請シートの全行を読み、3ルールに違反する行を検出する。
 *
 * 自動トリガーは使わない。以下の2タイミングで呼ばれる：
 *   1. メニュー「申請を再チェック」から手動実行
 *   2. 「当月分を生成」の冒頭で自動実行（違反があれば警告→続行可否を確認）
 *
 *  - ルール1: 1か月当たり5日まで
 *  - ルール2: そのうち土日祝は3日まで
 *  - ルール5: GW期間（4/29-5/5）連続3日以上の申請禁止
 *
 * 違反行は「申請」シートで赤背景に塗られ、「備考」列にエラー内容が追記される。
 */

var VALIDATOR_RULES = {
  MAX_DAYS_PER_MONTH: 5,
  MAX_WEEKEND_DAYS: 3,
  GW_START_MONTHDAY: '04-29',
  GW_END_MONTHDAY: '05-05',
  GW_MAX_CONSECUTIVE: 3   // 3日連続以上は不可
};

// ─────────────────────────────────────────────
// 申請シートの全行をチェックして結果を返す
// 戻り値: [{ row, name, errors: [string] }, ...]   違反のあった行のみ
// ─────────────────────────────────────────────
function validateAllRequests() {
  var sheet = getSheetOrNull_(SHEET.REQUESTS);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  // ヘッダー解析
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = { name: -1, excludeDates: -1, note: -1 };
  for (var c = 0; c < header.length; c++) {
    var h = String(header[c] || '').trim();
    if (h === '氏名' || h === FORM_QUESTIONS.NAME) idx.name = c;
    else if (h === '除外希望日' || h === FORM_QUESTIONS.EXCLUDE_DATES) idx.excludeDates = c;
    else if (h === '備考' || h === FORM_QUESTIONS.NOTE) idx.note = c;
  }
  if (idx.name < 0 || idx.excludeDates < 0) {
    throw new Error('「' + SHEET.REQUESTS + '」シートに「氏名」「除外希望日」列が見つかりません');
  }

  // まず既存の赤背景・エラー注記をリセット
  resetValidationMarks_(sheet, idx.note);

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var violations = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var name = String(row[idx.name] || '').trim();
    if (!name) continue;
    var datesStr = String(row[idx.excludeDates] || '');
    var dates = parseDatesV_(datesStr);
    var errors = validateRequest_(dates);
    if (errors.length > 0) {
      var rowNumber = i + 2;
      violations.push({ row: rowNumber, name: name, errors: errors });
      // シートにマーク
      sheet.getRange(rowNumber, 1, 1, lastCol).setBackground(COLOR.ERROR_BG);
      if (idx.note >= 0) {
        var noteCell = sheet.getRange(rowNumber, idx.note + 1);
        var orig = String(noteCell.getValue() || '');
        // 既存のチェック注記は除いて再付与
        var clean = orig.replace(/\s*\[自動チェック失敗:[^\]]*\]\s*/g, '').trim();
        var msg = '[自動チェック失敗: ' + errors.join(' / ') + ']';
        noteCell.setValue(clean ? (clean + ' ' + msg) : msg);
      }
    }
  }
  return violations;
}

// ─────────────────────────────────────────────
// 既存の赤背景と「自動チェック失敗」注記を消す
// ─────────────────────────────────────────────
function resetValidationMarks_(sheet, noteIdx) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return;
  // 背景色を白に戻す（ヘッダー以外）
  sheet.getRange(2, 1, lastRow - 1, lastCol).setBackground(null);
  // 備考列の注記を削除
  if (noteIdx >= 0) {
    var noteRange = sheet.getRange(2, noteIdx + 1, lastRow - 1, 1);
    var values = noteRange.getValues();
    var changed = false;
    for (var i = 0; i < values.length; i++) {
      var orig = String(values[i][0] || '');
      var clean = orig.replace(/\s*\[自動チェック失敗:[^\]]*\]\s*/g, '').trim();
      if (clean !== orig) {
        values[i][0] = clean;
        changed = true;
      }
    }
    if (changed) noteRange.setValues(values);
  }
}

// ─────────────────────────────────────────────
// バリデーション本体
// ─────────────────────────────────────────────
function validateRequest_(dates) {
  var errs = [];

  // ルール1: 5日上限（同月内）
  var byYm = {};
  dates.forEach(function (d) {
    var ym = d.getFullYear() + '-' + (d.getMonth() + 1);
    byYm[ym] = (byYm[ym] || 0) + 1;
  });
  Object.keys(byYm).forEach(function (ym) {
    if (byYm[ym] > VALIDATOR_RULES.MAX_DAYS_PER_MONTH) {
      errs.push(ym + 'の希望が' + byYm[ym] + '日（上限' + VALIDATOR_RULES.MAX_DAYS_PER_MONTH + '日）');
    }
  });

  // ルール2: 土日祝3日上限
  var weekendByYm = {};
  dates.forEach(function (d) {
    var ym = d.getFullYear() + '-' + (d.getMonth() + 1);
    if (isWeekendOrHolidayV_(d)) {
      weekendByYm[ym] = (weekendByYm[ym] || 0) + 1;
    }
  });
  Object.keys(weekendByYm).forEach(function (ym) {
    if (weekendByYm[ym] > VALIDATOR_RULES.MAX_WEEKEND_DAYS) {
      errs.push(ym + 'の土日祝希望が' + weekendByYm[ym] + '日（上限' + VALIDATOR_RULES.MAX_WEEKEND_DAYS + '日）');
    }
  });

  // ルール5: GW連続3日禁止
  var gwDates = dates.filter(isInGwV_);
  if (gwDates.length >= VALIDATOR_RULES.GW_MAX_CONSECUTIVE) {
    gwDates.sort(function (a, b) { return a - b; });
    var run = 1, maxRun = 1;
    for (var i = 1; i < gwDates.length; i++) {
      var diff = (gwDates[i] - gwDates[i - 1]) / (24 * 3600 * 1000);
      if (Math.round(diff) === 1) { run++; maxRun = Math.max(maxRun, run); }
      else { run = 1; }
    }
    if (maxRun >= VALIDATOR_RULES.GW_MAX_CONSECUTIVE) {
      errs.push('GW期間に連続' + maxRun + '日の希望（連続' +
        VALIDATOR_RULES.GW_MAX_CONSECUTIVE + '日以上は不可）');
    }
  }

  return errs;
}

// ─────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────
function parseDatesV_(str) {
  var out = [];
  if (!str) return out;
  var tokens = String(str).split(/[\s,、,]+/);
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i].trim();
    if (!t) continue;
    // トークン先頭の YYYY-MM-DD を部分マッチで抽出
    // （Form のチェックボックス値「2026-06-01（月）祝」にも対応）
    var m = t.match(/(\d{4})[\-\/\.](\d{1,2})[\-\/\.](\d{1,2})/);
    if (m) {
      var y = Number(m[1]), mo = Number(m[2]) - 1, dd = Number(m[3]);
      var d = new Date(y, mo, dd);
      if (d.getFullYear() === y && d.getMonth() === mo && d.getDate() === dd) {
        out.push(d);
      }
    }
  }
  return out;
}

function isWeekendOrHolidayV_(date) {
  var w = date.getDay();
  if (w === 0 || w === 6) return true;
  try {
    var cal = CalendarApp.getCalendarById(JAPAN_HOLIDAY_CALENDAR_ID);
    if (cal) {
      var events = cal.getEventsForDay(date);
      if (events && events.length > 0) return true;
    }
  } catch (e) { /* 無視 */ }
  return false;
}

function isInGwV_(date) {
  var mmdd = pad2_(date.getMonth() + 1) + '-' + pad2_(date.getDate());
  return mmdd >= VALIDATOR_RULES.GW_START_MONTHDAY &&
         mmdd <= VALIDATOR_RULES.GW_END_MONTHDAY;
}
