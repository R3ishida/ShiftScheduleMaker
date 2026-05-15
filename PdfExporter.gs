/**
 * PdfExporter.gs
 * カレンダーシート（任意で集計・個人別シート）をPDFとしてDriveに保存する。
 *
 * 仕組み：Google Sheets の export?format=pdf エンドポイントを UrlFetchApp で叩き、
 * 取得したバイナリを Drive に保存する。サービスアカウント不要、ユーザー権限で動く。
 */

function exportPdfsToDrive(targetYearMonth, folderId) {
  var ss = SpreadsheetApp.getActive();
  var ssId = ss.getId();

  // 出力先フォルダ
  var folder;
  if (folderId) {
    folder = DriveApp.getFolderById(folderId);
  } else {
    // フォルダ未指定なら、Spreadsheet と同じ場所
    var parents = DriveApp.getFileById(ssId).getParents();
    folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  }

  var ym = targetYearMonth;  // 'YYYY-MM'

  // カレンダーシートのみPDF化（メインの配布物）
  var calSheet = ss.getSheetByName(SHEET.CALENDAR);
  if (!calSheet) throw new Error('カレンダーシートがありません');

  var pdfBlob = exportSheetAsPdfBlob_(ssId, calSheet.getSheetId(), 'シフト表_' + ym + '.pdf');
  var savedFile = folder.createFile(pdfBlob);
  return {
    fileId: savedFile.getId(),
    fileName: savedFile.getName(),
    folderName: folder.getName()
  };
}

/**
 * 指定のシートをPDFとしてエクスポートする。
 */
function exportSheetAsPdfBlob_(spreadsheetId, sheetId, fileName) {
  var url = 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/export';
  var params = {
    format: 'pdf',
    gid: sheetId,
    portrait: false,        // 横向き
    size: 'A4',
    fitw: true,             // 幅にフィット
    sheetnames: false,
    printtitle: false,
    pagenumbers: false,
    gridlines: true,
    fzr: true,              // 凍結行を各ページに繰り返す
    horizontal_alignment: 'CENTER',
    vertical_alignment: 'TOP',
    top_margin: 0.5,
    bottom_margin: 0.5,
    left_margin: 0.5,
    right_margin: 0.5
  };
  var query = Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');

  var token = ScriptApp.getOAuthToken();
  var response = UrlFetchApp.fetch(url + '?' + query, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('PDF エクスポート失敗: HTTP ' + response.getResponseCode());
  }
  return response.getBlob().setName(fileName);
}
