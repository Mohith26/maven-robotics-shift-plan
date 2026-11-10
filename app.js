import { fitModel, makeScenarios, evaluate, policyEDD } from './core/shiftplan.js';
import * as P from './core/pipeline.js';

const $ = (id) => document.getElementById(id);
const state = { rush: 'accept', nAssoc: 2, sel: null, busy: false };
let site, model, split, cal, ranked, noRush;
const SEVAL = 500;
const ARROW = '<svg class="arrow" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20"/><path d="M11 20h17M21 12.5l7.5 7.5-7.5 7.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const pct = (x) => `${Math.round(x * 100)}%`;
const pts = (x) => { const v = Math.round(x * 100); return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)}`; };
const ptsUnit = (x) => (Math.abs(Math.round(x * 100)) === 1 ? 'pt' : 'pts');
const aOrAn = (p) => (/^(8|11|18)/.test(String(Math.round(p * 100))) ? 'an' : 'a');
const clock = (sec) => { const m = Math.round(sec / 60) + 15 * 60; const h = Math.floor(m / 60) % 24, mm = m % 60; return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; };
const fmt = (n) => n.toLocaleString('en-US');
const tick = () => new Promise((r) => setTimeout(r, 0));
function setLoad(p, msg) { $('loadBar').style.width = `${Math.round(p * 100)}%`; if (msg) $('loadMsg').textContent = msg; }

// Optional deep-link state, e.g. ?rush=decline&assoc=3&sel=reseq (same code paths as the controls).
const qs = new URLSearchParams(location.search);
if (qs.get('rush') === 'decline') state.rush = 'decline';
if (+qs.get('assoc') >= 1 && +qs.get('assoc') <= 4) state.nAssoc = +qs.get('assoc');

async function main() {
  setLoad(0.05, 'Loading fleet logs');
  $('aVal').textContent = state.nAssoc;
  for (const x of $('rushSeg').children) x.classList.toggle('on', x.dataset.v === state.rush);
  const [s, h] = await Promise.all([fetch('data/site.json').then((r) => r.json()), fetch('data/history.json').then((r) => r.json())]);
  site = s;
  await tick();
  split = P.prepareHistory(h);
  model = fitModel(site, split.train);
  setLoad(0.25, `Calibrating on ${split.cal.length} past shifts`);
  await tick();
  cal = P.calibrate(site, model, split);
  setLoad(0.6, 'Optimizing dispatch over sampled shifts');
  await tick();
  replanSync();
  if (qs.get('sel') && ranked.actions.some((a) => a.key === qs.get('sel'))) state.sel = qs.get('sel');
  setLoad(1, 'Done');
  render();
  $('loading').classList.add('hidden');
  wire();
}

function baseOpts() { return { nAssoc: state.nAssoc, rush: state.rush === 'accept' ? site.rush.trailer : false }; }
function replanSync() {
  const t0 = performance.now();
  ranked = P.rankActions(site, model, baseOpts(), { kappa: cal.kappa, Seval: SEVAL });
  const ctxNR = P.tonightContext(site, model, { nAssoc: state.nAssoc });
  noRush = evaluate(ctxNR, policyEDD(ctxNR.pallets, ctxNR.trailers), makeScenarios(ctxNR.model, ctxNR.pstats, SEVAL, 202, { kappa: cal.kappa }));
  state.sel = ranked.actions[0].key;
  state.ms = performance.now() - t0;
}
async function replan() {
  if (state.busy) return;
  state.busy = true;
  $('status').textContent = 'Re-planning…';
  await tick(); await tick();
  replanSync();
  state.busy = false;
  render();
}

function wire() {
  $('rushSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.dataset.v === state.rush) return;
    state.rush = b.dataset.v;
    for (const x of $('rushSeg').children) x.classList.toggle('on', x.dataset.v === state.rush);
    replan();
  });
  $('aMinus').onclick = () => { if (state.nAssoc > 1) { state.nAssoc--; $('aVal').textContent = state.nAssoc; replan(); } };
  $('aPlus').onclick = () => { if (state.nAssoc < 4) { state.nAssoc++; $('aVal').textContent = state.nAssoc; replan(); } };
  $('cards').addEventListener('click', (e) => {
    const c = e.target.closest('.card'); if (!c) return;
    state.sel = c.dataset.k; renderSelection();
  });
}

const PHRASE = {
  reseq: () => 'Re-sequencing dispatch',
  maint: (a) => `Servicing ${a.robot} now`,
  'maint+reseq': (a) => `Servicing ${a.robot} now and re-sequencing dispatch`,
  assoc: () => 'Adding a floor associate',
};
function selected() { return ranked.actions.find((a) => a.key === state.sel) || ranked.actions[0]; }

function render() {
  const t = site.tonight, ctx = ranked.base.ctx;
  const nPal = ctx.pallets.length, nCases = ctx.pallets.reduce((a, p) => a + p.skus.length, 0);
  const top = ranked.actions[0], b = ranked.baseline;
  const store = site.stores.find((s) => s.id === site.rush.store);
  const rushOn = state.rush === 'accept';
  const tr = t.trailers[site.rush.trailer];
  $('sitePill').textContent = `${site.siteName} · Shift 2 · Tue 10 Nov`;
  const ink = (x) => `<span class="ink">${x}</span>`;
  $('heroText').innerHTML = `<span class="caption caption-blue">Shift plan</span>` + (rushOn
    ? `Accepting the rush order for ${store.name} drops the chance that all ${t.trailers.length} trailers leave on time from ${ink(pct(noRush.pAllOn))} to ${ink(pct(b.pAllOn))}. ${PHRASE[top.key](top)} gets it back to ${ink(pct(top.eval.pAllOn))}.`
    : `There is ${aOrAn(b.pAllOn)} ${ink(pct(b.pAllOn))} chance that all ${t.trailers.length} trailers leave on time tonight. ${PHRASE[top.key](top)} raises it to ${ink(pct(top.eval.pAllOn))}.`);
  const fact = (k, v) => `<div class="fact"><span class="caption caption-white">${k}:</span><span class="caption caption-white v">${v}</span></div>`;
  $('facts').innerHTML = fact('Shift', `${site.shiftStart}–${site.shiftEnd}`) + fact('Fleet', `${ctx.robots.length} robots · ${state.nAssoc} associates`)
    + fact('Work', `${nPal} pallets · ${fmt(nCases)} cases`) + fact('Rush order', rushOn ? `Store ${store.id} · ${site.rush.pallets.length} pallets · ${tr.id}` : 'Declined');
  $('scenarioCount').textContent = `${fmt(SEVAL)} sampled shifts per plan`;
  $('status').textContent = `${ranked.actions.length} actions scored on the same sampled shifts`;
  $('actCount').textContent = `Baseline: departure-order dispatch, ${pct(b.pAllOn)} all on time`;
  $('cards').innerHTML = ranked.actions.map((a, i) => `
    <li><button class="card" data-k="${a.key}">
      <div class="t"><h4 class="headline">${a.label}${i === 0 ? '<span class="caption tag">Best</span>' : ''}</h4><p class="caption">${a.detail}</p></div>
      <div class="num"><div class="big">${pts(a.delta.mean)} ${ptsUnit(a.delta.mean)}</div>
        <p class="caption">P(all on time) ${pct(b.pAllOn)} → ${pct(a.eval.pAllOn)}</p>
        <p class="caption">90% CI ${pts(a.delta.lo)} to ${pts(a.delta.hi)} pts · paired</p></div>
      ${ARROW}
    </button></li>`).join('');
  $('trCount').textContent = `${t.trailers.length} trailers · load cutoff ${site.loadSec / 60} min before departure`;
  $('modelCount').textContent = `Fit on ${fmt(model.nPicks)} logged picks from ${split.train.length} shifts`;
  renderModel();
  renderSelection();
}

function renderSelection() {
  const a = selected();
  for (const c of $('cards').querySelectorAll('.card')) c.classList.toggle('sel', c.dataset.k === a.key);
  renderTrailers(a);
  renderGantt(a);
}

// ---------- trailers ----------
const T0 = 0, T1 = 9 * 3600; // 15:00 .. 24:00
function renderTrailers(a) {
  const base = P.trailerSummary(ranked.base.ctx, ranked.baseline);
  const plan = P.trailerSummary(a.ctx, a.eval);
  const W = 560, H = 22;
  const x = (s) => ((s - T0) / (T1 - T0)) * W;
  const axis = `<svg width="${W}" height="14" viewBox="0 0 ${W} 14">${[1, 3, 5, 7, 9].map((h) => `<text x="${x(h * 3600)}" y="10" text-anchor="${h === 9 ? 'end' : 'middle'}">${clock(h * 3600)}</text>`).join('')}</svg>`;
  const rows = plan.map((p, i) => {
    const q = base[i];
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#d9d2cf"/>
      <rect x="${x(q.lo)}" y="4" width="${Math.max(2, x(q.hi) - x(q.lo))}" height="4" rx="2" fill="#bdb3af"/>
      <rect x="${x(p.lo)}" y="11" width="${Math.max(2, x(p.hi) - x(p.lo))}" height="7" rx="3.5" fill="#3ea4e4"/>
      <circle cx="${x(p.median)}" cy="14.5" r="3" fill="#000"/>
      <line x1="${x(p.depart)}" x2="${x(p.depart)}" y1="1" y2="${H - 1}" stroke="#000" stroke-width="2"/>
    </svg>`;
    const cls = (v) => (v < 0.9 ? 'warn' : 'ok');
    return `<tr><td>${p.id}${p.rush ? '<span class="rushmark">RUSH</span>' : ''}</td><td class="m">${p.door}</td><td class="m">${p.departLabel}</td><td class="m">${p.stores.length}</td><td class="m">${p.pallets} · ${fmt(p.cases)}</td>
      <td class="tl">${svg}</td><td class="r"><span class="pon prev">${pct(q.pOn)}</span></td><td class="r"><span class="pon ${cls(p.pOn)}">${pct(p.pOn)}</span></td></tr>`;
  }).join('');
  $('trailers').innerHTML = `<tr><th>Trailer</th><th>Door</th><th>Departs</th><th>Stores</th><th>Pallets · cases</th><th>${axis}</th><th class="r">Departure order</th><th class="r">With action</th></tr>${rows}`;
  $('trLegend').innerHTML = `<span><i class="sw" style="background:#bdb3af;height:4px"></i>Departure-order dispatch: 80% ready-time band</span><span><i class="sw" style="background:#3ea4e4"></i>With "${a.label}"</span><span><i class="sw" style="background:#000;width:10px;border-radius:50%"></i>Median ready</span><span><i class="sw" style="background:#000;width:2px;height:14px"></i>Departure</span>`;
}

// ---------- gantt ----------
function renderGantt(a) {
  const ctx = a.ctx;
  const sim = P.expectedTimeline(ctx, a.order, a.avoid);
  const W = 1290, L = 96, rowH = 34, top = 30, n = ctx.robots.length, H = top + n * rowH + 24;
  const x = (s) => L + ((s - T0) / (T1 - T0)) * (W - L - 10);
  const rmult = Object.fromEntries(ctx.model.robots.map((r) => [r.id, r]));
  let g = '';
  for (let h = 0; h <= 9; h++) g += `<line x1="${x(h * 3600)}" x2="${x(h * 3600)}" y1="${top - 6}" y2="${top + n * rowH}" stroke="#e2dad6"/><text x="${x(h * 3600)}" y="${H - 6}" text-anchor="${h === 9 ? 'end' : h === 0 ? 'start' : 'middle'}">${clock(h * 3600)}</text>`;
  ctx.trailers.forEach((t) => { g += `<line x1="${x(t.depart)}" x2="${x(t.depart)}" y1="${top - 10}" y2="${top + n * rowH}" stroke="#000" stroke-width="1" stroke-dasharray="2 3"/><text x="${x(t.depart)}" y="${top - 14}" text-anchor="middle" style="fill:#000">${t.id.slice(2)}</text>`; });
  ctx.robots.forEach((r, i) => {
    const y = top + i * rowH;
    const flagged = r.degraded || (a.key.startsWith('maint') && r.id === a.robot);
    g += `<text x="0" y="${y + rowH / 2 + 4}" style="fill:${flagged ? '#3ea4e4' : '#000'}">${r.id}${r.degraded ? ' ' + rmult[r.id].mult.toFixed(1) + '×' : ''}</text>`;
    if (r.free > 0) g += `<rect x="${x(0)}" y="${y + 5}" width="${x(r.free) - x(0)}" height="${rowH - 10}" rx="4" fill="url(#hatch)"/>`;
  });
  ctx.pallets.forEach((p, j) => {
    const ri = sim.robotOf[j]; if (ri < 0) return;
    const y = top + ri * rowH, x0 = x(sim.start[j]), x1 = x(sim.complete[j]);
    const fill = p.rush ? '#000' : p.trailer % 2 ? '#b9dcf4' : '#3ea4e4';
    g += `<rect x="${x0 + 0.5}" y="${y + 5}" width="${Math.max(1, x1 - x0 - 1)}" height="${rowH - 10}" rx="4" fill="${fill}"><title>${ctx.trailers[p.trailer].id} · store ${p.store} · ${p.skus.length} cases · ${clock(sim.start[j])}–${clock(sim.complete[j])}</title></rect>`;
    if (x1 - x0 > 30) g += `<text x="${(x0 + x1) / 2}" y="${y + rowH / 2 + 3.5}" text-anchor="middle" style="fill:${p.rush ? '#fff' : p.trailer % 2 ? '#1d4f73' : '#fff'}">${ctx.trailers[p.trailer].id.slice(2)}</text>`;
  });
  $('gantt').innerHTML = `<svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#e2dad6"/><line x1="0" y1="0" x2="0" y2="6" stroke="#808080" stroke-width="2"/></pattern></defs>${g}</svg>`;
  const nAv = a.avoid ? a.avoid.reduce((s, v) => s + v, 0) : 0;
  $('ganttCount').textContent = `${a.label} · expected timeline`;
  $('ganttLegend').innerHTML = `<span><i class="sw" style="background:#3ea4e4"></i><i class="sw" style="background:#b9dcf4"></i>Pallets, by trailer</span><span><i class="sw" style="background:#000"></i>Rush pallets</span><span><i class="sw" style="background:repeating-linear-gradient(45deg,#808080 0 2px,#e2dad6 2px 6px)"></i>Service window</span><span>Dashed: departures</span>${nAv ? `<span>Keeps flagged robots off ${nAv} high-risk pallets</span>` : ''}`;
}

// ---------- model panels ----------
function renderModel() {
  const c = cal;
  const hist = new Array(10).fill(0);
  c.test.pits.forEach((u) => hist[Math.min(9, Math.floor(u * 10))]++);
  const W = 560, H = 120, mx = Math.max(...hist, c.test.n / 10) * 1.15;
  const bw = W / 10;
  let bars = hist.map((v, i) => `<rect x="${i * bw + 3}" y="${H - (v / mx) * H}" width="${bw - 6}" height="${(v / mx) * H}" rx="3" fill="#3ea4e4"/>`).join('');
  const ref = H - (c.test.n / 10 / mx) * H;
  bars += `<line x1="0" x2="${W}" y1="${ref}" y2="${ref}" stroke="#000" stroke-dasharray="3 3"/><text x="0" y="-4" style="fill:#000">- - - perfectly calibrated (flat)</text>`;
  $('calPanel').innerHTML = `<h4 class="headline" style="font-size:22px;line-height:26px">Ready-time bands are calibrated</h4>
    <p class="sub" style="margin-top:8px">The scenario spread was tuned on ${c.nCalShifts} past shifts so 80% bands cover 80% of trailers, then checked on ${c.nTestShifts} later shifts it never saw.</p>
    <div class="statrow"><div class="stat"><span class="caption">Test coverage</span><div class="v blue">${pct(c.test.coverage)}</div></div>
    <div class="stat"><span class="caption">Independent picks</span><div class="v">${pct(c.naiveTest.coverage)}</div></div>
    <div class="stat"><span class="caption">Band width</span><div class="v">${Math.round(c.test.widthMin)} min</div></div></div>
    <svg width="100%" viewBox="0 -14 ${W} ${H + 30}">${bars}<text x="0" y="${H + 14}">0</text><text x="${W / 2}" y="${H + 14}" text-anchor="middle">where the actual ready time fell in the forecast (PIT)</text><text x="${W}" y="${H + 14}" text-anchor="end">1</text></svg>
    <p class="note">${c.test.n} trailers on test shifts. Spread multiplier κ = ${c.kappa} chosen from ${P.KAPPAS.join(', ')}. A model that treats every pick as independent misses shift-wide slowdowns (shift-level sd ${(model.shiftSd * 100).toFixed(1)}% of cycle time) and is overconfident.</p>`;

  const rs = model.robots;
  const lo = 0.5, hi = 3;
  const RW = 560, rowH = 26, L = 46;
  const lx = (v) => L + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (RW - L - 10);
  let rg = [0.5, 1, 2, 3].map((v) => `<line x1="${lx(v)}" x2="${lx(v)}" y1="0" y2="${rs.length * rowH}" stroke="${v === 1 ? '#000' : '#e2dad6'}"/><text x="${lx(v)}" y="${rs.length * rowH + 14}" text-anchor="middle">${v}×</text>`).join('');
  rs.forEach((r, i) => {
    const y = i * rowH + rowH / 2;
    const flag = r.lo > 1.3;
    rg += `<text x="0" y="${y + 4}" style="fill:${flag ? '#3ea4e4' : '#000'}">${r.id}</text><line x1="${lx(Math.max(lo, r.lo))}" x2="${lx(Math.min(hi, r.hi))}" y1="${y}" y2="${y}" stroke="${flag ? '#3ea4e4' : '#808080'}" stroke-width="6" stroke-linecap="round"/><circle cx="${lx(r.mult)}" cy="${y}" r="5" fill="${flag ? '#3ea4e4' : '#000'}" stroke="#f2ecea" stroke-width="2"/><text x="${RW}" y="${y + 4}" text-anchor="end" style="fill:${flag ? '#3ea4e4' : '#808080'}">${r.mult.toFixed(2)}×</text>`;
  });
  const flagged = rs.filter((r) => r.lo > 1.3);
  $('robotPanel').innerHTML = `<h4 class="headline" style="font-size:22px;line-height:26px">Pick reliability by robot</h4>
    <p class="sub" style="margin-top:8px">Intervention rate relative to a typical robot, after adjusting for what each robot picked (pack type, weight, height). Gamma-Poisson shrinkage, 90% intervals.</p>
    <div class="statrow"><div class="stat"><span class="caption">Picks logged</span><div class="v">${fmt(model.nPicks)}</div></div>
    <div class="stat"><span class="caption">Interventions</span><div class="v">${fmt(model.nIv)}</div></div>
    <div class="stat"><span class="caption">Flagged</span><div class="v blue">${flagged.map((r) => r.id).join(', ') || 'None'}</div></div></div>
    <svg width="100%" viewBox="0 -6 ${RW} ${rs.length * rowH + 24}">${rg}</svg>
    <p class="note">${flagged.length ? `${flagged[0].id} needs help on ${flagged[0].mult.toFixed(1)}× as many picks as a typical robot (90% interval ${flagged[0].lo.toFixed(1)}–${flagged[0].hi.toFixed(1)}×). The service action assumes a 20-minute fix restores typical reliability; the planner also keeps flagged robots off the riskiest pallets.` : 'No robot is clearly worse than the fleet.'}</p>`;
}

main().catch((e) => { console.error(e); $('loadMsg').textContent = 'Failed to load: ' + e.message; });
