import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../core/shiftplan.js';
import * as P from '../core/pipeline.js';
import { TRUTH, truthRealizer } from '../data/truth.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = JSON.parse(fs.readFileSync(path.join(root, 'data/site.json')));
const history = JSON.parse(fs.readFileSync(path.join(root, 'data/history.json')));
const split = P.prepareHistory(history);
const model = S.fitModel(site, split.train);

test('rng is deterministic and normal() has unit moments', () => {
  const a = S.mulberry32(5), b = S.mulberry32(5);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
  const r = S.mulberry32(9); let m = 0, v = 0; const N = 40000;
  for (let i = 0; i < N; i++) { const z = S.normal(r); m += z; v += z * z; }
  assert.ok(Math.abs(m / N) < 0.02); assert.ok(Math.abs(v / N - 1) < 0.03);
});

test('poissonInv: monotone in lambda for fixed u, correct mean', () => {
  const r = S.mulberry32(3);
  for (let i = 0; i < 500; i++) { const u = r(); assert.ok(S.poissonInv(u, 0.4) <= S.poissonInv(u, 0.9)); }
  let sum = 0; const N = 50000; for (let i = 0; i < N; i++) sum += S.poissonInv(r(), 1.7, 40);
  assert.ok(Math.abs(sum / N - 1.7) < 0.03);
});

test('solveSPD and normInv/gammaQuantile', () => {
  const x = S.solveSPD([[4, 1], [1, 3]], [1, 2]);
  assert.ok(Math.abs(x[0] - 1 / 11) < 1e-12 && Math.abs(x[1] - 7 / 11) < 1e-12);
  assert.ok(Math.abs(S.normInv(0.975) - 1.959964) < 1e-5);
  // Gamma(50, 50): mean 1, sd ~0.1414; 95% quantile ~1.24
  assert.ok(Math.abs(S.gammaQuantile(0.95, 50, 50) - 1.2405) < 0.01);
});

test('simulator: one robot, no interventions = cumulative work plus changeovers', () => {
  const W = [100, 50, 70];
  const realize = (j) => ({ W: W[j], iv: [], change: 10 });
  const sim = S.simulate([2, 0, 1], [{ id: 'A' }], 1, realize);
  assert.deepEqual(Array.from(sim.complete), [190, 250, 80]);
});

test('simulator: shared associate serves interventions FIFO and robots wait', () => {
  // Two robots each request an associate 10 s into their pallet; one associate, walk 5 + fix 20.
  const realize = () => ({ W: 100, iv: [[10, 5, 20]], change: 0 });
  const sim = S.simulate([0, 1], [{ id: 'A' }, { id: 'B' }], 1, realize, true);
  const waits = sim.ivLog.map((e) => e.end - e.t).sort((a, b) => a - b);
  assert.deepEqual(waits, [25, 50]); // second robot waits for the first fix to finish
  assert.deepEqual(Array.from(sim.complete).sort((a, b) => a - b), [125, 150]);
  // With two associates nobody queues.
  const sim2 = S.simulate([0, 1], [{ id: 'A' }, { id: 'B' }], 2, realize);
  assert.deepEqual(Array.from(sim2.complete), [125, 125]);
});

test('simulator: a degraded robot skips avoided pallets inside the look-ahead window', () => {
  const realize = (j) => ({ W: 10 + j, iv: [], change: 0 });
  const avoid = new Uint8Array([1, 0, 0]);
  const sim = S.simulate([0, 1, 2], [{ id: 'X', degraded: true }], 1, realize, false, avoid);
  // X takes pallet 1 first, then 2, then falls back to the avoided pallet 0.
  assert.ok(sim.start[1] < sim.start[2] && sim.start[2] < sim.start[0]);
});

test('model fit: flags only the worn robot and recovers the shift effect', () => {
  const deg = P.degradedRobots(model);
  assert.deepEqual(deg, ['R-07']);
  const medTrue = Object.values(TRUTH.robotMult).sort((a, b) => a - b);
  const rel = TRUTH.robotMult['R-07'] / ((medTrue[3] + medTrue[4]) / 2);
  const r7 = model.robots.find((r) => r.id === 'R-07');
  assert.ok(r7.lo <= rel && rel <= r7.hi * 1.02, `R-07 ${r7.lo}-${r7.hi} vs ${rel}`);
  assert.ok(Math.abs(model.shiftSd - TRUTH.shiftSd) / TRUTH.shiftSd < 0.3);
  // heavier cases and higher placements are slower (positive coefficients)
  assert.ok(model.beta[2] > 0 && model.beta[3] > 0);
  assert.ok(model.nPicks > 100000);
});

test('CRN: identical policies give zero paired delta; maintenance never adds interventions', () => {
  const ctx = P.tonightContext(site, model, {});
  const sc = S.makeScenarios(ctx.model, ctx.pstats, 60, 4, { kappa: 1.25 });
  const order = S.policyEDD(ctx.pallets, ctx.trailers);
  const a = S.evaluate(ctx, order, sc), b = S.evaluate(ctx, order, sc);
  assert.equal(P.pairedDelta(a, b).mean, 0);
  const ctxM = P.tonightContext(site, model, { maint: 'R-07' });
  const r0 = S.modelRealizer(ctx.model, ctx.pstats, sc, 0), r1 = S.modelRealizer(ctxM.model, ctxM.pstats, sc, 0);
  for (let j = 0; j < ctx.pallets.length; j++) assert.ok(r1(j, 'R-07').iv.length <= r0(j, 'R-07').iv.length);
});

test('optimizer: beats EDD in-sample and on fresh scenarios', () => {
  const ctx = P.tonightContext(site, model, { rush: site.rush.trailer });
  const res = P.planContext(ctx, { kappa: 1.25, Sopt: 60, Seval: 300, iters: 200 });
  assert.ok(res.inSample.plan <= res.inSample.edd);
  assert.ok(res.plan.pAllOn > res.edd.pAllOn, `${res.plan.pAllOn} vs ${res.edd.pAllOn}`);
  // every pallet is dispatched exactly once
  assert.equal(new Set(res.order).size, ctx.pallets.length);
});

test('calibration: chosen spread covers ~80% on untouched test shifts; naive model does not', () => {
  const cal = P.calibrate(site, model, split, { S: 80 });
  assert.ok(cal.test.coverage > 0.7 && cal.test.coverage < 0.9, `test coverage ${cal.test.coverage}`);
  assert.ok(cal.naiveTest.coverage < 0.6, `naive ${cal.naiveTest.coverage}`);
  assert.ok(cal.test.n >= 300);
});

test('ground truth: the optimized plan also wins under the hidden site physics', () => {
  const ctx = P.tonightContext(site, model, { rush: site.rush.trailer });
  const res = P.planContext(ctx, { kappa: 1.25, Sopt: 60, Seval: 200, iters: 200 });
  const rng = S.mulberry32(77);
  const run = (order, avoid) => {
    let all = 0; const N = 250;
    for (let s = 0; s < N; s++) {
      const d = TRUTH.shiftSd * S.normal(rng);
      const sim = S.simulate(order, ctx.robots, ctx.nAssoc, truthRealizer(site, ctx.pallets, 70000 + s, d), false, avoid);
      const rd = S.trailerReady(ctx.trailers, ctx.pallets, sim.complete, site.loadSec);
      if (rd.every((x, i) => x <= ctx.trailers[i].depart)) all++;
    }
    return all / N;
  };
  const pE = run(res.eddOrder, null), pP = run(res.order, res.avoid);
  assert.ok(pP > pE, `truth plan ${pP} vs edd ${pE}`);
});

test('data integrity', () => {
  const t = site.tonight;
  assert.equal(t.trailers.length, 14);
  for (let i = 1; i < t.trailers.length; i++) assert.ok(t.trailers[i].depart > t.trailers[i - 1].depart);
  for (const p of t.pallets) { assert.ok(p.trailer >= 0 && p.trailer < 14); assert.ok(p.skus.length >= 25 && p.skus.length <= 50); }
  assert.equal(split.train.length, 30); assert.equal(split.cal.length, 30); assert.equal(split.test.length, 30);
  for (const sh of split.train) for (const p of sh.pallets) assert.equal(p.cycle.length, p.skus.length);
  assert.equal(site.robots.length, 8);
});
