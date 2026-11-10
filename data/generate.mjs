// Seeded synthetic data for the Shift Plan demo. Run: node data/generate.mjs
// Writes data/site.json (catalog, fleet, tonight's orders) and data/history.json
// (90 past shifts: 30 with pick-level logs for fitting, 30 for calibration, 30 for testing).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32, simulate, trailerReady, policyEDD } from '../core/shiftplan.js';
import { TRUTH, truthRealizer } from './truth.mjs';
import { normal } from '../core/shiftplan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rng = mulberry32(20261110);
const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
const ru = (a, b) => a + rng() * (b - a);

// ---- catalog: generic CPG case SKUs (no real brands) ----
const CATS = [
  // name, pack class (0 corrugated, 1 shrink tray, 2 poly bag/bundle, 3 coated/glossy), kg range, case dims cm, popularity, beverage
  ['Sparkling water 12x12oz', 1, [8.4, 9.4], [40, 27, 13], 8, 1],
  ['Cola 24x12oz cans', 1, [9.6, 10.4], [40, 27, 25], 10, 1],
  ['Sports drink 24x20oz', 1, [14.2, 15.8], [40, 27, 22], 6, 1],
  ['Spring water 24x16.9oz', 1, [11.8, 12.8], [40, 27, 21], 9, 1],
  ['Iced tea 12x18.5oz', 1, [7.4, 8.2], [33, 25, 21], 4, 1],
  ['Canned soup 24x10.5oz', 1, [7.2, 7.8], [34, 23, 12], 5, 0],
  ['Breakfast cereal 12ct', 0, [4.2, 6.0], [48, 32, 30], 6, 0],
  ['Snack crackers 12ct', 0, [3.0, 4.0], [42, 30, 24], 5, 0],
  ['Chips variety 30ct', 0, [1.8, 2.6], [46, 34, 33], 5, 0],
  ['Laundry detergent 4x150oz', 0, [17.2, 18.8], [41, 30, 31], 4, 0],
  ['Dish soap 9x28oz', 0, [7.6, 8.4], [33, 25, 26], 3, 0],
  ['Paper towels 6x6 rolls', 2, [3.2, 4.0], [56, 38, 46], 5, 0],
  ['Bath tissue 4x12 rolls', 2, [3.8, 4.4], [50, 40, 42], 5, 0],
  ['Dry dog food 30 lb bag', 2, [13.4, 13.8], [70, 45, 14], 3, 0],
  ['Ground coffee 6x30oz', 3, [4.8, 5.4], [36, 24, 18], 4, 0],
  ['Olive oil 12x1L', 3, [11.0, 11.8], [32, 24, 31], 2, 0],
  ['Diapers 4ct case', 0, [6.6, 7.6], [52, 40, 38], 3, 0],
  ['Pasta 20x1lb', 0, [9.0, 9.4], [38, 28, 22], 4, 0],
];
const skus = [];
CATS.forEach(([name, pk, wr, dims, pop, bev], ci) => {
  const nVar = ri(7, 11);
  for (let v = 0; v < nVar; v++) {
    const w = +ru(wr[0], wr[1]).toFixed(2);
    const d = dims.map((x) => x * ru(0.95, 1.05));
    skus.push({
      id: skus.length,
      code: `${String(100000 + ci * 1000 + v * 37).slice(0, 6)}`,
      name: `${name}${nVar > 1 ? ` · var ${String.fromCharCode(65 + v)}` : ''}`,
      cat: ci, pk, w,
      vol: +(d[0] * d[1] * d[2] / 1e6).toFixed(4),
      dims: d.map((x) => Math.round(x)),
      dist: +ru(8, 58).toFixed(1), // m from pick face to build stations
      pop: pop * ru(0.5, 1.5), bev,
    });
  }
});
const robots = Object.keys(TRUTH.robotMult).map((id, i) => ({ id, gen: 3, station: `B-${String(i + 1).padStart(2, '0')}` }));

const STORE_NAMES = ['Riverside', 'Oak Park', 'Mill Creek', 'Harbor View', 'Westgate', 'Fairview', 'Lakeshore', 'Cedar Hill', 'North Plaza', 'Briarwood', 'Elm Grove', 'Summit', 'Brookfield', 'Kingsley', 'Maple Ridge', 'Pinecrest', 'Ashford', 'Willow Bend', 'Stonebridge', 'Granite Falls', 'Redwood', 'Bayside', 'Meadowlark', 'Highland', 'Silver Lake', 'Clearwater', 'Hawthorne', 'Juniper', 'Copper Hills', 'Sunnyvale Rd', 'Foxhollow', 'Linden', 'Marigold', 'Prairie View', 'Rosewood', 'Timber Ridge', 'Wildwood', 'Crescent', 'Orchard', 'Valley Fair', 'Bridgeport', 'Glenwood', 'Ironwood', 'Lakeview', 'Pebble Creek', 'Shady Oaks'];
const stores = STORE_NAMES.map((n, i) => ({ id: 2100 + i * 7, name: n }));

function pickSku(bevBoost) {
  let tot = 0;
  for (const s of skus) tot += s.pop * (s.bev ? bevBoost : 1);
  let u = rng() * tot;
  for (const s of skus) { u -= s.pop * (s.bev ? bevBoost : 1); if (u <= 0) return s.id; }
  return skus.length - 1;
}
function makePallet(bevBoost) {
  const n = ri(36, 50);
  const ids = [];
  let vol = 0;
  while (ids.length < n) {
    const id = pickSku(bevBoost);
    if (vol + skus[id].vol > 1.75 * 1.2 * 1.0 * 0.85) break;
    ids.push(id); vol += skus[id].vol;
  }
  return ids;
}
const DEPARTS = ['17:15', '17:45', '18:30', '19:00', '19:30', '20:15', '20:45', '21:15', '21:45', '22:15', '22:45', '23:00', '23:15', '23:30'];
const toSec = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return (h - 15) * 3600 + m * 60; };
const CARRIERS = ['Fleet 14', 'Fleet 22', 'Fleet 31', 'Fleet 09'];
function makeShift(opts) {
  const { nTrailers = 14, bevBoost = 1, palletScale = 1 } = opts;
  const trailers = [], pallets = [];
  const deps = DEPARTS.slice(0, nTrailers);
  let release = 0;
  const storePool = stores.slice().sort(() => rng() - 0.5);
  deps.forEach((d, ti) => {
    const nStores = ri(2, 4);
    const st = storePool.splice(0, nStores);
    trailers.push({ id: `T-${String(ti + 1).padStart(2, '0')}`, depart: toSec(d), departLabel: d, door: `D${ri(11, 34)}`, carrier: CARRIERS[ti % 4], stores: st.map((s) => s.id) });
    for (const s of st) {
      const np = Math.max(1, Math.round(ri(2, 3) * palletScale));
      for (let k = 0; k < np; k++) pallets.push({ trailer: ti, store: s.id, release: 0, skus: makePallet(bevBoost) });
    }
  });
  // WMS releases store orders in store-number order, not departure order.
  const ord = pallets.map((_, j) => j).sort((a, b) => pallets[a].store - pallets[b].store || a - b);
  ord.forEach((j, k) => { pallets[j].release = k; release++; });
  return { trailers, pallets };
}

const site = { skus, robots, stores, loadSec: 900, shiftStart: '15:00', shiftEnd: '23:30', siteName: 'DC-04', customer: 'Fortune 250 CPG (synthetic)' };

// ---- history: 60 past shifts, EDD dispatch, real physics from truth.mjs ----
const history = { policy: 'edd', shifts: [] };
for (let k = 0; k < 90; k++) {
  const sh = makeShift({ nTrailers: ri(12, 14), bevBoost: ru(0.8, 1.6), palletScale: ru(0.75, 1.02) });
  const nAssoc = k % 9 === 4 ? 1 : k % 11 === 7 ? 3 : 2;
  const delta = TRUTH.shiftSd * normal(rng);
  const seed = 5000 + k;
  const realize = truthRealizer(site, sh.pallets, seed, delta);
  const rec = {};
  const wrapped = (j, r) => { const R = realize(j, r); rec[j] = R; return R; };
  const order = policyEDD(sh.pallets, sh.trailers);
  const sim = simulate(order, robots, nAssoc, wrapped, true);
  const ready = trailerReady(sh.trailers, sh.pallets, sim.complete, site.loadSec);
  const split = k < 30 ? 'train' : k < 60 ? 'cal' : 'test';
  const date = new Date(Date.UTC(2026, 8, 1) + k * 86400000).toISOString().slice(0, 10);
  const out = {
    id: `S-${date}`, date, split, nAssoc,
    trailers: sh.trailers.map((t, i) => ({ id: t.id, depart: t.depart, ready: Math.round(ready[i]) })),
    pallets: sh.pallets.map((p, j) => {
      const o = { trailer: p.trailer, release: p.release, skus: p.skus };
      if (split === 'train') {
        o.robot = robots[sim.robotOf[j]].id;
        o.cycle = rec[j].cycle.map((x) => Math.round(x * 10) / 10);
        o.iv = rec[j].ivIdx;
        o.change = Math.round(rec[j].change);
      }
      return o;
    }),
  };
  if (split === 'train') out.ivLog = sim.ivLog.map((e) => ({ walk: Math.round(e.walk), fix: Math.round(e.fix) }));
  history.shifts.push(out);
}

// ---- tonight: pre-holiday beverage-heavy night, the planner's input ----
const tonight = makeShift({ nTrailers: 14, bevBoost: 1.7, palletScale: 1.0 });
tonight.nAssoc = 2;
tonight.date = '2026-11-10';
// A store calls in a rush add-on: 3 pallets riding T-10 (22:15).
const rushStore = stores.find((s) => !tonight.trailers.some((t) => t.stores.includes(s.id)));
const rush = { store: rushStore.id, storeName: rushStore.name, trailer: 9, pallets: [makePallet(1.9), makePallet(1.9), makePallet(1.9)] };
site.tonight = tonight;
site.rush = rush;

fs.writeFileSync(path.join(here, 'site.json'), JSON.stringify(site));
fs.writeFileSync(path.join(here, 'history.json'), JSON.stringify(history));
const nCases = tonight.pallets.reduce((a, p) => a + p.skus.length, 0);
console.log(`skus ${skus.length}, tonight pallets ${tonight.pallets.length}, cases ${nCases}, history shifts ${history.shifts.length}`);
const late = history.shifts.map((s) => s.trailers.filter((t) => t.ready > t.depart).length);
console.log('history late trailers per shift', late.join(','));
console.log('sizes', fs.statSync(path.join(here, 'site.json')).size, fs.statSync(path.join(here, 'history.json')).size);
