/**
 * Solver.gs
 * 振り分けアルゴリズム本体。
 *
 * 入力（オブジェクト）:
 *   {
 *     year, month,
 *     members: [Member],
 *     requests: { name -> Request },
 *     prevAssignments: [PrevAssignment],
 *     holidays: { 'YYYY-MM-DD' -> true },
 *     config: Config
 *   }
 *
 * 出力:
 *   {
 *     status: 'OK' | 'INFEASIBLE',
 *     assignments: Map<dayIdx, {A: memberId, B: memberId}>,
 *     stats: [{ memberId, name, target, total, a, b, weekend, avgGap, minGap }],
 *     score: number,
 *     hardViolations: [string],
 *     elapsedMs: number
 *   }
 *
 * dayIdx は 0 始まり（当月1日 = 0、月末日 = daysInMonth - 1）。
 * 前月分は負の dayIdx で扱う（前月末日 = -1、その前日 = -2 ...）。
 */

function solveSchedule(input) {
  var startMs = (new Date()).getTime();
  var ctx = buildContext_(input);

  // Phase 1: 複数シードで貪欲構築 → ハード違反 0 の解を最優先採用
  var rng = makeRng_(ctx.config.randomSeed);
  var best = null;
  var bestScore = Infinity;
  var bestHardViols = null;
  var feasibleFound = false;

  var tries = ctx.config.greedyTries;
  for (var t = 0; t < tries; t++) {
    var sol = greedyConstruct_(ctx, rng);
    rescueZeroAssignments_(ctx, sol);   // 0回の人を1回以上に救済
    aggressiveRepair_(ctx, sol);        // 念のため再修復
    var hardViols = collectHardViolations_(ctx, sol);
    var score = evaluate_(ctx, sol);

    if (hardViols.length === 0) {
      // feasible 解：以後は feasible 解の中でスコア最小を採用
      if (!feasibleFound || score < bestScore) {
        feasibleFound = true;
        bestScore = score;
        best = sol;
        bestHardViols = hardViols;
      }
    } else if (!feasibleFound) {
      // まだ feasible が見つかってない期間中だけ「ハード違反少ない順」で更新
      var penalty = score + hardViols.length * 1e6;
      if (penalty < bestScore + (bestHardViols ? bestHardViols.length * 1e6 : Infinity)) {
        bestScore = score;
        best = sol;
        bestHardViols = hardViols;
      }
    }
  }

  // Phase 2: 局所探索（ハード違反 0 を維持しつつスコア下げる）
  var deadlineMs = startMs + ctx.config.localSearchLimitSec * 1000;
  best = localSearch_(ctx, best, deadlineMs, rng);

  // 最終チェック：まだハード違反があれば最後の悪あがき（強制修復）
  bestHardViols = collectHardViolations_(ctx, best);
  if (bestHardViols.length > 0) {
    aggressiveRepair_(ctx, best);
    bestHardViols = collectHardViolations_(ctx, best);
  }
  bestScore = evaluate_(ctx, best);

  var stats = computeStats_(ctx, best);
  var status = bestHardViols.length === 0 ? 'OK' : 'INFEASIBLE';

  return {
    status: status,
    assignments: best,
    stats: stats,
    score: bestScore,
    hardViolations: bestHardViols,
    elapsedMs: (new Date()).getTime() - startMs,
    ctx: ctx
  };
}

// ─────────────────────────────────────────────
// Context 構築
// ─────────────────────────────────────────────
function buildContext_(input) {
  var year = input.year;
  var month = input.month;
  var daysInMonth = new Date(year, month, 0).getDate();

  // 当月の日付配列
  var days = [];
  for (var d = 0; d < daysInMonth; d++) {
    var date = new Date(year, month - 1, d + 1);
    var ds = formatDate_(date);
    var weekday = date.getDay();  // 0=日, 6=土
    var isHoliday = !!input.holidays[ds];
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

  // メンバーごとの稼働日数（当月内）
  var memberMap = {};
  var memberIds = [];
  for (var i = 0; i < input.members.length; i++) {
    var m = input.members[i];
    var availDays = {};   // dayIdx -> true
    var availCount = 0;
    for (var d2 = 0; d2 < daysInMonth; d2++) {
      var date2 = new Date(year, month - 1, d2 + 1);
      var ok = true;
      if (m.availableFrom instanceof Date && date2 < m.availableFrom) ok = false;
      if (m.availableTo instanceof Date && date2 > m.availableTo) ok = false;
      if (ok) {
        availDays[d2] = true;
        availCount++;
      }
    }
    memberMap[m.id] = {
      id: m.id,
      name: m.name,
      email: m.email,
      note: m.note,
      availDays: availDays,
      availCount: availCount
    };
    memberIds.push(m.id);
  }

  // 除外日（dayIdxセット）と ローテ期間（dayIdxセット）と バッファ（ローテ前後の緩衝日）
  var excludedByMember = {};
  var rotationByMember = {};        // memberId -> { type, days: {dayIdx: true} } | null
  var rotationDaysGlobal = {};      // memberId -> {dayIdx -> '救急'|'小児'} （カレンダー出力用）
  var rotationBufferByMember = {};  // memberId -> {dayIdx: true} ローテ前後 ROTATION_GAP_DAYS 日
  memberIds.forEach(function (id) {
    excludedByMember[id] = {};
    rotationByMember[id] = null;
    rotationDaysGlobal[id] = {};
    rotationBufferByMember[id] = {};
  });

  var gap = (typeof ROTATION_GAP_DAYS === 'number') ? ROTATION_GAP_DAYS : 3;

  Object.keys(input.requests).forEach(function (name) {
    var req = input.requests[name];
    // 氏名 → ID
    var member = findMemberByName_(memberMap, name);
    if (!member) return;

    // 除外日
    Object.keys(req.excludeDates).forEach(function (ds) {
      var match = ds.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return;
      var y = Number(match[1]), mo = Number(match[2]), dd = Number(match[3]);
      if (y === year && mo === month) {
        excludedByMember[member.id][dd - 1] = true;
      }
    });

    // ローテ期間 → 該当日を当月内の dayIdx に変換
    if (req.rotation) {
      var rotFrom, rotTo;
      if (req.rotation.isFullMonth) {
        rotFrom = new Date(year, month - 1, 1);
        rotTo   = new Date(year, month, 0);          // 月末
      } else {
        rotFrom = req.rotation.from;
        rotTo   = req.rotation.to;
      }
      // 片側のみ入力されたケースの補完
      if (!rotFrom && rotTo) rotFrom = new Date(year, month - 1, 1);
      if (rotFrom && !rotTo) rotTo   = new Date(year, month, 0);
      if (rotFrom && rotTo) {
        var rotDays = {};
        for (var di = 0; di < daysInMonth; di++) {
          var d3 = new Date(year, month - 1, di + 1);
          if (d3 >= rotFrom && d3 <= rotTo) {
            rotDays[di] = true;
            rotationDaysGlobal[member.id][di] = req.rotation.type;
          }
        }
        rotationByMember[member.id] = { type: req.rotation.type, days: rotDays };

        // バッファ（ローテ前後 gap 日間を当直不可ゾーンとして登録）
        Object.keys(rotDays).forEach(function (key) {
          var rDay = Number(key);
          for (var off = -gap; off <= gap; off++) {
            if (off === 0) continue;
            var bDay = rDay + off;
            if (bDay < 0 || bDay >= daysInMonth) continue;
            if (rotDays[bDay]) continue;            // ローテ本体と重なる日は除外
            rotationBufferByMember[member.id][bDay] = true;
          }
        });
      }
    }
  });

  // 前月実績 → 名前→直近の前月勤務 dayIdx（負値）
  var prevByMember = {};
  memberIds.forEach(function (id) { prevByMember[id] = []; });
  for (var i2 = 0; i2 < input.prevAssignments.length; i2++) {
    var pa = input.prevAssignments[i2];
    var pmDate = dateFromString_(pa.date);
    if (!pmDate) continue;
    // pa.date は前月の日付。当月1日との差分（負値）
    var diff = Math.round((pmDate.getTime() - new Date(year, month - 1, 1).getTime()) / (24 * 3600 * 1000));
    var member2 = findMemberByName_(memberMap, pa.name);
    if (!member2) continue;
    prevByMember[member2.id].push(diff);
  }

  // 月総枠数（A1+B1 = 2）
  var totalSlots = daysInMonth * 2;

  // ローテ期間＋ローテ前後バッファを差し引いた実効稼働日数
  // （ハード制約上「絶対に当直に入れない日」を全て差し引いた純稼働日）
  var effectiveAvailByMember = {};
  memberIds.forEach(function (id) {
    var base = memberMap[id].availCount;
    var blockedDays = {};
    // ローテ本体
    if (rotationByMember[id]) {
      Object.keys(rotationByMember[id].days).forEach(function (k) {
        if (memberMap[id].availDays[Number(k)]) blockedDays[k] = true;
      });
    }
    // バッファ
    Object.keys(rotationBufferByMember[id]).forEach(function (k) {
      if (memberMap[id].availDays[Number(k)]) blockedDays[k] = true;
    });
    effectiveAvailByMember[id] = Math.max(0, base - Object.keys(blockedDays).length);
  });

  var totalAvail = 0;
  memberIds.forEach(function (id) { totalAvail += effectiveAvailByMember[id]; });

  // ─── 目標回数テーブルが定義されていればそれを使う ───
  // テーブル例: [{minDays:0,count:0},{minDays:6,count:1},{minDays:11,count:2},{minDays:16,count:3}]
  // 実効日数 ごとに段階的に当直回数が決まる仕様。Hare quota より優先。
  var targetByMember = {};
  var targetTable = input.targetTable || null;
  if (targetTable && targetTable.length > 0) {
    memberIds.forEach(function (id) {
      targetByMember[id] = lookupTargetCount_(targetTable, effectiveAvailByMember[id]);
    });
  } else if (totalAvail === 0) {
    memberIds.forEach(function (id) { targetByMember[id] = 0; });
  } else {
    var raws = {};
    memberIds.forEach(function (id) {
      raws[id] = totalSlots * (effectiveAvailByMember[id] / totalAvail);
      targetByMember[id] = Math.floor(raws[id]);
    });
    var assignedSum = 0;
    memberIds.forEach(function (id) { assignedSum += targetByMember[id]; });
    var remaining = totalSlots - assignedSum;

    // 3. 0回の人を1まで底上げ（余り席を優先消費）
    var needBoost = memberIds.filter(function (id) {
      return effectiveAvailByMember[id] >= 1 && targetByMember[id] === 0;
    });
    // 実効稼働の少ない人ほど切実なので残席が足りなければ少ない人を優先
    needBoost.sort(function (a, b) { return effectiveAvailByMember[a] - effectiveAvailByMember[b]; });
    for (var bi = 0; bi < needBoost.length && remaining > 0; bi++) {
      targetByMember[needBoost[bi]] = 1;
      remaining--;
    }
    // 残席が 0 になっても底上げ未完了の人がいる場合は、超過分を target が大きい人から減らして埋める
    if (needBoost.length > 0 && remaining === 0) {
      for (var bi2 = 0; bi2 < needBoost.length; bi2++) {
        if (targetByMember[needBoost[bi2]] >= 1) continue;
        // target が最も大きい人から1 引いて回す
        var donorId = null, donorVal = -1;
        memberIds.forEach(function (id) {
          if (targetByMember[id] > donorVal && effectiveAvailByMember[id] >= 2) {
            donorVal = targetByMember[id];
            donorId = id;
          }
        });
        if (donorId !== null && targetByMember[donorId] >= 2) {
          targetByMember[donorId]--;
          targetByMember[needBoost[bi2]] = 1;
        }
      }
    }

    // 4. 残席を小数部の大きい順に +1（既に底上げで 1 にした人は除外）
    var boosted = {};
    needBoost.forEach(function (id) { if (targetByMember[id] === 1) boosted[id] = true; });
    var fracList = memberIds
      .filter(function (id) { return !boosted[id]; })
      .map(function (id) { return { id: id, frac: raws[id] - Math.floor(raws[id]) }; });
    fracList.sort(function (a, b) { return b.frac - a.frac; });
    for (var ki = 0; ki < remaining && ki < fracList.length; ki++) {
      targetByMember[fracList[ki].id]++;
    }
  }

  // 設定の取り出し（既定値で穴埋め）
  var cfg = input.config || {};
  var ctx = {
    year: year,
    month: month,
    daysInMonth: daysInMonth,
    days: days,
    memberIds: memberIds,
    memberMap: memberMap,
    excludedByMember: excludedByMember,
    rotationByMember: rotationByMember,
    rotationDaysGlobal: rotationDaysGlobal,
    rotationBufferByMember: rotationBufferByMember,
    prevByMember: prevByMember,
    totalSlots: totalSlots,
    targetByMember: targetByMember,
    config: {
      minGapDays: cfg.minGapDays || DEFAULTS.MIN_GAP_DAYS,
      weekendMax: cfg.weekendMax || DEFAULTS.WEEKEND_MAX,
      shortGapWindow: cfg.shortGapWindow || DEFAULTS.SHORT_GAP_WINDOW,
      greedyTries: cfg.greedyTries || DEFAULTS.GREEDY_TRIES,
      localSearchLimitSec: cfg.localSearchLimitSec || DEFAULTS.LOCAL_SEARCH_LIMIT_SEC,
      randomSeed: cfg.randomSeed || DEFAULTS.RANDOM_SEED
    }
  };

  return ctx;
}

function findMemberByName_(memberMap, name) {
  var keys = Object.keys(memberMap);
  for (var i = 0; i < keys.length; i++) {
    if (memberMap[keys[i]].name === name) return memberMap[keys[i]];
  }
  return null;
}

// ─────────────────────────────────────────────
// 解の表現
// ─────────────────────────────────────────────
// solution = {
//   byDay: [{ A: memberId|null, B: memberId|null }, ...],   // length = daysInMonth
//   byMember: { memberId -> [dayIdx,...] sorted },
//   weekendByMember: { memberId -> count },
//   abByMember: { memberId -> {A: count, B: count} }
// }

function newEmptySolution_(ctx) {
  var byDay = [];
  for (var d = 0; d < ctx.daysInMonth; d++) {
    byDay.push({ A: null, B: null });
  }
  var byMember = {};
  var weekendByMember = {};
  var abByMember = {};
  ctx.memberIds.forEach(function (id) {
    byMember[id] = [];
    weekendByMember[id] = 0;
    abByMember[id] = { A: 0, B: 0 };
  });
  return {
    byDay: byDay,
    byMember: byMember,
    weekendByMember: weekendByMember,
    abByMember: abByMember
  };
}

// ─────────────────────────────────────────────
// 配置可否判定
// ─────────────────────────────────────────────
function canAssign_(ctx, sol, memberId, dayIdx, shift) {
  // 1. 同日重複禁止
  var slot = sol.byDay[dayIdx];
  if (slot.A === memberId || slot.B === memberId) return false;
  if (shift === SHIFT_A && slot.A !== null) return false;
  if (shift === SHIFT_B && slot.B !== null) return false;

  // 2. 稼働期間
  if (!ctx.memberMap[memberId].availDays[dayIdx]) return false;

  // 3. 除外日
  if (ctx.excludedByMember[memberId][dayIdx]) return false;

  // 3-b. 救急／小児ローテ期間中は割当不可
  var rot = ctx.rotationByMember[memberId];
  if (rot && rot.days[dayIdx]) return false;

  // 3-c. ローテ期間の前後 ROTATION_GAP_DAYS 日も割当不可（最低3日空ける）
  if (ctx.rotationBufferByMember[memberId][dayIdx]) return false;

  // 4. 間隔（中 minGapDays-1 日以上空ける = 連続 minGapDays 日窓に1回まで）
  var gap = ctx.config.minGapDays;
  var assigned = sol.byMember[memberId];
  for (var i = 0; i < assigned.length; i++) {
    if (Math.abs(assigned[i] - dayIdx) < gap) return false;
  }
  // 前月実績との間隔
  var prev = ctx.prevByMember[memberId];
  for (var j = 0; j < prev.length; j++) {
    if (Math.abs(prev[j] - dayIdx) < gap) return false;
  }

  // 5. 土日祝上限
  if (ctx.days[dayIdx].isWeekendOrHoliday) {
    if (sol.weekendByMember[memberId] >= ctx.config.weekendMax) return false;
  }

  return true;
}

function applyAssign_(ctx, sol, memberId, dayIdx, shift) {
  if (shift === SHIFT_A) sol.byDay[dayIdx].A = memberId;
  else sol.byDay[dayIdx].B = memberId;
  sol.byMember[memberId].push(dayIdx);
  sol.byMember[memberId].sort(function (a, b) { return a - b; });
  if (ctx.days[dayIdx].isWeekendOrHoliday) sol.weekendByMember[memberId]++;
  sol.abByMember[memberId][shift]++;
}

function unapplyAssign_(ctx, sol, memberId, dayIdx, shift) {
  if (shift === SHIFT_A) sol.byDay[dayIdx].A = null;
  else sol.byDay[dayIdx].B = null;
  var arr = sol.byMember[memberId];
  for (var i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === dayIdx) { arr.splice(i, 1); break; }
  }
  if (ctx.days[dayIdx].isWeekendOrHoliday) sol.weekendByMember[memberId]--;
  sol.abByMember[memberId][shift]--;
}

// ─────────────────────────────────────────────
// 貪欲構築
// ─────────────────────────────────────────────
function greedyConstruct_(ctx, rng) {
  var sol = newEmptySolution_(ctx);

  // 動的「最も制約が厳しいスロット優先」（Most Constrained Variable）
  // 各反復で全未充足スロットの候補数を計算し、最少のスロットを最優先で埋める。
  // 候補が 2 名しかいない 6/20 のようなスロットを後回しにして、間隔制約で
  // 候補ゼロにしてしまうバグを防ぐ。
  var pending = [];
  for (var d = 0; d < ctx.daysInMonth; d++) {
    SHIFTS.forEach(function (sh) { pending.push({ day: d, shift: sh }); });
  }

  while (pending.length > 0) {
    // 全未充足スロットの現在の候補数を計算
    var bestIdx = -1, bestN = Infinity, bestIsWE = false, bestDay = Infinity;
    for (var p = 0; p < pending.length; p++) {
      var slot = pending[p];
      var n = 0;
      for (var i = 0; i < ctx.memberIds.length; i++) {
        if (canAssign_(ctx, sol, ctx.memberIds[i], slot.day, slot.shift)) n++;
      }
      var isWE = ctx.days[slot.day].isWeekendOrHoliday;
      // 候補数優先、同点なら土日祝優先、それでも同点なら日付昇順
      var better = false;
      if (n < bestN) better = true;
      else if (n === bestN) {
        if (isWE && !bestIsWE) better = true;
        else if (isWE === bestIsWE && slot.day < bestDay) better = true;
      }
      if (better) { bestIdx = p; bestN = n; bestIsWE = isWE; bestDay = slot.day; }
    }

    var picked = pending[bestIdx];
    pending.splice(bestIdx, 1);

    if (bestN === 0) continue;  // ハード制約で詰んでいる → 修復パスへ

    // 候補をソートして1人選ぶ（既存ロジック）
    var candidates = [];
    for (var i2 = 0; i2 < ctx.memberIds.length; i2++) {
      var id = ctx.memberIds[i2];
      if (canAssign_(ctx, sol, id, picked.day, picked.shift)) candidates.push(id);
    }
    var sh2 = picked.shift;
    candidates.sort(function (a, b) {
      var aZero = (sol.byMember[a].length === 0 && ctx.targetByMember[a] >= 1) ? 1 : 0;
      var bZero = (sol.byMember[b].length === 0 && ctx.targetByMember[b] >= 1) ? 1 : 0;
      if (aZero !== bZero) return bZero - aZero;
      var remA = ctx.targetByMember[a] - sol.byMember[a].length;
      var remB = ctx.targetByMember[b] - sol.byMember[b].length;
      if (remA !== remB) return remB - remA;
      var balA = sol.abByMember[a][sh2] - sol.abByMember[a][otherShift_(sh2)];
      var balB = sol.abByMember[b][sh2] - sol.abByMember[b][otherShift_(sh2)];
      if (balA !== balB) return balA - balB;
      return rng.next() - 0.5;
    });

    applyAssign_(ctx, sol, candidates[0], picked.day, picked.shift);
  }

  // 修復1: 緩めた間隔で穴埋め
  for (var d3 = 0; d3 < ctx.daysInMonth; d3++) {
    SHIFTS.forEach(function (sh3) {
      var slot = sol.byDay[d3];
      if ((sh3 === SHIFT_A && slot.A !== null) || (sh3 === SHIFT_B && slot.B !== null)) return;
      var loose = ctx.memberIds.filter(function (id) {
        return canAssignLoose_(ctx, sol, id, d3, sh3);
      });
      if (loose.length === 0) return;
      loose.sort(function (a, b) {
        var remA = ctx.targetByMember[a] - sol.byMember[a].length;
        var remB = ctx.targetByMember[b] - sol.byMember[b].length;
        return remB - remA;
      });
      applyAssign_(ctx, sol, loose[0], d3, sh3);
    });
  }

  // 修復2: カスケード swap（強制充填）
  aggressiveRepair_(ctx, sol);

  return sol;
}

// ─────────────────────────────────────────────
// カスケード swap で空きスロットを強制的に埋める。
//   各空きスロット (d, sh) に対し、以下を順に試す：
//   ・直接割当
//   ・1-hop swap （その候補の既存割当を1つ別人で置き換え）
//   ・2-hop swap （別人の既存割当も連鎖的に移す）
//
//   さらに、空きスロットが残っているうちは再パスを最大 3 回繰り返す
//   （1パス目で生まれた新たな選択肢で 2パス目が埋まることがある）
// ─────────────────────────────────────────────
function aggressiveRepair_(ctx, sol) {
  for (var iter = 0; iter < 3; iter++) {
    var beforeViolations = countEmptySlots_(sol);
    if (beforeViolations === 0) return;
    for (var d = 0; d < ctx.daysInMonth; d++) {
      for (var si = 0; si < SHIFTS.length; si++) {
        var sh = SHIFTS[si];
        var current = (sh === SHIFT_A) ? sol.byDay[d].A : sol.byDay[d].B;
        if (current !== null) continue;
        // 直接 → 1-hop → 2-hop の順に試す
        assignOrCascade_(ctx, sol, d, sh) ||
        tryTwoHopCascade_(ctx, sol, d, sh);
      }
    }
    var afterViolations = countEmptySlots_(sol);
    if (afterViolations === beforeViolations) break; // 改善が止まれば終了
  }
}

function countEmptySlots_(sol) {
  var n = 0;
  for (var d = 0; d < sol.byDay.length; d++) {
    if (sol.byDay[d].A === null) n++;
    if (sol.byDay[d].B === null) n++;
  }
  return n;
}

// 物理候補（gap/AB重複以外のハード制約は全て満たす）チェック
function isPhysicallyEligible_(ctx, sol, memberId, d) {
  if (sol.byDay[d].A === memberId || sol.byDay[d].B === memberId) return false;
  if (!ctx.memberMap[memberId].availDays[d]) return false;
  if (ctx.excludedByMember[memberId][d]) return false;
  var rot = ctx.rotationByMember[memberId];
  if (rot && rot.days[d]) return false;
  if (ctx.rotationBufferByMember[memberId][d]) return false;
  if (ctx.days[d].isWeekendOrHoliday && sol.weekendByMember[memberId] >= ctx.config.weekendMax) return false;
  return true;
}

// 直接割当 → 失敗なら 1-hop カスケード swap を試す
function assignOrCascade_(ctx, sol, d, sh) {
  // 直接割当
  for (var i = 0; i < ctx.memberIds.length; i++) {
    if (canAssign_(ctx, sol, ctx.memberIds[i], d, sh)) {
      applyAssign_(ctx, sol, ctx.memberIds[i], d, sh);
      return true;
    }
  }
  // 1-hop: id を (d, sh) に入れるため、id の既存割当 (od, osh) を別の k で置き換え
  for (var i2 = 0; i2 < ctx.memberIds.length; i2++) {
    var id = ctx.memberIds[i2];
    if (!isPhysicallyEligible_(ctx, sol, id, d)) continue;

    var myDays = sol.byMember[id].slice();
    for (var j = 0; j < myDays.length; j++) {
      var od = myDays[j];
      var osh = (sol.byDay[od].A === id) ? SHIFT_A : SHIFT_B;
      unapplyAssign_(ctx, sol, id, od, osh);
      if (canAssign_(ctx, sol, id, d, sh)) {
        for (var k = 0; k < ctx.memberIds.length; k++) {
          var kId = ctx.memberIds[k];
          if (kId === id) continue;
          if (canAssign_(ctx, sol, kId, od, osh)) {
            applyAssign_(ctx, sol, id, d, sh);
            applyAssign_(ctx, sol, kId, od, osh);
            return true;
          }
        }
      }
      applyAssign_(ctx, sol, id, od, osh);
    }
  }
  return false;
}

// 2-hop カスケード:
//   id を (d, sh) に入れたいが 1-hop では埋まらない。
//   id の既存 (od1, osh1) を別人 X で置き換えたいが、X が直接 canAssign_ を満たさない。
//   → X の既存 (od2, osh2) も別人 Y で置き換える 2段階の swap を試す。
function tryTwoHopCascade_(ctx, sol, d, sh) {
  for (var i = 0; i < ctx.memberIds.length; i++) {
    var id = ctx.memberIds[i];
    if (!isPhysicallyEligible_(ctx, sol, id, d)) continue;

    var myDays = sol.byMember[id].slice();
    for (var j = 0; j < myDays.length; j++) {
      var od1 = myDays[j];
      var osh1 = (sol.byDay[od1].A === id) ? SHIFT_A : SHIFT_B;
      unapplyAssign_(ctx, sol, id, od1, osh1);

      if (canAssign_(ctx, sol, id, d, sh)) {
        // (od1, osh1) を 2-hop で埋める：X の (od2, osh2) を Y に移す
        for (var k = 0; k < ctx.memberIds.length; k++) {
          var X = ctx.memberIds[k];
          if (X === id) continue;
          if (!isPhysicallyEligible_(ctx, sol, X, od1)) continue;

          var XDays = sol.byMember[X].slice();
          for (var jj = 0; jj < XDays.length; jj++) {
            var od2 = XDays[jj];
            var osh2 = (sol.byDay[od2].A === X) ? SHIFT_A : SHIFT_B;
            unapplyAssign_(ctx, sol, X, od2, osh2);

            if (canAssign_(ctx, sol, X, od1, osh1)) {
              for (var kk = 0; kk < ctx.memberIds.length; kk++) {
                var Y = ctx.memberIds[kk];
                if (Y === id || Y === X) continue;
                if (canAssign_(ctx, sol, Y, od2, osh2)) {
                  applyAssign_(ctx, sol, id, d, sh);
                  applyAssign_(ctx, sol, X, od1, osh1);
                  applyAssign_(ctx, sol, Y, od2, osh2);
                  return true;
                }
              }
            }
            applyAssign_(ctx, sol, X, od2, osh2);  // 戻す
          }
        }
      }
      applyAssign_(ctx, sol, id, od1, osh1);
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// ゼロ救済パス
//   greedyConstruct の後で、目標 ≥ 1 にも関わらず 0 回の人を救済する。
//   1) まず通常の canAssign_ でそのまま割り当て可能な日を探す
//   2) ダメなら、別の人と入れ替える（その人が複数回入っていて、
//      かつ自分の他の日でも入れる場合のみ swap）
//
//   稼働可能日が全くない人（ローテで月全体潰れている等）はスキップ。
// ─────────────────────────────────────────────
function rescueZeroAssignments_(ctx, sol) {
  for (var i = 0; i < ctx.memberIds.length; i++) {
    var id = ctx.memberIds[i];
    if (sol.byMember[id].length > 0) continue;          // 既に1回以上入っている
    if (ctx.targetByMember[id] < 1) continue;           // 目標0（実効稼働なし）
    if (tryDirectAssign_(ctx, sol, id)) continue;       // 直接割当成功
    trySwapAssign_(ctx, sol, id);                       // スワップで救済
  }
}

// 直接割当：canAssign_ を満たす (day, shift) を1つ見つけて入れる
function tryDirectAssign_(ctx, sol, memberId) {
  for (var d = 0; d < ctx.daysInMonth; d++) {
    for (var s = 0; s < SHIFTS.length; s++) {
      var shift = SHIFTS[s];
      if (canAssign_(ctx, sol, memberId, d, shift)) {
        applyAssign_(ctx, sol, memberId, d, shift);
        return true;
      }
    }
  }
  return false;
}

// スワップ救済：
//   memberId が入りたい日 d で、現在 X が入っている。
//   X を退かして memberId を入れ、X はもう入れる場所が残っているなら成立。
//   ただし X の総回数が target を上回る人を優先（負荷の偏りを増やさない）。
function trySwapAssign_(ctx, sol, memberId) {
  // 自分の稼働可能・非ローテ・非バッファ・非除外な日の集合
  var rot = ctx.rotationByMember[memberId];
  var candidateDays = [];
  for (var d = 0; d < ctx.daysInMonth; d++) {
    if (!ctx.memberMap[memberId].availDays[d]) continue;
    if (ctx.excludedByMember[memberId][d]) continue;
    if (rot && rot.days[d]) continue;
    if (ctx.rotationBufferByMember[memberId][d]) continue;
    candidateDays.push(d);
  }
  if (candidateDays.length === 0) return false;

  for (var ci = 0; ci < candidateDays.length; ci++) {
    var d2 = candidateDays[ci];
    for (var s2 = 0; s2 < SHIFTS.length; s2++) {
      var shift = SHIFTS[s2];
      var current = (shift === SHIFT_A) ? sol.byDay[d2].A : sol.byDay[d2].B;
      if (current === null || current === memberId) continue;
      if (sol.byMember[current].length <= 1) continue;  // 退かすと相手が0回になる
      // 退かしてから自分が入れるか試す
      unapplyAssign_(ctx, sol, current, d2, shift);
      if (canAssign_(ctx, sol, memberId, d2, shift)) {
        applyAssign_(ctx, sol, memberId, d2, shift);
        return true;
      }
      // 戻す
      applyAssign_(ctx, sol, current, d2, shift);
    }
  }
  return false;
}

function canAssignLoose_(ctx, sol, memberId, dayIdx, shift) {
  // 間隔のみ 1 日緩める（連続 minGapDays-1 日窓）
  var slot = sol.byDay[dayIdx];
  if (slot.A === memberId || slot.B === memberId) return false;
  if (shift === SHIFT_A && slot.A !== null) return false;
  if (shift === SHIFT_B && slot.B !== null) return false;
  if (!ctx.memberMap[memberId].availDays[dayIdx]) return false;
  if (ctx.excludedByMember[memberId][dayIdx]) return false;
  // ローテ期間中も不可（緩和なし）
  var rotL = ctx.rotationByMember[memberId];
  if (rotL && rotL.days[dayIdx]) return false;
  // ローテ前後バッファも不可（緩和なし。最低3日は空ける）
  if (ctx.rotationBufferByMember[memberId][dayIdx]) return false;

  var gap = Math.max(2, ctx.config.minGapDays - 1);
  var assigned = sol.byMember[memberId];
  for (var i = 0; i < assigned.length; i++) {
    if (Math.abs(assigned[i] - dayIdx) < gap) return false;
  }
  var prev = ctx.prevByMember[memberId];
  for (var j = 0; j < prev.length; j++) {
    if (Math.abs(prev[j] - dayIdx) < gap) return false;
  }
  if (ctx.days[dayIdx].isWeekendOrHoliday) {
    if (sol.weekendByMember[memberId] >= ctx.config.weekendMax) return false;
  }
  return true;
}

function otherShift_(s) { return s === SHIFT_A ? SHIFT_B : SHIFT_A; }

// ─────────────────────────────────────────────
// 評価関数（小さいほど良い）
// ─────────────────────────────────────────────
function evaluate_(ctx, sol) {
  var s = 0;
  // S1: 目標差
  for (var i = 0; i < ctx.memberIds.length; i++) {
    var id = ctx.memberIds[i];
    s += WEIGHT.TARGET_DIFF * Math.abs(sol.byMember[id].length - ctx.targetByMember[id]);
  }
  // S2: A/B 均衡
  for (var j = 0; j < ctx.memberIds.length; j++) {
    var id2 = ctx.memberIds[j];
    s += WEIGHT.AB_BALANCE * Math.abs(sol.abByMember[id2].A - sol.abByMember[id2].B);
  }
  // S3: 短間隔ペナルティ（4〜6日窓内の重複）
  var win = ctx.config.shortGapWindow;
  var minGap = ctx.config.minGapDays;
  for (var k = 0; k < ctx.memberIds.length; k++) {
    var id3 = ctx.memberIds[k];
    var arr = sol.byMember[id3];
    for (var x = 0; x < arr.length; x++) {
      for (var y = x + 1; y < arr.length; y++) {
        var diff = arr[y] - arr[x];
        if (diff >= minGap && diff < win + 1) {
          // 中2日空いてはいるが、まだ近い
          s += WEIGHT.SHORT_GAP * (win + 1 - diff);
        } else if (diff > win) {
          break;  // sorted なので以降はもっと遠い
        }
      }
    }
  }
  return s;
}

function collectHardViolations_(ctx, sol) {
  var v = [];
  // 各日の充足
  for (var d = 0; d < ctx.daysInMonth; d++) {
    if (sol.byDay[d].A === null) v.push('日 ' + (d + 1) + ': A 未割当');
    if (sol.byDay[d].B === null) v.push('日 ' + (d + 1) + ': B 未割当');
    if (sol.byDay[d].A !== null && sol.byDay[d].A === sol.byDay[d].B) {
      v.push('日 ' + (d + 1) + ': 同人物に A と B が割当');
    }
  }
  return v;
}

// ─────────────────────────────────────────────
// 局所探索
// ─────────────────────────────────────────────
function localSearch_(ctx, sol, deadlineMs, rng) {
  var improved = true;
  var iter = 0;
  while (improved) {
    improved = false;
    iter++;
    if ((new Date()).getTime() > deadlineMs) break;

    // 1. 各 (day, shift) について、別メンバーに置き換えて改善するか試す
    for (var d = 0; d < ctx.daysInMonth; d++) {
      if ((new Date()).getTime() > deadlineMs) break;
      for (var si = 0; si < SHIFTS.length; si++) {
        var sh = SHIFTS[si];
        var current = (sh === SHIFT_A) ? sol.byDay[d].A : sol.byDay[d].B;
        if (current === null) continue;

        var baseScore = evaluate_(ctx, sol);
        // current を外して、別の人で埋め直す
        unapplyAssign_(ctx, sol, current, d, sh);

        var bestId = current;
        var bestSc = Infinity;
        for (var i = 0; i < ctx.memberIds.length; i++) {
          var id = ctx.memberIds[i];
          if (id === current) continue;
          if (!canAssign_(ctx, sol, id, d, sh)) continue;
          applyAssign_(ctx, sol, id, d, sh);
          var sc = evaluate_(ctx, sol);
          unapplyAssign_(ctx, sol, id, d, sh);
          if (sc < bestSc) { bestSc = sc; bestId = id; }
        }
        // 元の人もチェック
        applyAssign_(ctx, sol, current, d, sh);
        var origSc = evaluate_(ctx, sol);
        if (bestSc < origSc) {
          unapplyAssign_(ctx, sol, current, d, sh);
          applyAssign_(ctx, sol, bestId, d, sh);
          improved = true;
        }
      }
    }

    // 2. 2点スワップ: (d1, sh1) と (d2, sh2) の人を入れ替えて改善するか
    if ((new Date()).getTime() < deadlineMs) {
      for (var d1 = 0; d1 < ctx.daysInMonth - 1; d1++) {
        if ((new Date()).getTime() > deadlineMs) break;
        for (var d2 = d1 + 1; d2 < ctx.daysInMonth; d2++) {
          for (var si1 = 0; si1 < SHIFTS.length; si1++) {
            for (var si2 = 0; si2 < SHIFTS.length; si2++) {
              var sh1 = SHIFTS[si1];
              var sh2 = SHIFTS[si2];
              var m1 = (sh1 === SHIFT_A) ? sol.byDay[d1].A : sol.byDay[d1].B;
              var m2 = (sh2 === SHIFT_A) ? sol.byDay[d2].A : sol.byDay[d2].B;
              if (m1 === null || m2 === null || m1 === m2) continue;

              var origSc2 = evaluate_(ctx, sol);
              unapplyAssign_(ctx, sol, m1, d1, sh1);
              unapplyAssign_(ctx, sol, m2, d2, sh2);
              if (canAssign_(ctx, sol, m2, d1, sh1) && canAssign_(ctx, sol, m1, d2, sh2)) {
                applyAssign_(ctx, sol, m2, d1, sh1);
                applyAssign_(ctx, sol, m1, d2, sh2);
                var newSc = evaluate_(ctx, sol);
                if (newSc < origSc2) {
                  improved = true;
                } else {
                  unapplyAssign_(ctx, sol, m2, d1, sh1);
                  unapplyAssign_(ctx, sol, m1, d2, sh2);
                  applyAssign_(ctx, sol, m1, d1, sh1);
                  applyAssign_(ctx, sol, m2, d2, sh2);
                }
              } else {
                applyAssign_(ctx, sol, m1, d1, sh1);
                applyAssign_(ctx, sol, m2, d2, sh2);
              }
            }
          }
        }
      }
    }
  }
  return sol;
}

// ─────────────────────────────────────────────
// 集計
// ─────────────────────────────────────────────
function computeStats_(ctx, sol) {
  var stats = [];
  for (var i = 0; i < ctx.memberIds.length; i++) {
    var id = ctx.memberIds[i];
    var m = ctx.memberMap[id];
    var arr = sol.byMember[id].slice().sort(function (a, b) { return a - b; });
    var gaps = [];
    for (var j = 1; j < arr.length; j++) gaps.push(arr[j] - arr[j - 1]);
    var minGap = gaps.length ? Math.min.apply(null, gaps) : null;
    var avgGap = gaps.length ? gaps.reduce(function (s, x) { return s + x; }, 0) / gaps.length : null;
    stats.push({
      memberId: id,
      name: m.name,
      target: ctx.targetByMember[id],
      total: arr.length,
      A: sol.abByMember[id].A,
      B: sol.abByMember[id].B,
      weekend: sol.weekendByMember[id],
      minGap: minGap,
      avgGap: avgGap
    });
  }
  return stats;
}

// ─────────────────────────────────────────────
// 線形合同法 RNG（シード固定）
// ─────────────────────────────────────────────
function makeRng_(seed) {
  var s = (seed | 0) || 1;
  return {
    next: function () {
      s = (s * 1664525 + 1013904223) | 0;
      return ((s >>> 0) / 4294967296);
    }
  };
}
