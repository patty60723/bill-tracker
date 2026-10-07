// 紀錄頁:依月份 / 所有帳單 / 統計,以及搜尋。

import { addMonths, formatPeriod, parsePeriod, periodKey, todayISO } from '../dates.js';
import { monthSummary } from '../schedule.js';
import { billsToCSV, billYears, matchBill, yearStats } from '../stats.js';
import { loadAll } from '../ui/actions.js';
import { billRow, byStatusThenDue, catIcon, catLabel, groupedRows, summaryBlock } from '../ui/components.js';
import { $, $$, download, esc, money, toast } from '../ui/dom.js';
import { replaceHash } from '../ui/router.js';

export async function renderBills(params) {
  const { templates, bills } = await loadAll();
  const today = todayISO();
  const view = params.get('view') === 'stats' ? 'stats' : params.get('month') === 'all' ? 'all' : 'month';
  const month = view === 'month' && params.get('month') ? params.get('month') : today.slice(0, 7);
  const filter = params.get('filter') || 'all';
  const tById = new Map(templates.map((t) => [t.id, t]));
  const link = (mk, f = filter) => `#/bills?month=${mk}&filter=${f}`;

  $('#view').innerHTML = `
    <header class="page-head"><h1>繳費紀錄</h1></header>
    <div class="search-box">
      <input type="search" id="bill-search" placeholder="🔍 搜尋名稱、金額、帳號、備註…" value="${esc(params.get('q') || '')}" enterkeyhint="search" autocomplete="off">
    </div>
    <div class="segmented three">
      <a class="${view === 'month' ? 'on' : ''}" href="${link(view === 'month' ? month : today.slice(0, 7))}">依月份</a>
      <a class="${view === 'all' ? 'on' : ''}" href="${link('all')}">所有帳單</a>
      <a class="${view === 'stats' ? 'on' : ''}" href="#/bills?view=stats">統計</a>
    </div>
    <div id="bills-body"></div>
    <a class="fab" href="#/bill/new?period=${month}" aria-label="新增帳單">＋</a>`;

  const body = $('#bills-body');
  const drawBody = (q) => {
    if (q.trim()) body.innerHTML = searchResults(bills, tById, q, today);
    else if (view === 'stats') body.innerHTML = statsView(bills, Number(params.get('year')) || Number(today.slice(0, 4)));
    else body.innerHTML = billsListBody({ bills, tById, view, month, filter, link, today });
  };
  drawBody(params.get('q') || '');

  // 搜尋:只重畫下面的清單,輸入框不會失去焦點;關鍵字記在網址,返回時還在
  const search = $('#bill-search');
  search.addEventListener('input', () => {
    const q = search.value;
    const p = new URLSearchParams(params);
    if (q.trim()) p.set('q', q); else p.delete('q');
    replaceHash(`#/bills?${p}`);
    drawBody(q);
  });

  // 統計長條圖:點一個月份顯示明細
  body.addEventListener('click', (e) => {
    const bar = e.target.closest('[data-month-bar]');
    if (!bar) return;
    $$('[data-month-bar]', body).forEach((x) => x.classList.toggle('on', x === bar));
    $('#chart-detail').innerHTML = bar.dataset.detail;
  });
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (!btn) return;
    const year = btn.dataset.export;
    const list = year === 'all' ? bills : bills.filter((b) => b.period?.startsWith(`${year}-`));
    if (!list.length) return toast('沒有可以匯出的帳單');
    download(`bills-${year}.csv`, billsToCSV(list, catLabel), 'text/csv');
  });
}

export function billsListBody({ bills, tById, view, month, filter, link, today }) {
  const byFilter = (b) => filter === 'all' || (filter === 'paid' ? b.status === 'paid' : b.status !== 'paid');
  const chips = (target) => `<div class="chips">
      ${[['all', '全部'], ['unpaid', '未繳'], ['paid', '已繳']].map(([k, label]) => `<a class="chip ${k === filter ? 'on' : ''}" href="${link(target, k)}">${label}</a>`).join('')}
    </div>`;
  if (view === 'all') {
    const list = bills.filter(byFilter);
    return `${chips('all')}${groupedRows(list, tById, today, (p) => link(p))}`;
  }
  const { year, month: mo } = parsePeriod(month);
  const prev = addMonths(year, mo, -1);
  const next = addMonths(year, mo, 1);
  const list = bills.filter((b) => b.period === month).filter(byFilter).sort(byStatusThenDue);
  const elsewhere = bills.filter((b) => b.period !== month).length;
  return `<div class="month-nav">
      <a class="btn small" href="${link(periodKey(prev.year, prev.month))}" aria-label="上個月">‹</a>
      <strong>${formatPeriod(month)}</strong>
      <a class="btn small" href="${link(periodKey(next.year, next.month))}" aria-label="下個月">›</a>
    </div>
    ${summaryBlock(monthSummary(bills, month))}
    ${chips(month)}
    ${list.length ? list.map((b) => billRow(b, tById.get(b.templateId), today)).join('')
    : `<div class="empty">這個月沒有帳單${elsewhere ? `<br><a href="${link('all')}">其他月份有 ${elsewhere} 筆,看全部 ›</a>` : ''}</div>`}`;
}

export function searchResults(bills, tById, q, today) {
  const list = bills.filter((b) => matchBill(b, q, catLabel));
  const sum = list.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  return `<p class="muted small search-summary">找到 ${list.length} 筆${list.length ? `,合計 ${money(sum)}` : ''}</p>
    ${list.length ? groupedRows(list, tById, today, (p) => `#/bills?month=${p}`) : '<div class="empty">找不到符合的帳單<br><span class="small">可以搜尋名稱、金額(1286 或 1,286)、帳號、備註、類別、月份(2026-10)</span></div>'}`;
}

/** 統計頁:年度總覽、12 個月長條圖、類別排行、匯出 CSV。 */
export function statsView(bills, year) {
  const [thisYear, thisMonth] = todayISO().split('-').map(Number);
  // 今年還沒過完:跟去年「同期」(1 月到本月)比
  const s = yearStats(bills, year, year === thisYear ? thisMonth : 12);
  const sameMonths = s.compareThrough < 12 ? `同期(1–${s.compareThrough} 月)` : '';
  const years = billYears(bills, thisYear);
  const hasPrev = years.includes(year - 1) || year - 1 >= Math.min(...years);
  const hasNext = year < Math.max(...years);
  const pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;
  const flat = (x) => Math.round(Math.abs(x) * 100) === 0;
  const change = s.change == null
    ? `<span class="muted">去年${sameMonths}沒有紀錄</span>`
    : flat(s.change) ? `跟去年${sameMonths}差不多`
      : `比去年${sameMonths}${s.change > 0 ? '多' : '少'} <b>${pct(s.change)}</b> ${s.change > 0 ? '▲' : '▼'}`
        + `<span class="muted">(今年 ${money(s.compareTotal)}、去年 ${money(s.prevTotal)})</span>`;

  const max = Math.max(...s.byMonth.map((m) => m.total), 0);
  const peak = s.byMonth.reduce((a, m) => (m.total > a.total ? m : a), s.byMonth[0]);
  const bars = s.byMonth.map((m) => {
    const h = max ? Math.max(m.total ? 3 : 0, Math.round((m.total / max) * 100)) : 0;
    const p = periodKey(year, m.month);
    const detail = `<b>${m.month} 月</b>:${money(m.total)}${m.count ? `(已繳 ${money(m.paid)},${m.count} 筆)` : ''} <a href="#/bills?month=${p}">看這個月 ›</a>`;
    return `<button type="button" class="bar-col" data-month-bar data-detail="${esc(detail)}" aria-label="${m.month} 月 ${money(m.total)}">
        <span class="bar-value">${m === peak && m.total ? money(m.total) : ''}</span>
        <span class="bar-track"><span class="bar" style="height:${h}%"></span></span>
        <span class="bar-label">${m.month}</span>
      </button>`;
  }).join('');

  const catMax = Math.max(...s.byCategory.map((c) => c.total), 0);
  const cats = s.byCategory.map((c) => {
    const share = s.total ? Math.round((c.total / s.total) * 100) : 0;
    const d = c.prevTotal > 0 ? (c.compareTotal - c.prevTotal) / c.prevTotal : null;
    const vsPrev = d == null ? '' : flat(d) ? ` · 跟去年${sameMonths}差不多`
      : ` · 比去年${sameMonths}${d > 0 ? '多' : '少'} ${pct(d)}`;
    return `<div class="cat-row">
        <span class="icon">${catIcon(c.category)}</span>
        <div class="grow">
          <div class="cat-head"><span>${esc(catLabel(c.category))}</span><b>${money(c.total)}</b></div>
          <div class="cat-track"><span class="cat-bar" style="width:${catMax ? Math.max(2, (c.total / catMax) * 100) : 0}%"></span></div>
          <div class="sub">${share}% · ${c.count} 筆${vsPrev}</div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="month-nav">
      ${hasPrev ? `<a class="btn small" href="#/bills?view=stats&year=${year - 1}" aria-label="前一年">‹</a>` : '<span class="btn small disabled">‹</span>'}
      <strong>${year} 年</strong>
      ${hasNext ? `<a class="btn small" href="#/bills?view=stats&year=${year + 1}" aria-label="下一年">›</a>` : '<span class="btn small disabled">›</span>'}
    </div>
    ${s.count ? `
    <div class="stats">
      <div><div class="label">全年總額</div><div class="value">${money(s.total)}</div></div>
      <div><div class="label">已繳</div><div class="value ok">${money(s.paid)}</div></div>
      <div><div class="label">月平均</div><div class="value">${money(s.monthlyAvg)}</div></div>
    </div>
    <p class="yoy small">${change}</p>
    <section class="card col chart-card">
      <h3>每月金額</h3>
      <div class="bar-chart" role="group" aria-label="${year} 年每月繳費金額">${bars}</div>
      <div id="chart-detail" class="chart-detail small muted">點長條看當月明細</div>
    </section>
    <section class="card col">
      <h3>各類別</h3>
      ${cats}
    </section>` : `<div class="empty">${year} 年沒有帳單</div>`}
    <section class="card col">
      <h3>匯出 CSV</h3>
      <p class="muted small">用 Excel、Google 試算表、Numbers 都能直接開啟。</p>
      <div class="btn-row">
        <button class="btn" data-export="${year}">匯出 ${year} 年</button>
        <button class="btn" data-export="all">匯出全部</button>
      </div>
    </section>`;
}
