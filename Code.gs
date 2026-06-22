/**
 * Code.gs
 * メニューUIとエントリポイント。
 *
 * メニュー「シフト表」:
 *   【生成】
 *   - 当月分を生成
 *   - 任意月を生成（プロンプトで年月入力）
 *
 *   【確定シフト操作】← 新規
 *   - 確定シフトから再生成（手動編集後の反映）
 *   - 確定シフトを JSON に保存
 *   - JSON から確定シフトを復元
 *
 *   【出力】
 *   - PDF を Drive に保存
 *   - JSON バックアップを作成
 *
 *   【申請管理】
 *   - 申請を再チェック
 *   - 申請Formを作成/更新（対象月）
 *   - 申請シートを再構築
 *
 *   【設定】
 *   - テンプレシートを初期化（初回のみ）
 *   - 設定シートを既定値で埋める
 *   - 設定シートの不足キーを補う
 */

// ─────────────────────────────────────────────
// 開いたときにメニューを差し込む
// ─────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('シフト表')
    .addItem('当月分を生成', 'menuGenerateCurrent')
    .addItem('任意の月を生成…', 'menuGenerateForMonth')
    .addSeparator()
    .addItem('確定シフトから再生成', 'menuRegenerateFromConfirmed')
    .addItem('確定シフトを JSON に保存', 'menuSaveConfirmedAsJson')
    .addItem('JSON から確定シフトを復元', 'menuLoadConfirmedFromJson')
    .addSeparator()
    .addItem('申請を再チェック', 'menuValidateRequests')
    .addItem('PDF を Drive に保存', 'menuExportPdf')
    .addItem('JSON バックアップを作成', 'menuBackupAllAsJson')
    .addSeparator()
    .addItem('統計を生成', 'menuGenerateStatistics')
    .addItem('統計ダッシュボードを表示', 'menuShowStatisticsDashboard')
    .addSeparator()
    .addItem('テンプレシートを初期化（初回のみ）', 'menuInitTemplates')
    .addItem('申請Formを作成/更新（対象月）', 'menuCreateApplicationForm')
    .addItem('申請シートを再構築', 'menuResetRequestsSheet')
    .addItem('設定シートを既定値で埋める', 'menuFillDefaults')
    .addItem('設定シートの不足キーを補う', 'menuAddMissingConfigKeys')
    .addToUi();
}

// FormBuilder へのラッパー
function menuCreateApplicationForm() {
  createApplicationForm();
}

function menuResetRequestsSheet() {
  resetRequestsSheet();
}

// 申請の手動再チェック
function menuValidateRequests() {
  var ui = SpreadsheetApp.getUi();
  try {
    // 設定で OFF になっていてもメニューから手動実行されたなら走らせるが、注意書きを添える
    var note = '';
    try {
      var cfg = loadConfig();
      if (cfg && cfg.validateRequests === false) {
        note = '\n\n（設定シートでは「申請チェック=OFF」になっています。生成時には自動でスキップされます。）';
      }
    } catch (e) { /* 無視 */ }

    var violations = validateAllRequests();
    if (violations.length === 0) {
      ui.alert('申請チェック', '✅ 違反は見つかりませんでした。' + note, ui.ButtonSet.OK);
    } else {
      var msg = '⚠ ' + violations.length + ' 件の違反が見つかりました。\n（該当行は赤背景でマーキング）\n\n';
      msg += violations.slice(0, 10).map(function (v) {
        return '・' + v.name + ': ' + v.errors.join(', ');
      }).join('\n');
      if (violations.length > 10) msg += '\n…他 ' + (violations.length - 10) + ' 件';
      ui.alert('申請チェック', msg + note, ui.ButtonSet.OK);
    }
  } catch (e) {
    ui.alert('エラー', String(e), ui.ButtonSet.OK);
  }
}

// ─────────────────────────────────────────────
// メニューハンドラ
// ─────────────────────────────────────────────
function menuGenerateCurrent() {
  var cfg = loadConfig();
  generateSchedule_(cfg.targetYearMonth.year, cfg.targetYearMonth.month);
}

function menuGenerateForMonth() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('対象年月を入力してください', '例: 2026-06', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var ym = parseYearMonth_(resp.getResponseText());
  generateSchedule_(ym.year, ym.month);
}

function menuExportPdf() {
  var ui = SpreadsheetApp.getUi();
  var cfg = loadConfig();
  try {
    var ym = cfg.targetYearMonth.year + '-' + pad2_(cfg.targetYearMonth.month);
    var info = exportPdfsToDrive(ym, cfg.pdfFolderId);
    ui.alert('PDF 出力完了',
      'ファイル: ' + info.fileName + '\nフォルダ: ' + info.folderName,
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('PDF 出力に失敗しました', String(e), ui.ButtonSet.OK);
  }
}

// ─────────────────────────────────────────────
// 確定シフト操作（新規）
// ─────────────────────────────────────────────
function menuRegenerateFromConfirmed() {
  var ui = SpreadsheetApp.getUi();
  var cfg = loadConfig();
  var year = cfg.targetYearMonth.year;
  var month = cfg.targetYearMonth.month;

  try {
    // 確定シフトを読み込み
    var confirmedAssignments = loadConfirmedShifts();
    if (!confirmedAssignments) {
      ui.alert('エラー', '「確定シフト」シートにデータがありません', ui.ButtonSet.OK);
      return;
    }

    // コンテキストを構築（前月実績などは通常通り）
    var members = loadMembers();
    var prevAssignments = loadPrevAssignments();
    var holidays = loadHolidays(year, month);
    var targetTable = loadTargetTable();

    // 確定シフトのデータから最小限のコンテキストを構築
    var ctx = buildContextForConfirmedShift_(year, month, members, holidays);

    // 確定シフト用の結果オブジェクトを作成
    var result = {
      status: 'OK',
      assignments: confirmedAssignments,
      stats: computeStats_(ctx, { byMember: buildByMemberFromAssignments_(confirmedAssignments, ctx) }),
      score: 0,
      hardViolations: [],
      elapsedMs: 0,
      ctx: ctx
    };

    // 出力を書き込み（確定シフトは上書きしない）
    writeCalendarSheet_(ctx, result);
    writeSummarySheet_(ctx, result);
    writePersonalSheet_(ctx, result);
    appendLog_(ctx, result);

    ui.alert('再生成完了', 'カレンダー・集計・個人別を確定シフトから再生成しました。', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('エラー', String(e) + (e.stack ? '\n\n' + e.stack : ''), ui.ButtonSet.OK);
    Logger.log(e);
  }
}

function menuSaveConfirmedAsJson() {
  var ui = SpreadsheetApp.getUi();
  var cfg = loadConfig();
  var ym = cfg.targetYearMonth.year + '-' + pad2_(cfg.targetYearMonth.month);

  try {
    var result = saveConfirmedShiftAsJson(ym);
    ui.alert('保存完了',
      'ファイル: ' + result.fileName + '\n' +
      '記録数: ' + result.recordCount,
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('エラー', String(e), ui.ButtonSet.OK);
  }
}

function menuLoadConfirmedFromJson() {
  var ui = SpreadsheetApp.getUi();
  var cfg = loadConfig();
  var ym = cfg.targetYearMonth.year + '-' + pad2_(cfg.targetYearMonth.month);

  try {
    var result = loadConfirmedShiftFromJson(ym);
    ui.alert('復元完了',
      '対象月: ' + result.yearMonth + '\n' +
      '記録数: ' + result.recordCount,
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('エラー', String(e), ui.ButtonSet.OK);
  }
}

function menuBackupAllAsJson() {
  var ui = SpreadsheetApp.getUi();
  var cfg = loadConfig();
  var ym = cfg.targetYearMonth.year + '-' + pad2_(cfg.targetYearMonth.month);

  try {
    backupAllAsJson(ym);
    ui.alert('バックアップ完了', '確定シフトと履歴を JSON に保存しました。', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('エラー', String(e), ui.ButtonSet.OK);
  }
}

// ─────────────────────────────────────────────
// 統計機能（新規）
// ─────────────────────────────────────────────
function menuGenerateStatistics() {
  generateStatistics();
}

function menuShowStatisticsDashboard() {
  var ui = SpreadsheetApp.getUi();
  try {
    var html = HtmlService.createHtmlOutput(
      '<p style="text-align:center;padding:20px;font-size:16px;">ダッシュボードを開いています...</p>'
    ).setWidth(100).setHeight(50);
    ui.showModalDialog(html, 'ダッシュボード');

    // 実際には、Web App として作成する別の方法を使用
    // または、新しいウィンドウで以下の URL にアクセス:
    var currentUrl = ScriptApp.getService().getUrl();
    var msg = 'HTML ダッシュボードを開きます。\n\n以下の URL にアクセスしてください：\n\n' +
              currentUrl + '\n\n（ブラウザの新規タブで開かれます）';

    ui.alert('統計ダッシュボード', msg, ui.ButtonSet.OK);
  } catch (e) {
    var ui = SpreadsheetApp.getUi();
    ui.alert('エラー', String(e), ui.ButtonSet.OK);
  }
}

function menuInitTemplates() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('テンプレシートを初期化',
    'メンバー / 申請 / 前月実績 / 祝日 / 設定 シートのヘッダーを再作成します。\n既存データは消えません（ヘッダー行のみ書き換え）。続行しますか？',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  initTemplateSheets_();
  ui.alert('テンプレシートを初期化しました');
}

// 既存の値を保持したまま、抜けている設定キーだけを末尾に追記する
function menuAddMissingConfigKeys() {
  var ui = SpreadsheetApp.getUi();
  var sh = ensureSheet_(SHEET.CONFIG);
  // 既存キー一覧
  var lastRow = sh.getLastRow();
  var existingKeys = {};
  if (lastRow >= 2) {
    var existing = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    existing.forEach(function (r) {
      var k = String(r[0] || '').trim();
      if (k) existingKeys[k] = true;
    });
  } else if (lastRow === 0) {
    // ヘッダーすら無ければ作る
    sh.getRange(1, 1, 1, 2).setValues([['キー', '値']])
      .setFontWeight('bold').setBackground(COLOR.HEADER_BG);
    sh.setColumnWidth(1, 200);
    sh.setColumnWidth(2, 250);
  }

  var allDefaults = [
    ['対象年月', '2026-06'],
    ['最小間隔（日）', DEFAULTS.MIN_GAP_DAYS],
    ['土日祝上限（人/月）', DEFAULTS.WEEKEND_MAX],
    ['月当直回数 上限', DEFAULTS.MAX_PER_MONTH],
    ['月当直回数 中心', DEFAULTS.TARGET_CENTER],
    ['短間隔ペナルティ窓（日）', DEFAULTS.SHORT_GAP_WINDOW],
    ['PDF出力先フォルダID', ''],
    ['試行回数（貪欲）', DEFAULTS.GREEDY_TRIES],
    ['局所探索 上限秒数', DEFAULTS.LOCAL_SEARCH_LIMIT_SEC],
    ['ランダムシード', 'auto'],
    ['申請チェック', DEFAULTS.VALIDATE_REQUESTS ? 'ON' : 'OFF'],
    ['前月実績を履歴から自動抽出', 'OFF']
  ];
  var missing = allDefaults.filter(function (kv) { return !existingKeys[kv[0]]; });

  if (missing.length === 0) {
    ui.alert('設定の補完', '不足しているキーはありません。', ui.ButtonSet.OK);
    return;
  }
  // 末尾に追記
  var startRow = Math.max(2, sh.getLastRow() + 1);
  sh.getRange(startRow, 1, missing.length, 2).setValues(missing);
  ui.alert(
    '設定の補完',
    '以下のキーを末尾に追記しました（既存の値はそのまま）：\n\n・' +
      missing.map(function (kv) { return kv[0]; }).join('\n・'),
    ui.ButtonSet.OK
  );
}

function menuFillDefaults() {
  var sh = ensureSheet_(SHEET.CONFIG);
  sh.clear();
  var rows = [
    ['キー', '値'],
    ['対象年月', '2026-06'],
    ['最小間隔（日）', DEFAULTS.MIN_GAP_DAYS],
    ['土日祝上限（人/月）', DEFAULTS.WEEKEND_MAX],
    ['月当直回数 上限', DEFAULTS.MAX_PER_MONTH],
    ['月当直回数 中心', DEFAULTS.TARGET_CENTER],
    ['短間隔ペナルティ窓（日）', DEFAULTS.SHORT_GAP_WINDOW],
    ['PDF出力先フォルダID', ''],
    ['試行回数（貪欲）', DEFAULTS.GREEDY_TRIES],
    ['局所探索 上限秒数', DEFAULTS.LOCAL_SEARCH_LIMIT_SEC],
    ['ランダムシード', 'auto'],
    ['申請チェック', DEFAULTS.VALIDATE_REQUESTS ? 'ON' : 'OFF'],
    ['前月実績を履歴から自動抽出', 'OFF']
  ];
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground(COLOR.HEADER_BG);
  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(2, 250);
}

// ─────────────────────────────────────────────
// メイン処理
// ─────────────────────────────────────────────
function generateSchedule_(year, month) {
  var ui = SpreadsheetApp.getUi();
  try {
    // 過去月シートを自動統合（YYYY-MM形式のシートから履歴に追加）
    autoIntegratePastMonthData();

    // 設定を先に読み、申請チェックの実施可否を決める
    var config = loadConfig();
    config.targetYearMonth = { year: year, month: month };

    // 申請バリデーション（設定で OFF にされていればスキップ）
    if (config.validateRequests) {
      SpreadsheetApp.getActive().toast('申請をチェック中…', 'シフト振り分け', 3);
      var violations = [];
      try { violations = validateAllRequests(); } catch (vErr) { Logger.log(vErr); }
      if (violations.length > 0) {
        var vMsg = '⚠ 申請に ' + violations.length + ' 件の違反が見つかりました（該当行は赤背景）。\n\n';
        vMsg += violations.slice(0, 5).map(function (v) {
          return '・' + v.name + ': ' + v.errors.join(', ');
        }).join('\n');
        if (violations.length > 5) vMsg += '\n…他 ' + (violations.length - 5) + ' 件';
        vMsg += '\n\nこのまま振り分けを続行しますか？\n（違反した申請も「除外希望日」として尊重されます）';
        var ans = ui.alert('申請に違反あり', vMsg, ui.ButtonSet.YES_NO);
        if (ans !== ui.Button.YES) return;
      }
    } else {
      SpreadsheetApp.getActive().toast('申請チェックは設定でOFFのためスキップ', 'シフト振り分け', 3);
    }

    SpreadsheetApp.getActive().toast('データ読込中…', 'シフト振り分け', 3);
    var members = loadMembers();
    var requests = loadRequests(members);
    var prevAssignments = loadPrevAssignments();
    var holidays = loadHolidays(year, month);
    var targetTable = loadTargetTable();

    SpreadsheetApp.getActive().toast('振り分け計算中…（最大' + config.localSearchLimitSec + '秒）', 'シフト振り分け', 5);
    var result = solveSchedule({
      year: year,
      month: month,
      members: members,
      requests: requests,
      prevAssignments: prevAssignments,
      holidays: holidays,
      config: config,
      targetTable: targetTable
    });

    SpreadsheetApp.getActive().toast('シートに書き出し中…', 'シフト振り分け', 3);
    writeAllOutputs(result);

    var msg = '対象月: ' + year + '-' + pad2_(month) + '\n';
    msg += '結果: ' + result.status + '\n';
    msg += 'スコア: ' + result.score + '\n';
    msg += '所要: ' + Math.round(result.elapsedMs / 100) / 10 + ' 秒\n';
    if (result.hardViolations.length > 0) {
      msg += '\n⚠ ハード制約違反: ' + result.hardViolations.length + ' 件\n';
      msg += result.hardViolations.slice(0, 3).join('\n');
      if (result.hardViolations.length > 3) msg += '\n…他' + (result.hardViolations.length - 3);
    } else {
      msg += '\n✅ ハード制約: 全件充足';
    }
    ui.alert('シフト生成完了', msg, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('エラー', String(e) + (e.stack ? '\n\n' + e.stack : ''), ui.ButtonSet.OK);
    Logger.log(e);
  }
}

// ─────────────────────────────────────────────
// テンプレシート初期化
// ─────────────────────────────────────────────
function initTemplateSheets_() {
  // メンバー
  var sh = ensureSheet_(SHEET.MEMBERS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 4).setValues([['ID', '氏名', '稼働開始日', '稼働終了日']])
      .setFontWeight('bold').setBackground(COLOR.HEADER_BG);
    sh.setColumnWidth(1, 60); sh.setColumnWidth(2, 160);
    sh.setColumnWidth(3, 110); sh.setColumnWidth(4, 110);
  }
  // 申請
  sh = ensureSheet_(SHEET.REQUESTS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 3).setValues([['タイムスタンプ', '氏名', '除外希望日']])
      .setFontWeight('bold').setBackground(COLOR.HEADER_BG);
    sh.setColumnWidth(1, 160); sh.setColumnWidth(2, 200); sh.setColumnWidth(3, 320);
  }
  // 前月実績
  sh = ensureSheet_(SHEET.PREV_ACTUAL);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 4).setValues([['日付', '曜日', 'A（準夜勤）', 'B（夜勤）']])
      .setFontWeight('bold').setBackground(COLOR.HEADER_BG);
    sh.setColumnWidth(1, 110); sh.setColumnWidth(2, 50);
    sh.setColumnWidth(3, 140); sh.setColumnWidth(4, 140);
  }
  // 祝日
  sh = ensureSheet_(SHEET.HOLIDAYS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 2).setValues([['日付', '名称']])
      .setFontWeight('bold').setBackground(COLOR.HEADER_BG);
    sh.setColumnWidth(1, 110); sh.setColumnWidth(2, 200);
  }
  // 設定（空なら既定値で埋める）
  if (!getSheetOrNull_(SHEET.CONFIG) || getSheetOrNull_(SHEET.CONFIG).getLastRow() === 0) {
    menuFillDefaults();
  }
  // 目標回数テーブル（空なら既定値で埋める）
  sh = ensureSheet_(SHEET.TARGET_TABLE);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 2).setValues([['実効日下限', '当直回数']])
      .setFontWeight('bold').setBackground(COLOR.HEADER_BG);
    sh.getRange(2, 1, 4, 2).setValues([
      [0,  0],
      [6,  1],
      [11, 2],
      [16, 3]
    ]);
    sh.setColumnWidth(1, 110);
    sh.setColumnWidth(2, 110);
  }
  // 出力シートの空テンプレ
  ensureSheet_(SHEET.CALENDAR);
  ensureSheet_(SHEET.SUMMARY);
  ensureSheet_(SHEET.PERSONAL);
  ensureSheet_(SHEET.LOG);
  ensureSheet_(SHEET.CONFIRMED_SHIFT);    // ← 新規
  ensureSheet_(SHEET.HISTORY);            // ← 新規
  ensureSheet_(SHEET.STATISTICS);         // ← 新規
}

// ─────────────────────────────────────────────
// ヘルパー関数
// ─────────────────────────────────────────────
function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function getSheetOrNull_(name) {
  return SpreadsheetApp.getActive().getSheetByName(name);
}

function ensureSheet_(name) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
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

// ─────────────────────────────────────────────
// 確定シフト用のコンテキスト構築（簡易版）
// ─────────────────────────────────────────────
function buildContextForConfirmedShift_(year, month, members, holidays) {
  var daysInMonth = new Date(year, month, 0).getDate();

  var days = [];
  for (var d = 0; d < daysInMonth; d++) {
    var date = new Date(year, month - 1, d + 1);
    var ds = Utilities.formatDate(date, DEFAULTS.TIMEZONE, 'yyyy-MM-dd');
    var weekday = date.getDay();
    var isHoliday = !!holidays[ds];
    var isWeekend = (weekday === 0 || weekday === 6);
    days.push({
      index: d,
      date: ds,
      weekday: weekday,
      weekdayLabel: '日月火水木金土'.charAt(weekday),
      isHoliday: isHoliday,
      isWeekend: isWeekend,
      isWeekendOrHoliday: isWeekend || isHoliday
    });
  }

  var memberMap = {};
  var memberIds = [];
  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    memberMap[m.id] = {
      id: m.id,
      name: m.name,
      availDays: {},
      availCount: daysInMonth
    };
    memberIds.push(m.id);
  }

  return {
    year: year,
    month: month,
    daysInMonth: daysInMonth,
    days: days,
    memberIds: memberIds,
    memberMap: memberMap,
    excludedByMember: {},
    rotationDaysGlobal: {},
    config: {}
  };
}

// ─────────────────────────────────────────────
// byDay → byMember に変換（簡易版）
// ─────────────────────────────────────────────
function buildByMemberFromAssignments_(assignments, ctx) {
  var byMember = {};
  ctx.memberIds.forEach(function (id) {
    byMember[id] = [];
  });

  for (var d = 0; d < assignments.byDay.length; d++) {
    var slot = assignments.byDay[d];
    if (slot.A) byMember[slot.A].push(d);
    if (slot.B) byMember[slot.B].push(d);
  }

  return byMember;
}
