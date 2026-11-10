// End-to-end pipeline shared by the page and the tests: fit -> calibrate -> plan -> rank actions.
import {
  fitModel, palletStats, makeScenarios, evaluate, optimize, policyEDD, policyWMS,
  simulate, modelRealizer, trailerReady, empiricalCdf, quantile,
} from './shiftplan.js';

export function prepareHistory(history) {
  for (const sh of history.shifts) for (const p of sh.pallets) if (p.iv) p.ivSet = new Set(p.iv);
  return {
    train: history.shifts.filter((s) => s.split === 'train'),
    cal: history.shifts.filter((s) => s.split === 'cal'),
    test: history.shifts.filter((s) => s.split === 'test'),
  };
}

// Predictive samples of each trailer's ready time for a past shift, under the policy it ran (EDD).
export function predictShift(site, model, sh, S, seed, scOpts = {}) {
  const pstats = sh.pallets.map((p) => palletStats(site, model, p.skus));
  const sc = makeScenarios(model, pstats, S, seed, scOpts);
  const order = policyEDD(sh.pallets, sh.trailers);
  const T = sh.trailers.length;
  const samples = Array.from({ length: T }, () => new Float64Array(S));
  for (let s = 0; s < S; s++) {
    const sim = simulate(order, site.robots, sh.nAssoc, modelRealizer(model, pstats, sc, s));
    const r = trailerReady(sh.trailers, sh.pallets, sim.complete, site.loadSec);
    for (let i = 0; i < T; i++) samples[i][s] = r[i];
  }
  return samples.map((a) => Array.from(a).sort((x, y) => x - y));
}

// Coverage of the central (1-alpha) band and PITs for a set of shifts.
export function bandCoverage(site, model, shifts, S, scOpts, alpha = 0.2, seedBase = 0) {
  let n = 0, cov = 0, width = 0, onPred = 0, onObs = 0;
  const pits = [];
  shifts.forEach((sh, k) => {
    const smp = predictShift(site, model, sh, S, 1000 + seedBase + k, scOpts);
    sh.trailers.forEach((t, i) => {
      const a = quantile(smp[i], alpha / 2), b = quantile(smp[i], 1 - alpha / 2);
      n++; if (t.ready >= a && t.ready <= b) cov++; width += b - a;
      pits.push(empiricalCdf(smp[i], t.ready));
      onPred += empiricalCdf(smp[i], t.depart); onObs += t.ready <= t.depart ? 1 : 0;
    });
  });
  return { n, coverage: cov / n, widthMin: width / n / 60, pits, onPred: onPred / n, onObs: onObs / n };
}

// Split calibration of the scenario generator: choose the spread multiplier kappa on the
// calibration shifts so the 80% band covers 80%, then report coverage on untouched test shifts.
export const KAPPAS = [1, 1.25, 1.5, 2, 2.5];
export function calibrate(site, model, split, { S = 100, alpha = 0.2, onProgress } = {}) {
  const grid = [];
  for (const kappa of KAPPAS) {
    grid.push({ kappa, ...bandCoverage(site, model, split.cal, S, { kappa }, alpha, 0) });
    onProgress && onProgress(grid.length / (KAPPAS.length + 2));
  }
  const best = grid.reduce((a, b) => (Math.abs(b.coverage - (1 - alpha)) < Math.abs(a.coverage - (1 - alpha)) - 1e-9 ? b : a));
  const test = bandCoverage(site, model, split.test, S, { kappa: best.kappa }, alpha, 500);
  onProgress && onProgress((KAPPAS.length + 1) / (KAPPAS.length + 2));
  const naiveTest = bandCoverage(site, model, split.test, S, { naive: true }, alpha, 500);
  onProgress && onProgress(1);
  return { grid, kappa: best.kappa, calCoverage: best.coverage, test, naiveTest, alpha, nCalShifts: split.cal.length, nTestShifts: split.test.length };
}

export function degradedRobots(model) {
  return model.robots.filter((r) => r.lo > 1.3).map((r) => r.id);
}

// Build the planning context for tonight under a set of options.
// opts: {nAssoc, rush:false|trailerIndex, maint: robotId|null (swap at shift start), kappa}
export const MAINT_SEC = 20 * 60;
export function tonightContext(site, model, opts = {}) {
  const t = site.tonight;
  const pallets = t.pallets.map((p) => ({ ...p }));
  if (opts.rush !== undefined && opts.rush !== false && opts.rush !== null) {
    const base = pallets.length;
    site.rush.pallets.forEach((ids, k) => pallets.push({ trailer: opts.rush, store: site.rush.store, release: base + k, skus: ids, rush: true }));
  }
  let m = model;
  const degraded = new Set(degradedRobots(model));
  if (opts.maint) {
    m = { ...model, robots: model.robots.map((r) => (r.id === opts.maint ? { ...r, mult: 1, lo: 1, hi: 1 } : r)) };
    degraded.delete(opts.maint);
  }
  const robots = site.robots.map((r) => ({ id: r.id, free: r.id === opts.maint ? MAINT_SEC : 0, degraded: degraded.has(r.id) }));
  const pstats = pallets.map((p) => palletStats(site, m, p.skus));
  return { site, model: m, pstats, pallets, trailers: t.trailers, robots, nAssoc: opts.nAssoc ?? t.nAssoc, opts };
}

// Paired difference in P(all trailers on time) between two evaluations on the same scenarios.
export function pairedDelta(a, b) {
  const S = a.allOnBy.length;
  let sum = 0, sq = 0;
  for (let s = 0; s < S; s++) { const d = b.allOnBy[s] - a.allOnBy[s]; sum += d; sq += d * d; }
  const mean = sum / S, sd = Math.sqrt(Math.max(0, sq / S - mean * mean));
  const se = sd / Math.sqrt(S);
  return { mean, lo: mean - 1.645 * se, hi: mean + 1.645 * se };
}

// Plan one context: EDD baseline vs SAA-optimized dispatch, scored on fresh scenarios.
export function planContext(ctx, { kappa = 1, Sopt = 100, Seval = 500, iters = 350, seedOpt = 101, seedEval = 202 } = {}) {
  const scOpt = makeScenarios(ctx.model, ctx.pstats, Sopt, seedOpt, { kappa });
  const opt = optimize(ctx, scOpt, { iters });
  const scEval = makeScenarios(ctx.model, ctx.pstats, Seval, seedEval, { kappa });
  const edd = policyEDD(ctx.pallets, ctx.trailers);
  return {
    order: opt.order, avoid: opt.avoid, eddOrder: edd,
    edd: evaluate(ctx, edd, scEval), plan: evaluate(ctx, opt.order, scEval, opt.avoid),
    inSample: { edd: evaluate(ctx, edd, scOpt).objective, plan: opt.eval.objective }, accepted: opt.accepted,
  };
}

// Rank operational actions by their paired effect on P(all trailers on time).
export function rankActions(site, model, base, { kappa = 1, Seval = 500, iters = 350, onProgress } = {}) {
  const steps = [];
  const prog = () => onProgress && onProgress(steps.length / 6);
  const ctx0 = tonightContext(site, model, base);
  const p0 = planContext(ctx0, { kappa, Seval, iters }); steps.push(1); prog();
  const out = { base: { ctx: ctx0, plan: p0 }, actions: [] };
  const baseline = p0.edd;
  out.actions.push({ key: 'reseq', label: 'Re-sequence dispatch', detail: 'New pallet priority order and robot matching, same robots and staff', eval: p0.plan, ctx: ctx0, order: p0.order, avoid: p0.avoid, delta: pairedDelta(baseline, p0.plan) });
  const deg = degradedRobots(model).filter((id) => id !== base.maint);
  let ctxM = null, pM = null;
  if (deg.length) {
    const worst = model.robots.filter((r) => deg.includes(r.id)).sort((a, b) => b.mult - a.mult)[0];
    ctxM = tonightContext(site, model, { ...base, maint: worst.id });
    pM = planContext(ctxM, { kappa, Seval, iters });
    out.actions.push({ key: 'maint', robot: worst.id, label: `Service ${worst.id} now`, detail: `${MAINT_SEC / 60} min down at 15:00 for gripper service, then typical pick reliability`, eval: pM.edd, ctx: ctxM, order: pM.eddOrder, avoid: null, delta: pairedDelta(baseline, pM.edd) });
    out.actions.push({ key: 'maint+reseq', robot: worst.id, label: `Service ${worst.id} + re-sequence`, detail: 'Both changes, re-optimized together', eval: pM.plan, ctx: ctxM, order: pM.order, avoid: pM.avoid, delta: pairedDelta(baseline, pM.plan) });
  }
  steps.push(1); prog();
  const ctxA = tonightContext(site, model, { ...base, nAssoc: (base.nAssoc ?? site.tonight.nAssoc) + 1 });
  const pA = planContext(ctxA, { kappa, Seval, iters: 0 }); steps.push(1); prog();
  out.actions.push({ key: 'assoc', label: 'Add a floor associate', detail: `${ctxA.nAssoc} associates clearing interventions all shift`, eval: pA.edd, ctx: ctxA, order: pA.eddOrder, avoid: null, delta: pairedDelta(baseline, pA.edd) });
  out.actions.sort((a, b) => b.delta.mean - a.delta.mean);
  steps.push(1); prog();
  out.baseline = baseline;
  return out;
}

// Per-trailer summary for one evaluated plan.
export function trailerSummary(ctx, evalRes, alpha = 0.2) {
  return ctx.trailers.map((t, i) => {
    const smp = Array.from(evalRes.ready[i]).sort((a, b) => a - b);
    const ps = ctx.pallets.filter((p) => p.trailer === i);
    return {
      ...t, i,
      pOn: empiricalCdf(smp, t.depart),
      median: quantile(smp, 0.5), lo: quantile(smp, alpha / 2), hi: quantile(smp, 1 - alpha / 2),
      pallets: ps.length, cases: ps.reduce((a, p) => a + p.skus.length, 0), rush: ps.some((p) => p.rush),
    };
  });
}

// Deterministic expected timeline for the Gantt: mean work, expected intervention time folded in.
export function expectedTimeline(ctx, order, avoid) {
  const mult = Object.fromEntries(ctx.model.robots.map((x) => [x.id, x.mult]));
  const meanWalk = avg(ctx.model.walk), meanFix = avg(ctx.model.fix), meanCh = avg(ctx.model.change);
  const realize = (j, rid) => ({ W: ctx.pstats[j].mu + ctx.pstats[j].lam * (mult[rid] ?? 1) * (meanWalk + meanFix), iv: [], change: meanCh });
  return simulate(order, ctx.robots, ctx.nAssoc, realize, false, avoid);
}
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
