// 帳單種類:各家帳單跟通用規則(parse.js)不一樣的地方集中在這裡。
// 通用規則先跑完,認出帳單種類後再用這裡的設定補上名稱、類別、週期,或改用比較準的金額欄位。
// 另外負責「記住同一張帳單」:用存檔時記下的特徵(帳號、條碼代收代號、帳單種類)認出是哪個固定繳費。

/**
 * match:帳單上會出現的字(OCR 文字已正規化,中文字之間沒有空白)。比對次數最多的那種勝出,
 *   所以信用卡帳單裡出現一次「台電代繳」不會被當成台電帳單。
 * name / category:名稱、類別(只在使用者還沒填時帶入)。
 * cycleMonths:帳單上讀不到計費期間時的預設週期。
 * amountKeywords:金額優先看這些字後面的數字(依序),找不到才用通用規則。
 */
export const PROFILES = [
  {
    id: 'tax', name: '', category: 'tax', label: '稅單',
    match: /稅捐稽徵|稅務局|國稅局|地方稅|地價稅|房屋稅|使用牌照稅|綜合所得稅|繳款書/g,
  },
  {
    id: 'taipower', name: '台電電費', category: 'power', label: '台電電費',
    match: /台灣電力|臺灣電力|台電|AIWAN\s*POWER|電號|流動電費/gi,
    amountKeywords: ['應繳總金額'],
  },
  {
    id: 'water', name: '水費', category: 'water', label: '水費',
    match: /自來水|水號|用水/g,
  },
  { id: 'cht', name: '中華電信', category: 'telecom', label: '中華電信', match: /中華電信/g, cycleMonths: 1 },
  { id: 'twm', name: '台灣大哥大', category: 'telecom', label: '台灣大哥大', match: /台灣大哥大|臺灣大哥大/g, cycleMonths: 1 },
  { id: 'fet', name: '遠傳電信', category: 'telecom', label: '遠傳電信', match: /遠傳/g, cycleMonths: 1 },
  // 沒寫業者名稱的電信帳單(例如台灣大哥大的「代收費用帳單」那一頁)。generic:有認出其他種類就不用它
  { id: 'telecom', name: '電信費', category: 'telecom', label: '電信費', match: /電信費|電信帳單|代收費用帳單|月租費|基本月費/g, cycleMonths: 1, generic: true },
  { id: 'gas', name: '瓦斯費', category: 'gas', label: '瓦斯費', match: /天然氣|瓦斯/g },
  {
    // 只寫「信用卡」不算:電信費、水電費也常寫「自您指定之信用卡扣款」
    id: 'card', name: '信用卡', category: 'card', label: '信用卡帳單', match: /信用卡帳單|信用卡對帳單|最低應繳|循環信用|信用額度/g, cycleMonths: 1,
    amountKeywords: ['本期應繳總金額', '本期應繳金額', '應繳總金額'],
  },
  {
    // 管理費單的明細表頭是「應繳費用」(底下第一個數字是其中一項),總額在「總計」
    id: 'mgmt', name: '管理費', category: 'rent', label: '管理費', match: /管理委員會|管委會|管理費/g,
    amountKeywords: ['總計', '合計', '應繳總金額', '應繳金額'],
  },
];

export const profileById = (id) => PROFILES.find((p) => p.id === id) || null;

/**
 * 認出帳單種類。text:所有 OCR 文字(已正規化);taxQr:讀到稅單 QR Code。
 * 比對次數最多的勝出(一樣多時取清單前面的)。認錯的代價只是帶入名稱/類別(使用者還沒填時),
 * 所以比對到一次就算。
 */
export function detectProfile(text, { taxQr = false } = {}) {
  if (taxQr) return profileById('tax');
  const pick = (list) => {
    let best = null;
    let bestCount = 0;
    for (const p of list) {
      const count = (text.match(p.match) || []).length;
      if (count > bestCount) {
        best = p;
        bestCount = count;
      }
    }
    return best;
  };
  // 有認出業者(台灣大哥大)就用業者的,不用「電信費」這種通用的
  return pick(PROFILES.filter((p) => !p.generic)) || pick(PROFILES.filter((p) => p.generic));
}

/**
 * 掃描結果是哪個固定繳費?依存檔時記下的特徵(template.scanHints)打分:
 * 同一個繳費帳號 3 分、同一個條碼代收代號 2 分、同一種帳單 2 分。最高分要 ≥ 2 而且只有一個。
 * 都沒有特徵可比時(舊的固定繳費),同一個類別只有一個固定繳費就當成是它。
 * @returns {{ template, reason: string } | null}
 */
export function matchTemplate(r, templates) {
  const active = templates.filter((t) => t.active !== false);
  const scored = active.map((t) => {
    const h = t.scanHints || {};
    const reasons = [];
    let score = 0;
    if (r.accountNo && (h.accountNo === r.accountNo || t.accountNo === r.accountNo)) {
      score += 3;
      reasons.push('同一個繳費帳號');
    }
    if (r.collectionCode && h.collectionCode === r.collectionCode) {
      score += 2;
      reasons.push('同一個條碼代收代號');
    }
    if (r.profile && h.profile === r.profile) {
      score += 2;
      reasons.push('同一種帳單');
    }
    return { template: t, score, reasons };
  }).sort((a, b) => b.score - a.score);
  const [top, second] = scored;
  if (top && top.score >= 2 && (!second || second.score < top.score)) return { template: top.template, reason: top.reasons.join('、') };
  if (r.category && r.category !== 'other' && !scored.some((s) => s.score > 0)) {
    const same = active.filter((t) => t.category === r.category);
    if (same.length === 1) return { template: same[0], reason: '同類別只有這一個固定繳費' };
  }
  return null;
}

/** 存檔時記到固定繳費上的特徵,下次掃到同一張帳單就認得出來。 */
export function scanHintsFrom(r) {
  const hints = {};
  if (r.profile) hints.profile = r.profile;
  if (r.collectionCode) hints.collectionCode = r.collectionCode;
  if (r.accountNo) hints.accountNo = r.accountNo;
  return hints;
}
