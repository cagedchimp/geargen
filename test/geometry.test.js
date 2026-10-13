/*
 * Geometry checks for GearGen. Run with `npm test` (or `node --test`).
 * No dependencies beyond Node 18+.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/gear.js');

const G = globalThis.GearGeom;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const BASE = { module: 2, pressureAngle: 20, backlash: 0.1, clearance: 0.25, fillet: 0.3, bore: 5, rimWidth: 8 };
const gear = (props) => Object.assign({ type: 'gear' }, BASE, props);
const rack = (props) => Object.assign({ type: 'rack', rackHeight: 6 }, BASE, props);

/** Apply the same tip shortening the app does for a single pair. */
function withTipCut(p, c) {
  const k = G.tipReduction(p, c);
  return [Object.assign({}, p, { tipCut: k }), Object.assign({}, c, { tipCut: k })];
}

// ---------------------------------------------------------------- helpers

function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inMaterial(pt, paths) {
  return paths.filter((p) => pointInPolygon(pt, p)).length % 2 === 1;
}

function segDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Turn the parent through a few teeth and return the worst overlap (points of one part
 * inside the other) and the smallest gap between the two toothed outlines.
 */
function sweep(p, c, th, steps = 48) {
  const P = G.gearPaths(p).paths;
  const C = G.gearPaths(c).paths;
  const reach = G.dims(c).outer + 2;
  let overlap = 0;
  let gap = Infinity;
  for (let s = 0; s < steps; s++) {
    const phiP = ((s / steps) * TAU * 3) / p.teeth;
    const pose = G.childPose(p, c, th, phiP, 1);
    const pP = P.map((q) => G.transformPts(q, 0, 0, phiP));
    const pC = C.map((q) => G.transformPts(q, pose.dx, pose.dy, pose.phi));
    // Only look at the mesh zone: points near both parts.
    const near = (pt, cx, cy, r) => Math.hypot(pt[0] - cx, pt[1] - cy) < r;
    const rp = G.dims(p).outer + 2;
    const pz = pP[0].filter((pt) => near(pt, pose.dx, pose.dy, reach));
    const cz = pC[0].filter((pt) => near(pt, 0, 0, rp));
    let bad = 0;
    for (const pt of cz) if (inMaterial(pt, pP)) bad++;
    for (const pt of pz) if (inMaterial(pt, pC)) bad++;
    overlap = Math.max(overlap, bad);
    const cOut = pC[0];
    for (const pt of pz) {
      for (let i = 0; i < cOut.length; i++) {
        const a = cOut[i], b = cOut[(i + 1) % cOut.length];
        if (!near(a, pt[0], pt[1], 3 * p.module)) continue;
        gap = Math.min(gap, segDist(pt, a, b));
      }
    }
  }
  return { overlap, gap };
}

// Half the backlash on each flank, measured along the line of action.
const flankGap = (g) => (g.backlash / 2) * Math.cos(g.pressureAngle * DEG);

// ---------------------------------------------------------------- meshing

const PAIRS = [
  ['external 30 / 15', gear({ teeth: 30 }), gear({ teeth: 15 }), 0.7],
  ['external, shifted pinion 12 (x 0.4) / 30', gear({ teeth: 12, shift: 0.4 }), gear({ teeth: 30 }), 2.1],
  ['external, both shifted 10 (x 0.5) / 11 (x 0.4)', gear({ teeth: 10, shift: 0.5 }), gear({ teeth: 11, shift: 0.4 }), 1],
  ['external, negative shift 40 (x -0.3) / 18 (x 0.3)', gear({ teeth: 40, shift: -0.3 }), gear({ teeth: 18, shift: 0.3 }), 0.4],
  ['external 25° PA 18 / 40', gear({ teeth: 18, pressureAngle: 25 }), gear({ teeth: 40, pressureAngle: 25 }), 0.3],
  ['external 14.5° PA 32 / 24', gear({ teeth: 32, pressureAngle: 14.5 }), gear({ teeth: 24, pressureAngle: 14.5 }), 2.5],
  ['large fillets 16 / 23', gear({ teeth: 16, fillet: 0.45 }), gear({ teeth: 23, fillet: 0.45 }), 0.2],
  ['ring 60 / pinion 20', gear({ teeth: 60, internal: true }), gear({ teeth: 20 }), 1.2],
  ['ring 48 / shifted pinion 14 (x 0.3)', gear({ teeth: 48, internal: true }), gear({ teeth: 14, shift: 0.3 }), 1.2],
  ['pinion 20 / ring 60 (ring as child)', gear({ teeth: 20 }), gear({ teeth: 60, internal: true }), -0.4],
  ['gear 20 / rack 14', gear({ teeth: 20 }), rack({ teeth: 14 }), 1.1],
  ['shifted gear 12 (x 0.4) / rack 10', gear({ teeth: 12, shift: 0.4 }), rack({ teeth: 10 }), Math.PI / 2],
];

for (const [name, p0, c0, th] of PAIRS) {
  test(`meshes without interference and with the expected play: ${name}`, () => {
    const [p, c] = withTipCut(p0, c0);
    const { overlap, gap } = sweep(p, c, th);
    assert.equal(overlap, 0, 'teeth interpenetrate');
    const want = flankGap(p);
    assert.ok(Math.abs(gap - want) < 0.02, `flank gap ${gap.toFixed(4)} mm, expected about ${want.toFixed(4)} mm`);
  });
}

test('a half-tooth phase error is detected (the sweep is sensitive)', () => {
  const p = gear({ teeth: 30 }), c = gear({ teeth: 15 });
  const real = G.childPose;
  G.childPose = (...args) => { const r = real(...args); return Object.assign({}, r, { phi: r.phi + Math.PI / c.teeth }); };
  try {
    assert.ok(sweep(p, c, 0.7, 12).overlap > 0);
  } finally {
    G.childPose = real;
  }
});

// ---------------------------------------------------------------- centre distance, clearance, ratios

test('unshifted pairs sit at the standard centre distance', () => {
  assert.equal(G.centerDistance(gear({ teeth: 30 }), gear({ teeth: 15 })), 45);
  assert.equal(G.centerDistance(gear({ teeth: 60, internal: true }), gear({ teeth: 20 })), 40);
  assert.equal(G.centerDistance(gear({ teeth: 20 }), rack({ teeth: 10 })), 20);
});

test('shifted pairs satisfy the working pressure angle equation', () => {
  const inv = (a) => Math.tan(a) - a;
  const p = gear({ teeth: 12, shift: 0.4 }), c = gear({ teeth: 30, shift: 0.1 });
  const { a, alphaW } = G.meshGeometry(p, c);
  const alpha = 20 * DEG;
  assert.ok(Math.abs(inv(alphaW) - (2 * Math.tan(alpha) * 0.5) / 42 - inv(alpha)) < 1e-12);
  assert.ok(Math.abs(a - (2 * 42 / 2) * Math.cos(alpha) / Math.cos(alphaW)) < 1e-9);
  assert.ok(a > 42 && a < 42 + 0.5 * 2, 'centre distance grows, but by less than (x1 + x2)·m');
});

test('tip shortening keeps the root clearance for shifted external pairs', () => {
  for (const [z1, x1, z2, x2] of [[10, 0.5, 11, 0.4], [12, 0.4, 30, 0], [15, 0.8, 15, 0.8]]) {
    const [p, c] = withTipCut(gear({ teeth: z1, shift: x1 }), gear({ teeth: z2, shift: x2 }));
    assert.ok(G.tipReduction(p, c) > 0, 'positive shifts need some shortening');
    const a = G.centerDistance(p, c);
    const dp = G.dims(p), dc = G.dims(c);
    const want = 0.25 * 2;
    assert.ok(a - dp.ra - dc.rf >= want - 1e-9, `clearance under ${z1}T tips`);
    assert.ok(a - dc.ra - dp.rf >= want - 1e-9, `clearance under ${z2}T tips`);
  }
});

test('tip shortening keeps the root clearance for a shifted pinion in a ring', () => {
  const [ring, pin] = withTipCut(gear({ teeth: 48, internal: true }), gear({ teeth: 14, shift: 0.5 }));
  const a = G.centerDistance(ring, pin);
  const dr = G.dims(ring), dp = G.dims(pin);
  assert.ok(dr.rf - (a + dp.ra) >= 0.5 - 1e-9, 'clearance under the pinion tips');
  assert.ok(dr.ra - (a + dp.rf) >= 0.5 - 1e-9, 'clearance under the ring tips');
});

test('no tip shortening is applied when it is not needed', () => {
  assert.equal(G.tipReduction(gear({ teeth: 30 }), gear({ teeth: 15 })), 0);
  assert.equal(G.tipReduction(gear({ teeth: 30, shift: 0.3 }), gear({ teeth: 15, shift: -0.3 })), 0);
  assert.equal(G.tipReduction(gear({ teeth: 12, shift: 0.4 }), rack({ teeth: 10 })), 0);
});

test('speeds follow the tooth ratio and direction rules', () => {
  assert.equal(G.childPose(gear({ teeth: 30 }), gear({ teeth: 15 }), 0, 0, 1).omega, -2);
  assert.equal(G.childPose(gear({ teeth: 60, internal: true }), gear({ teeth: 20 }), 0, 0, 1).omega, 3);
  assert.equal(G.childPose(gear({ teeth: 20 }), rack({ teeth: 10 }), 0, 0, 1).v, 20);
});

test('contact ratios are in the expected range', () => {
  const cr = G.contactRatio(gear({ teeth: 30 }), gear({ teeth: 15 }));
  assert.ok(cr > 1.5 && cr < 1.7, `30/15 contact ratio ${cr}`);
  for (const [, p, c] of PAIRS) assert.ok(G.contactRatio(p, c) > 1.1, 'every test pair keeps more than one tooth in contact');
});

test('minimum shift to avoid undercut', () => {
  assert.ok(Math.abs(G.minShift(gear({ teeth: 15 })) - (1 - (15 * Math.sin(20 * DEG) ** 2) / 2)) < 1e-12);
  assert.ok(G.minShift(gear({ teeth: 18 })) < 0, '18 teeth at 20° needs no shift');
});

// ---------------------------------------------------------------- bodies and export

function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

const SPOKED = gear({
  teeth: 40, bore: 8, boreType: 'keyway', keyWidth: 2, keyDepth: 1.2,
  spokes: 5, hubDiameter: 20, rimThickness: 5, spokeWidth: 5,
});

test('spoked gear with keyway produces outline, bore and one window per spoke', () => {
  const { paths, warnings } = G.gearPaths(SPOKED);
  assert.deepEqual(warnings, []);
  assert.equal(paths.length, 1 + 1 + 5);
});

test('impossible spoke layouts warn instead of producing geometry', () => {
  const { paths, warnings } = G.gearPaths(Object.assign({}, SPOKED, { hubDiameter: 6 }));
  assert.equal(paths.length, 2);
  assert.match(warnings[0], /hub/);
});

function readStl(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  assert.equal(buf.byteLength, 84 + n * 50);
  const tris = [];
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12;
    const v = [];
    for (let j = 0; j < 3; j++) { v.push([dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]); o += 12; }
    o += 2;
    tris.push(v);
  }
  return tris;
}

for (const [name, part] of [['spoked gear with keyway', SPOKED], ['ring gear', gear({ teeth: 48, internal: true })], ['rack', rack({ teeth: 12 })],
  ['D-flat bore', gear({ teeth: 24, bore: 6, boreType: 'dflat', flatDepth: 0.8 })]]) {
  test(`STL is watertight, consistently oriented and has the right volume: ${name}`, () => {
    const { paths } = G.gearPaths(part);
    const T = 8;
    const tris = readStl(G.stl(paths, T, name));
    const key = (p) => p.map((x) => x.toFixed(4)).join(',');
    const edges = new Map();
    let volume = 0;
    for (const [a, b, c] of tris) {
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const e = key(u) + '>' + key(v);
        edges.set(e, (edges.get(e) || 0) + 1);
      }
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    for (const [e, count] of edges) {
      const [u, v] = e.split('>');
      assert.equal(count, 1, 'edge used twice in the same direction');
      assert.equal(edges.get(v + '>' + u), 1, 'edge without a matching opposite edge');
    }
    const areas = paths.map(signedArea).map(Math.abs);
    const outer = Math.max(...areas);
    const area = 2 * outer - areas.reduce((s, a) => s + a, 0);
    assert.ok(Math.abs(volume - area * T) / (area * T) < 1e-3, `volume ${volume} vs ${area * T}`);
  });
}

test('DXF output is a closed polyline per path', () => {
  const { paths } = G.gearPaths(SPOKED);
  const dxf = G.dxf(paths);
  assert.equal((dxf.match(/\nPOLYLINE\n/g) || []).length, paths.length);
  assert.ok(dxf.trimEnd().endsWith('EOF'));
});
