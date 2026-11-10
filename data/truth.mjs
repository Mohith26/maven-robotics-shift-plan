// Ground-truth site physics used ONLY to generate synthetic fleet logs and history.
// The planner in core/shiftplan.js never reads these parameters; it fits its own
// model from the logs this produces. Truth is deliberately richer than the model
// (per-case retries, Bernoulli interventions, lognormal noise) so the model is an
// approximation and calibration has something real to check.
import { mulberry32, hashSeed, normal, placement } from '../core/shiftplan.js';

export const TRUTH = {
  base: 9.0, // s: grasp + place
  speed: 2.2, // m/s effective average while carrying (4 m/s top speed)
  kW: 0.18, // s per kg
  kH: 2.6, // s per m of placement height (telescoping pillar)
  pkExtra: [0, 1.5, 3.0, 0.8],
  pkNoise: [0.1, 0.14, 0.22, 0.16],
  retryP: [0.02, 0.05, 0.09, 0.07],
  retryS: [7, 12],
  ivBase: -6.0,
  ivPk: [0, 0.9, 1.4, 1.1],
  ivW: 0.06,
  ivH: 0.6,
  robotMult: { 'R-01': 1.05, 'R-02': 0.9, 'R-03': 1.15, 'R-04': 0.85, 'R-05': 1.0, 'R-06': 0.95, 'R-07': 2.4, 'R-08': 1.1 },
  shiftSd: 0.05,
  walk: [60, 180],
  fixMedian: 150,
  fixSd: 0.5,
  change: [70, 115],
};

export function truthCase(sku, h, rng) {
  const T = TRUTH;
  const mean = T.base + (2 * sku.dist) / T.speed + T.kW * sku.w + T.kH * h + T.pkExtra[sku.pk];
  let t = mean * Math.exp(T.pkNoise[sku.pk] * normal(rng) - 0.5 * T.pkNoise[sku.pk] ** 2);
  if (rng() < T.retryP[sku.pk] + 0.002 * sku.w) t += T.retryS[0] + rng() * (T.retryS[1] - T.retryS[0]);
  const eta = T.ivBase + T.ivPk[sku.pk] + T.ivW * sku.w + T.ivH * h;
  const pIv = 1 / (1 + Math.exp(-eta));
  return { t, pIv, uIv: rng() };
}

// Realizer for the shared event simulator: pallet j on robot id in a given shift.
export function truthRealizer(site, pallets, shiftSeed, delta) {
  const cache = new Map();
  return function (j, robotId) {
    const key = j;
    let cs = cache.get(key);
    if (!cs) {
      const rng = mulberry32(hashSeed(shiftSeed, j, 99));
      const ids = pallets[j].skus;
      const pl = placement(site.skus, ids);
      const cases = new Array(ids.length);
      for (const i of pl.order) cases[i] = truthCase(site.skus[ids[i]], pl.h[i], rng);
      const ivr = mulberry32(hashSeed(shiftSeed, j, 7));
      const ivDraw = [];
      for (let q = 0; q < ids.length; q++) {
        const walk = TRUTH.walk[0] + ivr() * (TRUTH.walk[1] - TRUTH.walk[0]);
        const fix = TRUTH.fixMedian * Math.exp(TRUTH.fixSd * normal(ivr));
        ivDraw.push([walk, fix]);
      }
      cs = { cases, order: pl.order, change: TRUTH.change[0] + rng() * (TRUTH.change[1] - TRUTH.change[0]), ivDraw };
      cache.set(key, cs);
    }
    const m = TRUTH.robotMult[robotId] ?? 1;
    const f = Math.exp(delta);
    let tcum = 0;
    const iv = [], cycle = new Array(cs.cases.length), ivIdx = [];
    for (const i of cs.order) {
      const c = cs.cases[i];
      const t = c.t * f;
      cycle[i] = t;
      if (c.uIv < Math.min(1, c.pIv * m)) { iv.push([tcum, cs.ivDraw[i][0], cs.ivDraw[i][1]]); ivIdx.push(i); }
      tcum += t;
    }
    return { W: tcum, iv, change: cs.change, cycle, ivIdx };
  };
}
