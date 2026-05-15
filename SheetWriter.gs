/**
 * SheetWriter.gs
 * Solver の結果を Spreadsheet の各シートに書き出す。
 *  - カレンダー（月次）
 *  - 集計（個人別）
 *  - 個人別（行=メンバー、列=日付のクロス表）
 */

function writeAllOutputs(result) {
  var ctx = result.ctx;
  writeCalendarSheet_(ctx, result);
  writeSummarySheet_(ctx, result);
  writePersonalSheet_(ctx, result);
  appendLog_(ctx, result);
}

// シート 1 行目に「最終更新: YYYY-MM-DD HH:mm:ss」を表示する
//
// splitAt: あとで固定列を設定する列番号（その列とそれ以降の境界でマージを分ける）。
//          0 または省略時は行全体を 1 つのマージにする。
//          設定しないと「固定/非固定の境界をまたぐマージ」エラーになる。
function writeUpdatedAtRow_(sheet, nCols, splitAt) {
  splitAt = splitAt || 0;
  var now = Utilities.formatDate(new Date(), DEFAULTS.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  var values = new Array(nCols);
  values[0] = '最終更新: ' + now;
  for (var i = 1; i < nCols; i++) values[i] = '';
  sheet.getRange(1, 1, 1, nCols).setValues([values])
    .setFontStyle('italic')
    .setFontColor('#555555')
    .setBackground('#f5f5f5');

  function safeMerge(col, w) {
    if (w > 1) {
      try { sheet.getRange(1, col, 1, w).merge(); }
      catch (e) { Logger.log('merge skipped: ' + e); }
    }
  }

  if (splitAt > 0 && splitAt < nCols) {
    // 固定列範囲（1〜splitAt）と 非固定列範囲（splitAt+1〜nCols）を別々にマージ
    safeMerge(1, splitAt);
    safeMerge(splitAt + 1, nCols - splitAt);
  } else {
    safeMerge(1, nCols);
  }
}

// ─────────────────────────────────────────────
// カレンダーシート
// ─────────────────────────────────────────────
function writeCalendarSheet_(ctx, result) {
  var sheet = ensureSheet_(SHEET.CALENDAR);
  // 前回の固定行・固定列・マージを全解除（マージ操作と衝突するため）
  try { sheet.setFrozenRows(0); } catch (e) {}
  try { sheet.setFrozenColumns(0); } catch (e) {}
  try { sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart(); } catch (e) {}
  sheet.clear();
  sheet.clearFormats();

  // ヘッダー
  var header = ['日付', '曜日', '祝日', 'A（準夜勤）', 'B（夜勤）', '救急ローテ', '小児ローテ'];
  writeUpdatedAtRow_(sheet, header.length);
  sheet.getRange(2, 1, 1, header.length).setValues([header])
    .setFontWeight('bold')
    .setBackground(COLOR.HEADER_BG);

  var rows = [];
  var weekendRows = [];
  var erBgRows = [];   // 救急ローテ列に色を付ける行
  var pedBgRows = [];  // 小児ローテ列に色を付ける行

  for (var d = 0; d < ctx.daysInMonth; d++) {
    var day = ctx.days[d];
    var aId = result.assignments.byDay[d].A;
    var bId = result.assignments.byDay[d].B;
    var aName = aId ? ctx.memberMap[aId].name : '';
    var bName = bId ? ctx.memberMap[bId].name : '';

    // この日にローテ中のメンバーを集める
    var erNames = [];
    var pedNames = [];
    if (ctx.rotationDaysGlobal) {
      ctx.memberIds.forEach(function (mid) {
        var rotMap = ctx.rotationDaysGlobal[mid];
        if (rotMap && rotMap[d]) {
          var nm = ctx.memberMap[mid].name;
          if (rotMap[d] === ROTATION_LABEL.ER) erNames.push(nm);
          else if (rotMap[d] === ROTATION_LABEL.PED) pedNames.push(nm);
        }
      });
    }

    rows.push([
      day.date,
      day.weekdayLabel,
      day.isHoliday ? '祝' : '',
      aName,
      bName,
      erNames.join(', '),
      pedNames.join(', ')
    ]);

    var rowNumber = d + 3;  // タイムスタンプ + ヘッダー + (d+1)
    if (day.isWeekendOrHoliday) weekendRows.push(rowNumber);
    if (erNames.length > 0)  erBgRows.push(rowNumber);
    if (pedNames.length > 0) pedBgRows.push(rowNumber);
  }
  sheet.getRange(3, 1, rows.length, header.length).setValues(rows);

  // 土日祝の背景色（A〜B 列まで＝1〜5列。ローテ列は別色を使う）
  weekendRows.forEach(function (r) {
    sheet.getRange(r, 1, 1, 5).setBackground(COLOR.WEEKEND_BG);
  });

  // ローテ列の背景色
  erBgRows.forEach(function (r) {
    sheet.getRange(r, 6).setBackground(COLOR.ROTATION_ER_BG);
  });
  pedBgRows.forEach(function (r) {
    sheet.getRange(r, 7).setBackground(COLOR.ROTATION_PED_BG);
  });

  // 列幅
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 50);
  sheet.setColumnWidth(3, 50);
  sheet.setColumnWidth(4, 140);
  sheet.setColumnWidth(5, 140);
  sheet.setColumnWidth(6, 180);
  sheet.setColumnWidth(7, 180);

  sheet.setFrozenRows(2);
  sheet.getRange(2, 1, ctx.daysInMonth + 1, header.length)
    .setBorder(true, true, true, true, true, true);
}

// ─────────────────────────────────────────────
// 集計シート
// ─────────────────────────────────────────────
function writeSummarySheet_(ctx, result) {
  var sheet = ensureSheet_(SHEET.SUMMARY);
  try { sheet.setFrozenRows(0); } catch (e) {}
  try { sheet.setFrozenColumns(0); } catch (e) {}
  try { sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart(); } catch (e) {}
  sheet.clear();
  sheet.clearFormats();

  var header = ['ID', '氏名', '目標', '実績', 'A', 'B', '土日祝', '平均間隔'];
  writeUpdatedAtRow_(sheet, header.length);
  sheet.getRange(2, 1, 1, header.length).setValues([header])
    .setFontWeight('bold')
    .setBackground(COLOR.HEADER_BG);

  var rows = result.stats.map(function (s) {
    return [
      s.memberId,
      s.name,
      s.target,
      s.total,
      s.A,
      s.B,
      s.weekend,
      s.avgGap === null ? '' : Math.round(s.avgGap * 10) / 10
    ];
  });
  if (rows.length > 0) {
    sheet.getRange(3, 1, rows.length, header.length).setValues(rows);
  }

  sheet.setColumnWidth(1, 60);
  sheet.setColumnWidth(2, 140);
  sheet.setFrozenRows(2);
  sheet.getRange(2, 1, rows.length + 1, header.length)
    .setBorder(true, true, true, true, true, true);

  // 目標との差が大きい行を強調
  for (var i = 0; i < result.stats.length; i++) {
    var s = result.stats[i];
    if (Math.abs(s.total - s.target) >= 2) {
      sheet.getRange(i + 3, 1, 1, header.length).setBackground(COLOR.ERROR_BG);
    }
  }
}

// ─────────────────────────────────────────────
// 個人別シート（行=メンバー、列=日付のクロス表）
// ─────────────────────────────────────────────
function writePersonalSheet_(ctx, result) {
  var sheet = ensureSheet_(SHEET.PERSONAL);
  // 前回の固定行・固定列・マージを全解除（タイムスタンプのマージが
  // 固定列(ID/氏名)と非固定列(日付)の境界をまたいでエラーになるのを防ぐ）
  try { sheet.setFrozenRows(0); } catch (e) {}
  try { sheet.setFrozenColumns(0); } catch (e) {}
  try { sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart(); } catch (e) {}
  sheet.clear();
  sheet.clearFormats();

  var nCols = ctx.daysInMonth + 2;  // ID + 氏名 + 各日

  // 1行目: 最終更新タイムスタンプ
  // splitAt=2 で「ID/氏名」と「日付列群」を別々にマージ
  //   後で setFrozenColumns(2) で col2と3の間を固定するため、
  //   境界をまたぐマージにならないように分割する必要がある
  writeUpdatedAtRow_(sheet, nCols, 2);

  // ヘッダー2行: 2行目=日付、3行目=曜日
  var header1 = ['ID', '氏名'];
  var header2 = ['', ''];
  for (var d = 0; d < ctx.daysInMonth; d++) {
    header1.push(d + 1);
    header2.push(ctx.days[d].weekdayLabel);
  }
  sheet.getRange(2, 1, 1, nCols).setValues([header1])
    .setFontWeight('bold').setBackground(COLOR.HEADER_BG)
    .setHorizontalAlignment('center');
  sheet.getRange(3, 1, 1, nCols).setValues([header2])
    .setBackground(COLOR.HEADER_BG)
    .setHorizontalAlignment('center');

  // 土日祝の列に色付け（曜日ヘッダー行＝行3）
  for (var d2 = 0; d2 < ctx.daysInMonth; d2++) {
    if (ctx.days[d2].isWeekendOrHoliday) {
      sheet.getRange(3, d2 + 3).setBackground(COLOR.WEEKEND_BG);
    }
  }

  // データ行
  var data = [];
  var bgColors = [];
  for (var i = 0; i < ctx.memberIds.length; i++) {
    var id = ctx.memberIds[i];
    var m = ctx.memberMap[id];
    var row = [id, m.name];
    var bgRow = ['', ''];
    var rotMap = (ctx.rotationDaysGlobal && ctx.rotationDaysGlobal[id]) || null;
    var excludeMap = (ctx.excludedByMember && ctx.excludedByMember[id]) || {};
    for (var d3 = 0; d3 < ctx.daysInMonth; d3++) {
      var slot = result.assignments.byDay[d3];
      var rotType = rotMap ? rotMap[d3] : null;
      var isExcluded = !!excludeMap[d3];
      if (slot.A === id) {
        row.push('A');
        bgRow.push(COLOR.SHIFT_A_BG);
      } else if (slot.B === id) {
        row.push('B');
        bgRow.push(COLOR.SHIFT_B_BG);
      } else if (rotType === ROTATION_LABEL.ER) {
        // 救急ローテ中：略号「救」＋オレンジ背景
        row.push('救');
        bgRow.push(COLOR.ROTATION_ER_BG);
      } else if (rotType === ROTATION_LABEL.PED) {
        // 小児ローテ中：略号「小」＋パープル背景
        row.push('小');
        bgRow.push(COLOR.ROTATION_PED_BG);
      } else if (isExcluded) {
        // 除外申請日：「×」＋クリーム背景
        row.push('×');
        bgRow.push(COLOR.EXCLUDE_BG);
      } else {
        row.push('');
        bgRow.push(ctx.days[d3].isWeekendOrHoliday ? COLOR.WEEKEND_BG : null);
      }
    }
    data.push(row);
    bgColors.push(bgRow);
  }
  if (data.length > 0) {
    sheet.getRange(4, 1, data.length, nCols).setValues(data)
      .setHorizontalAlignment('center');
    sheet.getRange(4, 1, data.length, nCols).setBackgrounds(bgColors);
  }

  // 列幅
  sheet.setColumnWidth(1, 60);
  sheet.setColumnWidth(2, 120);
  for (var d4 = 0; d4 < ctx.daysInMonth; d4++) {
    sheet.setColumnWidth(d4 + 3, 30);
  }

  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(2);
  sheet.getRange(2, 1, data.length + 2, nCols)
    .setBorder(true, true, true, true, true, true);
}

// ─────────────────────────────────────────────
// ログ追記
// ─────────────────────────────────────────────
function appendLog_(ctx, result) {
  var sheet = ensureSheet_(SHEET.LOG);
  // ヘッダー初期化
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 3).setValues([['実行時刻', '対象月', '結果サマリ']])
      .setFontWeight('bold').setBackground(COLOR.HEADER_BG);
  }
  var ym = ctx.year + '-' + pad2_(ctx.month);
  var summary = result.status + ' / score=' + result.score +
    ' / hardViolations=' + result.hardViolations.length +
    ' / elapsedMs=' + result.elapsedMs;
  if (result.hardViolations.length > 0) {
    summary += ' / 違反: ' + result.hardViolations.slice(0, 5).join(', ');
    if (result.hardViolations.length > 5) summary += ' ...他' + (result.hardViolations.length - 5);
  }
  sheet.appendRow([new Date(), ym, summary]);
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

// ─────────────────────────────────────────────
// シート確保（存在しなければ末尾に追加）
// ─────────────────────────────────────────────
function ensureSheet_(name) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}
