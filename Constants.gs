/**
 * Constants.gs
 * シート名・列番号・既定パラメータ・固定文字列をまとめて定義
 */

// ─────────────────────────────────────────────
// シート名
// ─────────────────────────────────────────────
var SHEET = {
  MEMBERS: 'メンバー',
  REQUESTS: '申請',
  PREV_ACTUAL: '前月実績',
  HOLIDAYS: '祝日',
  CONFIG: '設定',
  TARGET_TABLE: '目標回数',
  CALENDAR: 'カレンダー',
  SUMMARY: '集計',
  PERSONAL: '個人別',
  LOG: 'ログ',
  CONFIRMED_SHIFT: '確定シフト',      // ← 新規：確定シフト
  HISTORY: '履歴',                     // ← 新規：過去データ履歴
  STATISTICS: '統計'                   // ← 新規：統計情報
};

// ─────────────────────────────────────────────
// 列番号（1始まり）
// ─────────────────────────────────────────────
var COL_MEMBER = {
  ID: 1,
  NAME: 2,
  AVAIL_FROM: 3,
  AVAIL_TO: 4
};

var COL_REQUEST = {
  TIMESTAMP: 1,
  NAME: 2,
  EXCLUDE_DATES: 3,
  NOTE: 4,
  HOLIDAY_PREF: 5
};

var COL_PREV = {
  DATE: 1,
  WEEKDAY: 2,
  A: 3,
  B: 4
};

var COL_HOLIDAY = {
  DATE: 1,
  NAME: 2
};

var COL_CONFIG = {
  KEY: 1,
  VALUE: 2
};

var COL_TARGET_TABLE = {
  MIN_DAYS: 1,   // 実効日下限（その値以上で適用）
  COUNT: 2       // 当直回数
};

var COL_CALENDAR = {
  DATE: 1,
  WEEKDAY: 2,
  HOLIDAY: 3,
  A: 4,
  B: 5
};

var COL_SUMMARY = {
  ID: 1,
  NAME: 2,
  TARGET: 3,
  TOTAL: 4,
  A: 5,
  B: 6,
  WEEKEND: 7,
  AVG_GAP: 8
};

var COL_LOG = {
  TIME: 1,
  TARGET_MONTH: 2,
  RESULT: 3
};

// ─────────────────────────────────────────────
// 「確定シフト」列定義（新規）
// ─────────────────────────────────────────────
var COL_CONFIRMED = {
  DATE: 1,
  WEEKDAY: 2,
  A: 3,
  B: 4,
  NOTE: 5
};

// ─────────────────────────────────────────────
// 「履歴」列定義（新規）
// ─────────────────────────────────────────────
var COL_HISTORY = {
  YEAR_MONTH: 1,  // '2026-06' 形式
  DATE: 2,
  WEEKDAY: 3,
  A: 4,
  B: 5,
  UPDATED_AT: 6   // 最終更新日時
};

// ─────────────────────────────────────────────
// シフト種別
// ─────────────────────────────────────────────
var SHIFT_A = 'A';   // 準夜勤
var SHIFT_B = 'B';   // 夜勤
var SHIFTS = [SHIFT_A, SHIFT_B];

// ─────────────────────────────────────────────
// 既定パラメータ
// ─────────────────────────────────────────────
var DEFAULTS = {
  MIN_GAP_DAYS: 3,           // 中2日以上 = 連続3日窓内に1回まで
  WEEKEND_MAX: 1,            // 土日祝の月内割当上限
  MAX_PER_MONTH: 4,          // 月当直の上限（参考値、目標差ペナルティのみで使用）
  TARGET_CENTER: 3,          // 月当直の中心目標
  SHORT_GAP_WINDOW: 6,       // 短間隔ペナルティの窓（日）
  GREEDY_TRIES: 50,          // 貪欲法の試行回数
  LOCAL_SEARCH_LIMIT_SEC: 60,// 局所探索の上限秒
  RANDOM_SEED: 42,           // 乱数シード
  TIMEZONE: 'Asia/Tokyo',
  VALIDATE_REQUESTS: true    // 申請チェックの実施（イベント月などは OFF にする）
};

// ─────────────────────────────────────────────
// JSON 保存設定（新規）
// ─────────────────────────────────────────────
var JSON_CONFIG = {
  FOLDER_NAME: 'ShiftScheduleMaker_Data',  // Drive 内のフォルダ名
  FILE_PREFIX: 'shift_data_',              // ファイル名プレフィックス
  OVERWRITE: true                          // 同名ファイルがあれば上書き
};

// ─────────────────────────────────────────────
// ソフト目的の重み
// ─────────────────────────────────────────────
var WEIGHT = {
  TARGET_DIFF: 100,
  AB_BALANCE: 50,
  SHORT_GAP: 5
};

// ─────────────────────────────────────────────
// 色（書式設定）
// ─────────────────────────────────────────────
var COLOR = {
  HEADER_BG: '#cccccc',
  HEADER_FG: '#000000',
  WEEKEND_BG: '#fde0e0',
  HOLIDAY_BG: '#fde0e0',
  SHIFT_A_BG: '#d4edda',  // 緑
  SHIFT_B_BG: '#cce5ff',  // 青
  ERROR_BG: '#ffcccc',
  ROTATION_ER_BG:  '#ffe4cc',  // 救急ローテ
  ROTATION_PED_BG: '#e8d4f5',  // 小児ローテ
  EXCLUDE_BG:      '#fff2cc'   // 除外希望日（申請による）
};

// ─────────────────────────────────────────────
// 特殊ローテーション（救急／小児）
// ─────────────────────────────────────────────
var ROTATION = {
  NONE: 'なし',
  ER_FULL: '月全体が救急',
  PED_FULL: '月全体が小児',
  ER_PARTIAL: '期間限定で救急',
  PED_PARTIAL: '期間限定で小児'
};

// 表示用ラベル（カレンダー用）
var ROTATION_LABEL = {
  ER:  '救急',
  PED: '小児'
};

// ローテ期間の前後にあける日数（連続する負荷を避けるための緩衝）
//   ローテ最終日の翌日から ROTATION_GAP_DAYS 日間は当直不可
//   ローテ初日の前日から ROTATION_GAP_DAYS 日間は当直不可
var ROTATION_GAP_DAYS = 3;

// ─────────────────────────────────────────────
// 日本の祝日カレンダー ID（CalendarApp 用）
// ─────────────────────────────────────────────
var JAPAN_HOLIDAY_CALENDAR_ID = 'ja.japanese.official#holiday@group.v.calendar.google.com';
