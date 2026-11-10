// Shift Plan core: fit a pick-level model from fleet logs, sample shift scenarios,
// simulate a dispatch policy with shared floor associates, optimize the dispatch
// priority list by sample average approximation, and recalibrate trailer-ready
// probabilities on held-out shifts. Pure ES module, no dependencies; runs in the
// browser and in `node --test`.

// ---------- random numbers ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(...xs) {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    h ^= x >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}
export function normal(rng) {
  let u = rng();
  while (u <= 1e-12) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// Poisson inverse CDF: monotone in lambda for a fixed u (common random numbers).
export function poissonInv(u, lambda, cap = 12) {
  let k = 0, p = Math.exp(-lambda), c = p;
  while (u > c && k < cap) { k++; p *= lambda / k; c += p; }
  return k;
}

// ---------- small linear algebra / stats ----------
export function solveSPD(A, b) {
  // Cholesky solve for a small symmetric positive definite system.
  const n = b.length, L = A.map((r) => r.slice());
  for (let j = 0; j < n; j++) {
    let s = L[j][j];
    for (let k = 0; k < j; k++) s -= L[j][k] * L[j][k];
    if (s <= 0) s = 1e-10;
    L[j][j] = Math.sqrt(s);
    for (let i = j + 1; i < n; i++) {
      let t = L[i][j];
      for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / L[j][j];
    }
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) { let t = b[i]; for (let k = 0; k < i; k++) t -= L[i][k] * y[k]; y[i] = t / L[i][i]; }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let t = y[i]; for (let k = i + 1; k < n; k++) t -= L[k][i] * x[k]; x[i] = t / L[i][i]; }
  return x;
}
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
// Gamma(shape a, rate b) quantile via Wilson-Hilferty (good for a >= ~2).
export function gammaQuantile(p, a, b) {
  const z = normInv(p);
  const x = a * Math.pow(1 - 1 / (9 * a) + z / (3 * Math.sqrt(a)), 3);
  return Math.max(0, x) / b;
}
export function normInv(p) {
  // Acklam's rational approximation.
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- features ----------
export const PACK = ['corrugated', 'shrink', 'bag', 'coated'];
// Feature vector for one placed case. sku: {w, dist, pk}; h: placement height (m).
export function caseFeatures(sku, h) {
  const pk = sku.pk;
  return [1, Math.log(sku.dist), sku.w, h, pk === 1 ? 1 : 0, pk === 2 ? 1 : 0, pk === 3 ? 1 : 0];
}
export const NFEAT = 7;
// Placement heights for a pallet's cases: heavy cases go first (bottom), height grows
// with stacked volume. Returns {order, h} where order is the placement order of case idx.
export const FOOTPRINT_M2 = 1.2 * 1.0 * 0.85;
export function placement(skus, skuIds) {
  const idx = skuIds.map((_, i) => i).sort((a, b) => skus[skuIds[b]].w - skus[skuIds[a]].w || a - b);
  const h = new Float64Array(skuIds.length);
  let vol = 0;
  for (const i of idx) {
    const s = skus[skuIds[i]];
    h[i] = Math.min(1.8, vol / FOOTPRINT_M2);
    vol += s.vol;
  }
  return { order: idx, h };
}

// ---------- model fitting from fleet logs ----------
// logs: {shifts:[{robots:[...], pallets:[{skus:[ids], robot, cycle:[s per case, placement order], iv:[case idx...]}]}]}
export function fitModel(site, trainShifts) {
  const { skus } = site;
  // 1) log cycle-time regression with a shift random effect (method of moments).
  const XtX = Array.from({ length: NFEAT }, () => new Array(NFEAT).fill(0));
  const Xty = new Array(NFEAT).fill(0);
  const rows = []; // [shiftIdx, pk, logt, x]
  trainShifts.forEach((sh, si) => {
    for (const p of sh.pallets) {
      const pl = placement(skus, p.skus);
      p.skus.forEach((id, i) => {
        const x = caseFeatures(skus[id], pl.h[i]);
        const y = Math.log(p.cycle[i]);
        rows.push([si, skus[id].pk, y, x, id, pl.h[i], p.robot, p.ivSet ? p.ivSet.has(i) : p.iv.includes(i)]);
        for (let a = 0; a < NFEAT; a++) { Xty[a] += x[a] * y; for (let b = 0; b < NFEAT; b++) XtX[a][b] += x[a] * x[b]; }
      });
    }
  });
  for (let a = 0; a < NFEAT; a++) XtX[a][a] += 1e-6;
  const beta = solveSPD(XtX, Xty);
  const nS = trainShifts.length;
  const sum = new Float64Array(nS), cnt = new Float64Array(nS);
  const resid = new Float64Array(rows.length);
  rows.forEach((r, k) => { let m = 0; for (let a = 0; a < NFEAT; a++) m += beta[a] * r[3][a]; resid[k] = r[2] - m; sum[r[0]] += resid[k]; cnt[r[0]]++; });
  const shiftMean = Array.from(sum, (s, i) => s / cnt[i]);
  // within-shift residuals by packaging class -> moments of exp(e)
  const m1 = [0, 0, 0, 0], m2 = [0, 0, 0, 0], nc = [0, 0, 0, 0];
  let wss = 0;
  rows.forEach((r, k) => { const e = resid[k] - shiftMean[r[0]]; wss += e * e; const pk = r[1]; m1[pk] += Math.exp(e); m2[pk] += Math.exp(2 * e); nc[pk]++; });
  for (let c = 0; c < 4; c++) { m1[c] /= Math.max(1, nc[c]); m2[c] /= Math.max(1, nc[c]); }
  const sw2 = wss / Math.max(1, rows.length - nS);
  const mu = shiftMean.reduce((a, b) => a + b, 0) / nS;
  const vb = shiftMean.reduce((a, b) => a + (b - mu) * (b - mu), 0) / Math.max(1, nS - 1);
  const meanInvN = Array.from(cnt).reduce((a, n) => a + 1 / n, 0) / nS;
  const shiftSd = Math.sqrt(Math.max(0, vb - sw2 * meanInvN));

  // 2) intervention model: logistic regression with an offset for robot multipliers,
  //    alternating with empirical-Bayes Gamma-Poisson shrinkage of per-robot rates.
  const robotIds = site.robots.map((r) => r.id);
  let logm = Object.fromEntries(robotIds.map((r) => [r, 0]));
  let gam = new Array(NFEAT).fill(0);
  gam[0] = -5;
  let robotStats = null;
  for (let outer = 0; outer < 3; outer++) {
    for (let it = 0; it < 12; it++) {
      const H = Array.from({ length: NFEAT }, () => new Array(NFEAT).fill(0));
      const g = new Array(NFEAT).fill(0);
      for (const r of rows) {
        const x = r[3];
        let eta = logm[r[6]];
        for (let a = 0; a < NFEAT; a++) eta += gam[a] * x[a];
        const p = 1 / (1 + Math.exp(-eta));
        const wgt = p * (1 - p), y = r[7] ? 1 : 0;
        for (let a = 0; a < NFEAT; a++) { g[a] += (y - p) * x[a]; for (let b = 0; b < NFEAT; b++) H[a][b] += wgt * x[a] * x[b]; }
      }
      for (let a = 0; a < NFEAT; a++) { H[a][a] += 1e-4; g[a] -= 1e-4 * gam[a]; }
      const step = solveSPD(H, g);
      let mx = 0;
      for (let a = 0; a < NFEAT; a++) { gam[a] += step[a]; mx = Math.max(mx, Math.abs(step[a])); }
      if (mx < 1e-7) break;
    }
    // per-robot observed vs expected (without robot offset)
    const obs = {}, exp = {};
    for (const id of robotIds) { obs[id] = 0; exp[id] = 0; }
    for (const r of rows) {
      let eta = 0; for (let a = 0; a < NFEAT; a++) eta += gam[a] * r[3][a];
      exp[r[6]] += 1 / (1 + Math.exp(-eta)); if (r[7]) obs[r[6]]++;
    }
    // Normalize so the fleet-average multiplier is 1, then method-of-moments prior.
    const ratios = robotIds.map((id) => obs[id] / exp[id]);
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const varR = ratios.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, ratios.length - 1);
    const poisNoise = robotIds.reduce((a, id) => a + mean / exp[id], 0) / robotIds.length;
    const tau2 = Math.max(0.01, (varR - poisNoise) / (mean * mean));
    const a0 = 1 / tau2;
    // Gamma(a0, a0/mean) prior on each robot's multiplier; Poisson likelihood.
    robotStats = robotIds.map((id) => {
      const A = a0 + obs[id], B = a0 / mean + exp[id];
      return { id, observed: obs[id], expected: exp[id], mult: A / B, lo: gammaQuantile(0.05, A, B), hi: gammaQuantile(0.95, A, B) };
    });
    // Express multipliers relative to the fleet median robot so the intercept is a typical robot.
    const med = robotStats.map((s) => s.mult).sort((a, b) => a - b);
    const m0 = (med[(med.length - 1) >> 1] + med[med.length >> 1]) / 2;
    for (const s of robotStats) { s.mult /= m0; s.lo /= m0; s.hi /= m0; s.expected *= m0; }
    gam[0] += Math.log(m0);
    logm = Object.fromEntries(robotStats.map((s) => [s.id, Math.log(s.mult)]));
  }
  // 3) empirical associate response pieces and pallet changeover.
  const walk = [], fix = [], change = [];
  for (const sh of trainShifts) {
    for (const e of sh.ivLog || []) { walk.push(e.walk); fix.push(e.fix); }
    for (const p of sh.pallets) if (p.change != null) change.push(p.change);
  }
  walk.sort((a, b) => a - b); fix.sort((a, b) => a - b); change.sort((a, b) => a - b);
  return { beta, m1, m2, shiftSd, gam, robots: robotStats, walk, fix, change, nPicks: rows.length, nIv: rows.filter((r) => r[7]).length, sw: Math.sqrt(sw2) };
}

// Mean, variance of a pallet's work time and its expected intervention count (at multiplier 1).
export function palletStats(site, model, skuIds) {
  const pl = placement(site.skus, skuIds);
  let mu = 0, v = 0, lam = 0;
  skuIds.forEach((id, i) => {
    const s = site.skus[id];
    const x = caseFeatures(s, pl.h[i]);
    let m = 0, eta = 0;
    for (let a = 0; a < NFEAT; a++) { m += model.beta[a] * x[a]; eta += model.gam[a] * x[a]; }
    const em = Math.exp(m);
    mu += em * model.m1[s.pk];
    v += em * em * (model.m2[s.pk] - model.m1[s.pk] * model.m1[s.pk]);
    lam += 1 / (1 + Math.exp(-eta));
  });
  return { mu, sd: Math.sqrt(Math.max(0, v)), lam, cases: skuIds.length };
}

// ---------- scenarios ----------
// Pre-draws common random numbers per (scenario, pallet) so that comparing two
// dispatch policies uses the same luck. opts.naive drops the shift effect and robot multipliers.
export const KMAX = 6;
export function makeScenarios(model, pstats, S, seed, opts = {}) {
  const n = pstats.length;
  const sc = { S, n, delta: new Float64Array(S), z: new Float64Array(S * n), u: new Float64Array(S * n), off: new Float64Array(S * n * KMAX), wk: new Float64Array(S * n * KMAX), fx: new Float64Array(S * n * KMAX), ch: new Float64Array(S * n), naive: !!opts.naive };
  for (let s = 0; s < S; s++) {
    const r0 = mulberry32(hashSeed(seed, s, 0xabcdef));
    const kap = opts.kappa ?? 1;
    sc.delta[s] = opts.naive ? 0 : kap * model.shiftSd * normal(r0);
    for (let j = 0; j < n; j++) {
      const r = mulberry32(hashSeed(seed, s, j + 1));
      const k = s * n + j;
      sc.z[k] = (opts.naive ? 1 : (opts.kappa ?? 1)) * normal(r);
      sc.u[k] = r();
      const offs = [];
      for (let q = 0; q < KMAX; q++) offs.push(r());
      offs.sort((a, b) => a - b);
      for (let q = 0; q < KMAX; q++) {
        sc.off[k * KMAX + q] = offs[q];
        sc.wk[k * KMAX + q] = pick(model.walk, r());
        sc.fx[k * KMAX + q] = pick(model.fix, r());
      }
      sc.ch[k] = pick(model.change, r());
    }
  }
  return sc;
}
function pick(sorted, u) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(u * sorted.length))] : 0; }

// Realization of pallet j on robot r in scenario s (model world).
export function modelRealizer(model, pstats, sc, s) {
  const mult = Object.fromEntries(model.robots.map((x) => [x.id, x.mult]));
  return function (j, robotId) {
    const k = s * sc.n + j, P = pstats[j];
    const W = Math.exp(sc.delta[s]) * Math.max(0.3 * P.mu, P.mu + P.sd * sc.z[k]);
    const m = sc.naive ? 1 : mult[robotId] ?? 1;
    const K = Math.min(KMAX, poissonInv(sc.u[k], m * P.lam));
    const iv = [];
    for (let q = 0; q < K; q++) iv.push([sc.off[k * KMAX + q] * W, sc.wk[k * KMAX + q], sc.fx[k * KMAX + q]]);
    return { W, iv, change: sc.ch[k] };
  };
}

// ---------- discrete-event simulation of a dispatch priority list ----------
// order: pallet indices in priority order. robots: [{id}], nAssoc associates shared FIFO.
// realize(j, robotId) -> {W, iv:[[offsetSec, walkSec, fixSec]...], change}
// Returns completion time (s after shift start) per pallet, robot per pallet, and intervention waits.
// avoid (optional Uint8Array by pallet): robots flagged `degraded` skip avoided pallets
// within a short look-ahead window and take the next allowed one instead.
export const LOOKAHEAD = 8;
export function simulate(order, robots, nAssoc, realize, record = false, avoid = null) {
  const n = order.length;
  const complete = new Float64Array(Math.max(...order) + 1).fill(NaN);
  const robotOf = new Array(complete.length).fill(-1);
  const start = new Float64Array(complete.length).fill(NaN);
  const assoc = new Float64Array(Math.max(1, nAssoc)).fill(0);
  const st = robots.map(() => null);
  // tiny binary heap of [t, robotIndex, type] (type 0 free, 1 intervention, 2 done)
  const ht = [], hr = [], hy = [];
  const push = (t, r, y) => {
    let i = ht.length; ht.push(t); hr.push(r); hy.push(y);
    while (i > 0) { const p = (i - 1) >> 1; if (ht[p] < ht[i] || (ht[p] === ht[i] && hr[p] <= hr[i])) break; [ht[p], ht[i]] = [ht[i], ht[p]]; [hr[p], hr[i]] = [hr[i], hr[p]]; [hy[p], hy[i]] = [hy[i], hy[p]]; i = p; }
  };
  const pop = () => {
    const t = ht[0], r = hr[0], y = hy[0];
    const lt = ht.pop(), lr = hr.pop(), ly = hy.pop();
    if (ht.length) {
      ht[0] = lt; hr[0] = lr; hy[0] = ly;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, rr = l + 1; let m = i;
        if (l < ht.length && (ht[l] < ht[m] || (ht[l] === ht[m] && hr[l] < hr[m]))) m = l;
        if (rr < ht.length && (ht[rr] < ht[m] || (ht[rr] === ht[m] && hr[rr] < hr[m]))) m = rr;
        if (m === i) break;
        [ht[m], ht[i]] = [ht[i], ht[m]]; [hr[m], hr[i]] = [hr[i], hr[m]]; [hy[m], hy[i]] = [hy[i], hy[m]]; i = m;
      }
    }
    return [t, r, y];
  };
  robots.forEach((r, i) => push(r.free || 0, i, 0));
  let next = 0, waitSum = 0, nIv = 0;
  const taken = new Uint8Array(n);
  const ivLog = record ? [] : null;
  while (ht.length) {
    const [t, ri, y] = pop();
    if (y === 0) {
      while (next < n && taken[next]) next++;
      if (next >= n) continue;
      let q = next;
      if (avoid && robots[ri].degraded) {
        let c = next, seen = 0;
        while (c < n && seen < LOOKAHEAD) { if (!taken[c]) { if (!avoid[order[c]]) { q = c; break; } seen++; } c++; }
        if (c >= n || seen >= LOOKAHEAD) q = next;
      }
      taken[q] = 1;
      const j = order[q];
      const R = realize(j, robots[ri].id);
      st[ri] = { j, R, k: 0 };
      start[j] = t; robotOf[j] = ri;
      if (R.iv.length) push(t + R.iv[0][0], ri, 1);
      else push(t + R.W + R.change, ri, 2);
    } else if (y === 1) {
      const s = st[ri], iv = s.R.iv[s.k];
      let a = 0; for (let q = 1; q < assoc.length; q++) if (assoc[q] < assoc[a]) a = q;
      const begin = Math.max(t, assoc[a]);
      const end = begin + iv[1] + iv[2];
      assoc[a] = end;
      waitSum += end - t; nIv++;
      if (ivLog) ivLog.push({ robot: ri, j: s.j, t, begin, end, walk: iv[1], fix: iv[2] });
      s.k++;
      if (s.k < s.R.iv.length) push(end + (s.R.iv[s.k][0] - iv[0]), ri, 1);
      else push(end + (s.R.W - iv[0]) + s.R.change, ri, 2);
    } else {
      complete[st[ri].j] = t;
      st[ri] = null;
      push(t, ri, 0);
    }
  }
  return { complete, robotOf, start, waitSum, nIv, ivLog };
}

// Trailer ready times: last pallet complete + load time.
export function trailerReady(trailers, pallets, complete, loadSec) {
  const ready = new Float64Array(trailers.length).fill(0);
  pallets.forEach((p, j) => { if (complete[j] > ready[p.trailer]) ready[p.trailer] = complete[j]; });
  for (let i = 0; i < ready.length; i++) ready[i] += loadSec;
  return ready;
}

// ---------- policies ----------
export function policyWMS(pallets) { return pallets.map((_, j) => j).sort((a, b) => pallets[a].release - pallets[b].release || a - b); }
export function policyEDD(pallets, trailers) {
  return pallets.map((_, j) => j).sort((a, b) => trailers[pallets[a].trailer].depart - trailers[pallets[b].trailer].depart || pallets[a].release - pallets[b].release || a - b);
}

// Evaluate a priority list over all scenarios.
export function evaluate(ctx, order, sc, avoid = null) {
  const { site, model, pstats, pallets, trailers, robots, nAssoc } = ctx;
  const T = trailers.length;
  const ready = Array.from({ length: T }, () => new Float64Array(sc.S));
  let late = 0, lateMin = 0, allOn = 0, makespan = 0, waits = 0;
  const allOnBy = new Uint8Array(sc.S);
  for (let s = 0; s < sc.S; s++) {
    const sim = simulate(order, robots, nAssoc, modelRealizer(model, pstats, sc, s), false, avoid);
    const r = trailerReady(trailers, pallets, sim.complete, site.loadSec);
    let lt = 0;
    allOnBy[s] = 0;
    for (let i = 0; i < T; i++) {
      ready[i][s] = r[i];
      const over = r[i] - trailers[i].depart;
      if (over > 0) { lt++; lateMin += over / 60; }
    }
    late += lt; if (lt === 0) { allOn++; allOnBy[s] = 1; }
    let mk = 0; for (const c of sim.complete) if (c > mk) mk = c;
    makespan += mk; waits += sim.waitSum;
  }
  return { expLate: late / sc.S, pAllOn: allOn / sc.S, expLateMin: lateMin / sc.S, makespan: makespan / sc.S, waitMin: waits / sc.S / 60, ready, allOnBy, objective: late / sc.S + 0.002 * lateMin / sc.S };
}

// SAA local search over priority lists, starting from EDD. Moves: relocate one pallet
// to an earlier/later position, or move a whole trailer block. Deterministic given seed.
export function optimize(ctx, sc, { iters = 500, seed = 7, start } = {}) {
  const { pallets, trailers } = ctx;
  let best = (start || policyEDD(pallets, trailers)).slice();
  const useAvoid = ctx.robots.some((r) => r.degraded);
  let bestAvoid = useAvoid ? new Uint8Array(pallets.length) : null;
  let bestEval = evaluate(ctx, best, sc, bestAvoid);
  const rng = mulberry32(seed);
  const n = best.length;
  let accepted = 0;
  const trace = [bestEval.objective];
  // candidates for avoid flags: pallets ranked by expected interventions
  const riskRank = pallets.map((_, j) => j).sort((a, b) => ctx.pstats[b].lam - ctx.pstats[a].lam);
  for (let it = 0; it < iters; it++) {
    const cand = best.slice();
    let candAvoid = bestAvoid;
    const mv = useAvoid ? rng() : 0.2 + 0.8 * rng(); // no avoid moves without a degraded robot
    if (useAvoid && mv < 0.2) {
      candAvoid = bestAvoid.slice();
      const j = riskRank[Math.floor(Math.pow(rng(), 2) * riskRank.length)];
      candAvoid[j] ^= 1;
    } else if (mv < 0.6) {
      const i = Math.floor(rng() * n);
      const span = Math.max(2, Math.floor(n * 0.15));
      let k = i + Math.round((rng() * 2 - 1) * span);
      k = Math.max(0, Math.min(n - 1, k));
      const [x] = cand.splice(i, 1); cand.splice(k, 0, x);
    } else if (mv < 0.85) {
      const i = Math.floor(rng() * (n - 1)), k = Math.min(n - 1, i + 1 + Math.floor(rng() * 6));
      [cand[i], cand[k]] = [cand[k], cand[i]];
    } else {
      // move all pallets of one trailer forward or back as a group
      const t = pallets[cand[Math.floor(rng() * n)]].trailer;
      const grp = cand.filter((j) => pallets[j].trailer === t);
      const rest = cand.filter((j) => pallets[j].trailer !== t);
      const firstPos = cand.indexOf(grp[0]);
      let k = Math.max(0, Math.min(rest.length, firstPos + Math.round((rng() * 2 - 1) * 12)));
      rest.splice(k, 0, ...grp);
      for (let q = 0; q < n; q++) cand[q] = rest[q];
    }
    const e = evaluate(ctx, cand, sc, candAvoid);
    if (e.objective < bestEval.objective - 1e-12) { best = cand; bestAvoid = candAvoid; bestEval = e; accepted++; }
    trace.push(bestEval.objective);
  }
  return { order: best, avoid: bestAvoid, eval: bestEval, accepted, trace };
}

// ---------- predictive CDF helpers ----------
export function empiricalCdf(sortedSamples, y) {
  let lo = 0, hi = sortedSamples.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedSamples[m] <= y) lo = m + 1; else hi = m; }
  return lo / sortedSamples.length;
}
