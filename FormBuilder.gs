/**
 * FormBuilder.gs
 * Google Form を GAS から自動生成・更新する。
 *
 * 機能:
 *   - 「シフト除外日申請」フォームを新規作成 or 既存Formを当月分に更新
 *   - 設問4つ（氏名 / 除外希望日 / 備考 / 年末年始希望）を自動配置
 *   - 「除外希望日」は対象月の全日をチェックボックスで列挙（表記ゆれ防止）
 *   - 土日・祝日には（土）（日）祝マーク付き
 *   - 回答先を現在の Spreadsheet の「申請」シートに紐付け
 *   - メールアドレス自動収集を ON
 *   - 生成済み Form ID を Document Properties に保存
 *
 * 対象月は「設定」シートの「対象年月」を参照する。
 * 対象月が変わったら、再度メニュー「申請Formを作成/更新」を実行することで、
 * 同じFormの選択肢を新しい月に張り替えられる。
 */

// ─────────────────────────────────────────────
// Form 設問タイトル（出力シートの列ヘッダーになる）
// ─────────────────────────────────────────────
var FORM_TITLE_BASE = 'シフト除外日申請';
var FORM_QUESTIONS = {
  NAME: '氏名',           // 値はメンバーマスタから生成した「ID 氏名」のドロップダウン
  ROTATION: '特殊ローテーション',
  ROTATION_FROM: 'ローテ開始日（期間限定の場合のみ）',
  ROTATION_TO: 'ローテ終了日（期間限定の場合のみ）',
  EXCLUDE_DATES: '除外希望日'
};

// ─────────────────────────────────────────────
// メイン関数（メニューから呼ばれる）
// ─────────────────────────────────────────────
function createApplicationForm() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActive();

  // 対象月を取得
  var config;
  try { config = loadConfig(); }
  catch (e) {
    ui.alert('設定シートが未設定です', '先に「設定シートを既定値で埋める」を実行してください。\n\n' + e, ui.ButtonSet.OK);
    return;
  }
  var year = config.targetYearMonth.year;
  var month = config.targetYearMonth.month;
  var ymLabel = year + '年' + month + '月';

  // メンバーマスタを取得（ID選択肢の元）
  var members;
  try { members = loadMembers(); }
  catch (e) {
    ui.alert('メンバーマスタ未登録', '先に「メンバー」シートにメンバーを登録してください。\n\n' + e, ui.ButtonSet.OK);
    return;
  }
  if (members.length === 0) {
    ui.alert('「メンバー」シートにメンバーを登録してから Form を作成してください');
    return;
  }

  // 既存 Form を取得 or 新規作成
  var props = PropertiesService.getDocumentProperties();
  var existingId = props.getProperty('APPLICATION_FORM_ID');
  var form = null;
  var isUpdate = false;
  if (existingId) {
    try {
      form = FormApp.openById(existingId);
      isUpdate = true;
    } catch (e) {
      form = null;
    }
  }

  if (form) {
    var resp = ui.alert(
      '申請Formの更新',
      '既存のFormを「' + ymLabel + '」分に更新します。\n' +
      '（タイトル・設問・選択肢を当月用に張り替えます。回答済みデータは「申請」シートに残ります。）\n\n' +
      '続行しますか？',
      ui.ButtonSet.YES_NO
    );
    if (resp !== ui.Button.YES) return;
  } else {
    form = FormApp.create(FORM_TITLE_BASE);
    form.setShowLinkToRespondAgain(true);
    form.setAllowResponseEdits(true);
    form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
    isUpdate = false;
    // 新規作成 Form を Spreadsheet と同じフォルダに移動
    moveFileToSpreadsheetFolder_(form.getId());
  }

  // メアド収集は無効化（新規・更新どちらでも適用）
  form.setCollectEmail(false);

  // タイトル・説明・確認メッセージを設定
  form.setTitle(FORM_TITLE_BASE + '（' + ymLabel + '）');
  form.setDescription(buildFormDescription_(year, month));
  form.setConfirmationMessage(
    '申請を受け付けました（' + ymLabel + '）。\n' +
    '管理者がシフトを確定後、別途共有されます。'
  );

  // 既存の設問を全削除（更新時）
  var oldItems = form.getItems();
  for (var i = oldItems.length - 1; i >= 0; i--) {
    form.deleteItem(oldItems[i]);
  }

  // 設問1: 氏名（ID付きドロップダウン）
  var memberChoices = members.map(function (m) {
    return m.id + ' ' + m.name;
  });
  form.addListItem()
    .setTitle(FORM_QUESTIONS.NAME)
    .setHelpText('自分の名前を選択してください')
    .setChoiceValues(memberChoices)
    .setRequired(true);

  // 設問2: 特殊ローテーション（救急／小児）
  form.addMultipleChoiceItem()
    .setTitle(FORM_QUESTIONS.ROTATION)
    .setHelpText(
      '当月の救急／小児ローテーション状況を選択してください。\n' +
      'ローテ中の期間は当直に入りません。'
    )
    .setChoiceValues([
      ROTATION.NONE,
      ROTATION.ER_FULL,
      ROTATION.PED_FULL,
      ROTATION.ER_PARTIAL,
      ROTATION.PED_PARTIAL
    ])
    .setRequired(true);

  // 設問3: ローテ開始日（期間限定の場合のみ・デートピッカー）
  form.addDateItem()
    .setTitle(FORM_QUESTIONS.ROTATION_FROM)
    .setHelpText('期間限定ローテの場合のみ選択。月全体／なしの場合は空のまま。')
    .setIncludesYear(true)
    .setRequired(false);

  // 設問4: ローテ終了日（期間限定の場合のみ・デートピッカー）
  form.addDateItem()
    .setTitle(FORM_QUESTIONS.ROTATION_TO)
    .setHelpText('期間限定ローテの場合のみ選択。月全体／なしの場合は空のまま。')
    .setIncludesYear(true)
    .setRequired(false);

  // 設問5: 除外希望日（チェックボックス・任意）
  var holidays = loadHolidays(year, month);
  var choices = buildDateChoices_(year, month, holidays);
  form.addCheckboxItem()
    .setTitle(FORM_QUESTIONS.EXCLUDE_DATES)
    .setHelpText(
      '当直に入れない日にチェックを入れてください（該当なしなら空のまま）。\n' +
      '【ルール】最大5日、うち土日祝は3日まで、GW期間は連続3日以上不可'
    )
    .setChoiceValues(choices)
    .setRequired(false);

  // 回答先シート名を「申請」に
  Utilities.sleep(1500);
  renameFormResponseSheetTo_(SHEET.REQUESTS);

  // Form ID 保存
  props.setProperty('APPLICATION_FORM_ID', form.getId());

  // 結果ダイアログ
  var publicUrl = form.getPublishedUrl();
  var editUrl = form.getEditUrl();
  ui.alert(
    isUpdate ? '申請Formを更新しました' : '申請Formを作成しました',
    '対象月: ' + ymLabel + '\n\n' +
    '✅ 配布URL（メンバーに共有）:\n' + publicUrl + '\n\n' +
    '✏️ 編集URL（管理者用）:\n' + editUrl + '\n\n' +
    '回答は「' + SHEET.REQUESTS + '」シートに自動連携されます。',
    ui.ButtonSet.OK
  );
}

// ─────────────────────────────────────────────
// 対象月の全日付を選択肢として生成
//   フォーマット例: "2026-06-01（月）" / "2026-06-06（土）" / "2026-06-08（月）祝"
// ─────────────────────────────────────────────
function buildDateChoices_(year, month, holidays) {
  var daysInMonth = new Date(year, month, 0).getDate();
  var weekdays = '日月火水木金土';
  var choices = [];
  for (var d = 0; d < daysInMonth; d++) {
    var date = new Date(year, month - 1, d + 1);
    var ds = formatDate_(date);
    var w = weekdays.charAt(date.getDay());
    var label = ds + '（' + w + '）';
    if (holidays && holidays[ds]) label += '祝';
    choices.push(label);
  }
  return choices;
}

// ─────────────────────────────────────────────
// Form の説明文
// ─────────────────────────────────────────────
function buildFormDescription_(year, month) {
  var ymLabel = year + '年' + month + '月';
  return '【' + ymLabel + '】の当直シフト申請フォームです。\n\n' +
    '■ 入力項目\n' +
    '・氏名（必須）\n' +
    '・特殊ローテーション（必須）\n' +
    '   救急／小児ローテ中の方は対象期間中は当直に入りません。\n' +
    '・ローテ開始日／終了日（期間限定ローテの場合のみ）\n' +
    '・除外希望日（任意・該当なしなら空のまま）\n\n' +
    '■ 除外希望日のルール\n' +
    '・最大5日まで\n' +
    '・うち土日祝は3日まで\n' +
    '・GW期間（4/29〜5/5）は連続3日以上不可\n\n' +
    '※ 違反した申請は、シフト確定時にチェックされ管理者から差し戻されます。';
}

// ─────────────────────────────────────────────
// Form 回答先シートを「申請」にリネーム
// ─────────────────────────────────────────────
function renameFormResponseSheetTo_(targetName) {
  var ss = SpreadsheetApp.getActive();
  var sheets = ss.getSheets();
  var formSheet = null;
  for (var i = 0; i < sheets.length; i++) {
    try {
      if (sheets[i].getFormUrl()) {
        formSheet = sheets[i];
        break;
      }
    } catch (e) { /* 無視 */ }
  }
  if (!formSheet) return;
  if (formSheet.getName() === targetName) return;

  var existing = ss.getSheetByName(targetName);
  if (existing && existing !== formSheet) {
    var stamp = Utilities.formatDate(new Date(), DEFAULTS.TIMEZONE, 'yyyyMMddHHmmss');
    existing.setName(targetName + '_旧_' + stamp);
  }
  formSheet.setName(targetName);
}

// ─────────────────────────────────────────────
// 任意のファイルを Spreadsheet と同じフォルダへ移動する
//   FormApp.create() で生成された Form は既定で「マイドライブ」直下に置かれるため、
//   Spreadsheet と同じ階層に揃えるために呼ぶ。
//   既に同じ親なら何もしない。
// ─────────────────────────────────────────────
function moveFileToSpreadsheetFolder_(fileId) {
  try {
    var ssFile = DriveApp.getFileById(SpreadsheetApp.getActive().getId());
    var ssParents = ssFile.getParents();
    if (!ssParents.hasNext()) return;  // Spreadsheet がルート直下なら移動不要
    var targetFolder = ssParents.next();
    var targetId = targetFolder.getId();

    var file = DriveApp.getFileById(fileId);
    // 既に同じ親フォルダにあるかチェック
    var currentParents = file.getParents();
    var alreadyThere = false;
    var oldParents = [];
    while (currentParents.hasNext()) {
      var p = currentParents.next();
      if (p.getId() === targetId) {
        alreadyThere = true;
      } else {
        oldParents.push(p);
      }
    }
    if (!alreadyThere) {
      targetFolder.addFile(file);
    }
    // 既存の他の親フォルダから外す（マイドライブ直下も含む）
    for (var i = 0; i < oldParents.length; i++) {
      try { oldParents[i].removeFile(file); } catch (e) { /* 無視 */ }
    }
  } catch (e) {
    Logger.log('moveFileToSpreadsheetFolder_ failed: ' + e);
  }
}

// ─────────────────────────────────────────────
// 「申請」シートを現在の Form 設問に合わせて再構築する。
//
// Google Form は設問を削除しても Spreadsheet の対応列を自動で消さないため、
// 設問変更の蓄積で余計な列が残っていく。これを掃除するためのメンテ機能。
//
// 動作:
//   1. 既存「申請」シートを「申請_旧_YYYYMMDD_HHMMSS」にリネーム退避
//   2. Form の連携を解除 → 同じ Spreadsheet に再連携
//      → Form 現設問に合致した列構造の新「申請」シートが自動生成される
//   3. 新しいシート名を「申請」に整える
//
// 配布URLは変わらないため、メンバーへの再共有は不要。
// 古い回答データはアーカイブシートに残るので、必要なら手動で削除する。
// ─────────────────────────────────────────────
function resetRequestsSheet() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActive();
  var props = PropertiesService.getDocumentProperties();
  var formId = props.getProperty('APPLICATION_FORM_ID');
  if (!formId) {
    ui.alert(
      '申請Formが登録されていません',
      '先に「申請Formを作成/更新（対象月）」を実行してください。',
      ui.ButtonSet.OK
    );
    return;
  }

  var resp = ui.alert(
    '「申請」シートを再構築',
    '現在の「申請」シートを「申請_旧_YYYYMMDD_HHMMSS」にリネーム退避し、\n' +
    '現在のForm設問（氏名/除外希望日）に合った列構成で新しい「申請」シートを作り直します。\n\n' +
    '・Form の配布URLは変わりません（メンバーへの再共有は不要）\n' +
    '・古い回答データはアーカイブシートに残ります\n\n' +
    '続行しますか？',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  try {
    var form = FormApp.openById(formId);

    // 既存「申請」シートをリネーム退避
    var existing = ss.getSheetByName(SHEET.REQUESTS);
    var archivedName = null;
    if (existing) {
      var stamp = Utilities.formatDate(new Date(), DEFAULTS.TIMEZONE, 'yyyyMMdd_HHmmss');
      archivedName = SHEET.REQUESTS + '_旧_' + stamp;
      existing.setName(archivedName);
    }

    // Form の連携を解除 → 同じ Spreadsheet に再連携
    try {
      form.removeDestination();
    } catch (e) {
      // removeDestination が無いランタイムでも setDestination で上書きできる
      Logger.log('removeDestination skipped: ' + e);
    }
    Utilities.sleep(1000);
    form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
    Utilities.sleep(1500);
    renameFormResponseSheetTo_(SHEET.REQUESTS);

    ui.alert(
      '再構築完了',
      '「申請」シートを現在のForm設問に合わせて作り直しました。\n\n' +
      (archivedName ? '退避先: ' + archivedName + '\n' : '') +
      '配布URL は変わっていないので、メンバーへの再共有は不要です。',
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('エラー', String(e) + (e.stack ? '\n\n' + e.stack : ''), ui.ButtonSet.OK);
    Logger.log(e);
  }
}

// ─────────────────────────────────────────────
// Form の紐付け解除（メンテ用）
// ─────────────────────────────────────────────
function deleteApplicationForm() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getDocumentProperties();
  var formId = props.getProperty('APPLICATION_FORM_ID');
  if (!formId) {
    ui.alert('申請Formは登録されていません');
    return;
  }
  var resp = ui.alert(
    '申請Formの紐付けを解除',
    'スクリプトからの紐付けを解除します（Form 自体は Drive に残ります）。続行しますか？',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  props.deleteProperty('APPLICATION_FORM_ID');
  ui.alert('紐付けを解除しました。Form 自体は Drive にあります。');
}
