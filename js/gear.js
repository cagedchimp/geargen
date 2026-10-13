/*
 * Involute spur gear and rack geometry.
 * Units: millimetres and radians. Tooth 0 of a gear is centred on the +X axis.
 */
(function (global) {
  'use strict';

  const earcut = global.earcut || (typeof require === 'function' ? require('./vendor/earcut.js') : null);

  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;
  const inv = (a) => Math.tan(a) - a;
  const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
  const hyp = (p) => Math.hypot(p[0], p[1]);
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  const isRack = (g) => g.type === 'rack';
  const clearanceOf = (g) => num(g.clearance, 0.25);
  // Profile shift is supported on external gears only.
  const shiftOf = (g) => (isRack(g) || g.internal ? 0 : num(g.shift, 0));
  // Tip shortening (× module) that restores clearance for shifted pairs; see tipReduction().
  const tipCutOf = (g) => (isRack(g) ? 0 : Math.max(num(g.tipCut, 0), 0));

  /** Inverse of the involute function (Newton's method). */
  function invInverse(v) {
    if (v <= 0) return 0;
    let a = Math.cbrt(3 * v);
    for (let i = 0; i < 30; i++) {
      const t = Math.tan(a);
      const step = (t - a - v) / (t * t);
      a -= step;
      if (Math.abs(step) < 1e-14) break;
    }
    return a;
  }

  /** Basic dimensions for a gear or rack description. */
  function dims(g) {
    const m = g.module;
    const alpha = g.pressureAngle * DEG;
    const c = clearanceOf(g);
    if (isRack(g)) {
      const p = Math.PI * m;
      const len = g.teeth * p;
      const tipY = m;
      const rootY = -(1 + c) * m;
      const backY = rootY - Math.max(num(g.rackHeight, 3 * m), 0.5 * m);
      return { rack: true, m, alpha, p, len, tipY, rootY, backY, outer: Math.hypot(len / 2, -backY) };
    }
    const r = (m * g.teeth) / 2;
    const rb = r * Math.cos(alpha);
    if (g.internal) {
      const rf = r + (1 + c) * m;
      return {
        r, rb, alpha, rf,
        ra: Math.max(r - m + tipCutOf(g) * m, rb * (1 + 1e-9)),
        outer: rf + Math.max(num(g.rimWidth, 0), m),
      };
    }
    const x = shiftOf(g);
    const ra = r + (1 + x - tipCutOf(g)) * m;
    return { r, rb, alpha, ra, rf: Math.max(r - (1 + c - x) * m, m * 0.5), outer: ra };
  }

  /*
   * Half angular width of a tooth as a function of radius.
   * Backlash is the total for a gear pair; each gear takes half of it.
   */
  function externalHalf(g, d) {
    const m = g.module;
    const s = (Math.PI * m) / 2 + 2 * shiftOf(g) * m * Math.tan(d.alpha) - num(g.backlash, 0) / 2;
    const k = s / (2 * d.r) + inv(d.alpha);
    return (R) => (R <= d.rb ? k : k - inv(Math.acos(d.rb / R)));
  }

  // An internal tooth is the space of an external gear with the same pitch circle.
  function internalHalf(g, d) {
    const s = (Math.PI * g.module) / 2 + num(g.backlash, 0) / 2;
    const k = Math.PI / g.teeth - s / (2 * d.r) - inv(d.alpha);
    return (R) => (R <= d.rb ? k : k + inv(Math.acos(d.rb / R)));
  }

  function arc(out, R, a0, a1, n) {
    for (let i = 1; i < n; i++) out.push(polar(R, a0 + ((a1 - a0) * i) / n));
  }

  function circle(R, n) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(polar(R, (i / n) * TAU));
    return pts;
  }

  /*
   * Round the corner between the right-hand flank (tooth centred on +X) and the root circle.
   * `right` runs from tip to root. Returns the new list and the angle where it meets the root.
   */
  function filletAt(right, flank, rootR, internal, rho, m) {
    const sg = internal ? -1 : 1; // direction from root towards tip, in radius
    const A = flank(rootR);
    const B = flank(rootR + sg * 1e-3 * m);
    let dx = B[0] - A[0], dy = B[1] - A[1];
    const L = Math.hypot(dx, dy);
    dx /= L; dy /= L;
    // Normal pointing into the tooth space (increasing angle for the right flank).
    let nx = -dy, ny = dx;
    if (nx * -A[1] + ny * A[0] < 0) { nx = -nx; ny = -ny; }
    const Rc = rootR + sg * rho;
    const X0 = [A[0] + rho * nx, A[1] + rho * ny];
    const b = 2 * (X0[0] * dx + X0[1] * dy);
    const c = X0[0] * X0[0] + X0[1] * X0[1] - Rc * Rc;
    const disc = b * b - 4 * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const lam = [(-b - sq) / 2, (-b + sq) / 2].filter((l) => l >= -1e-9).sort((p, q) => p - q)[0];
    if (lam == null) return null;
    const C = [X0[0] + lam * dx, X0[1] + lam * dy];
    const T2 = [A[0] + lam * dx, A[1] + lam * dy];
    const cr = hyp(C);
    const T1 = [(C[0] * rootR) / cr, (C[1] * rootR) / cr];
    const rT2 = hyp(T2);
    const keep = right.filter((p) => (internal ? hyp(p) < rT2 - 1e-9 : hyp(p) > rT2 + 1e-9));
    if (!keep.length) return null;
    const a0 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
    let da = Math.atan2(T1[1] - C[1], T1[0] - C[0]) - a0;
    while (da > Math.PI) da -= TAU;
    while (da <= -Math.PI) da += TAU;
    const pts = keep.concat([T2]);
    for (let i = 1; i < 6; i++) pts.push([C[0] + rho * Math.cos(a0 + (da * i) / 6), C[1] + rho * Math.sin(a0 + (da * i) / 6)]);
    pts.push(T1);
    return { pts, endAngle: Math.atan2(T1[1], T1[0]) };
  }

  /** Closed polyline of the toothed edge of a gear. */
  function toothOutline(g, flankSteps) {
    const d = dims(g);
    const z = g.teeth;
    const m = g.module;
    const step = TAU / z;
    const N = flankSteps || 12;
    const half = g.internal ? internalHalf(g, d) : externalHalf(g, d);
    const rootR = d.rf;
    let tipR = d.ra;

    // Pointed teeth: cut the tip off where the flanks meet.
    if (half(tipR) <= 0) {
      let a = tipR, b = rootR;
      for (let i = 0; i < 50; i++) {
        const mid = (a + b) / 2;
        if (half(mid) <= 0) a = mid; else b = mid;
      }
      tipR = b;
    }

    // Radii from root to tip along one flank.
    const radii = [];
    if (!g.internal && rootR < d.rb) {
      radii.push(rootR); // radial segment below the base circle
      for (let i = 0; i <= N; i++) radii.push(d.rb + ((tipR - d.rb) * i) / N);
    } else {
      for (let i = 0; i <= N; i++) radii.push(rootR + ((tipR - rootR) * i) / N);
    }

    // Right flank of the tooth centred on +X, from tip to root.
    const flank = (R) => polar(R, half(R));
    let right = radii.slice().reverse().map(flank);
    let endAngle = half(rootR);
    const rho = num(g.fillet, 0.3) * m;
    if (rho > 0) {
      for (let r = rho, i = 0; i < 12; i++, r *= 0.75) {
        const f = filletAt(right, flank, rootR, !!g.internal, r, m);
        if (f && f.endAngle <= step / 2 - 1e-6) { right = f.pts; endAngle = f.endAngle; break; }
      }
    }
    const left = right.slice().reverse().map(([x, y]) => [x, -y]);

    const tipHalf = half(tipR);
    const pts = [];
    for (let k = 0; k < z; k++) {
      const c = k * step, cs = Math.cos(c), sn = Math.sin(c);
      const rot = ([x, y]) => [x * cs - y * sn, x * sn + y * cs];
      for (const p of left) pts.push(rot(p));
      arc(pts, tipR, c - tipHalf, c + tipHalf, 4);
      for (const p of right) pts.push(rot(p));
      if (step - 2 * endAngle > 1e-9) arc(pts, rootR, c + endAngle, c + step - endAngle, 6);
    }
    return { pts: dedupe(pts), d };
  }

  /*
   * Rack in its local frame: X along the rack, reference line at y = 0,
   * teeth pointing towards +Y, centred on x = 0.
   */
  function rackOutline(g) {
    const d = dims(g);
    const { p, len, tipY, rootY, backY, alpha } = d;
    const s = p / 2 - num(g.backlash, 0) / 2;
    const w = (y) => s / 2 - y * Math.tan(alpha);
    const wt = Math.max(w(tipY), 0.01 * d.m);
    const wr = Math.min(w(rootY), p / 2);
    const pts = [[-len / 2, backY], [-len / 2, rootY]];
    for (let k = 0; k < g.teeth; k++) {
      const xk = (k - (g.teeth - 1) / 2) * p;
      pts.push([xk - wr, rootY], [xk - wt, tipY], [xk + wt, tipY], [xk + wr, rootY]);
    }
    pts.push([len / 2, rootY], [len / 2, backY]);
    return { pts: dedupe(pts), d };
  }

  function boreOutline(g) {
    const R = num(g.bore, 0) / 2;
    if (R <= 0) return null;
    const type = g.boreType || 'round';
    if (type === 'keyway') {
      const kw = num(g.keyWidth, 0), kd = num(g.keyDepth, 0);
      if (kw > 0 && kw < 2 * R && kd > 0) {
        const a0 = Math.asin(kw / 2 / R);
        const pts = [];
        for (let i = 0; i <= 72; i++) pts.push(polar(R, a0 + ((TAU - 2 * a0) * i) / 72));
        pts.push([R + kd, -kw / 2], [R + kd, kw / 2]);
        return pts;
      }
    } else if (type === 'dflat') {
      const fd = num(g.flatDepth, 0);
      if (fd > 0 && fd < R) {
        const a1 = Math.acos((R - fd) / R);
        const pts = [];
        for (let i = 0; i <= 72; i++) pts.push(polar(R, a1 + ((TAU - 2 * a1) * i) / 72));
        return pts;
      }
    }
    return circle(R, 72);
  }

  /** Furthest extent of the bore from the centre (for hub sizing checks). */
  function boreExtent(g) {
    const R = num(g.bore, 0) / 2;
    return g.boreType === 'keyway' ? R + Math.max(num(g.keyDepth, 0), 0) : R;
  }

  /** Lightening windows between straight spokes. */
  function spokeWindows(g, d) {
    const n = Math.round(num(g.spokes, 0));
    if (n < 2) return { windows: [] };
    const Rh = num(g.hubDiameter, 0) / 2;
    const Ri = d.rf - num(g.rimThickness, 0);
    const w = num(g.spokeWidth, 0);
    if (Rh <= boreExtent(g) + 0.5) return { windows: [], warning: 'hub Ø must be larger than the bore' };
    if (Ri - Rh < 1) return { windows: [], warning: 'no room between hub and rim — reduce hub Ø or rim thickness' };
    const ao = Math.asin(Math.min(1, w / 2 / Ri));
    const ai = Math.asin(Math.min(1, w / 2 / Rh));
    const span = TAU / n;
    if (span - 2 * ai < 0.05) return { windows: [], warning: 'spokes too wide for the hub' };
    const windows = [];
    for (let j = 0; j < n; j++) {
      const b0 = j * span + span / 2; // windows sit between spokes; one spoke lies along +X
      const b1 = b0 + span;
      const pts = [];
      const no = 32, ni = 16;
      for (let i = 0; i <= no; i++) pts.push(polar(Ri, b0 + ao + ((b1 - ao - (b0 + ao)) * i) / no));
      for (let i = 0; i <= ni; i++) pts.push(polar(Rh, b1 - ai - ((b1 - ai - (b0 + ai)) * i) / ni));
      windows.push(pts);
    }
    return { windows };
  }

  /** All closed paths of a part (fill with even-odd) plus any geometry warnings. */
  function gearPaths(g) {
    if (isRack(g)) {
      const t = rackOutline(g);
      return { paths: [t.pts], dims: t.d, warnings: [] };
    }
    const t = toothOutline(g);
    const paths = [t.pts];
    const warnings = [];
    if (g.internal) {
      paths.push(circle(t.d.outer, 180));
    } else {
      const bore = boreOutline(g);
      if (bore) {
        if (boreExtent(g) < t.d.rf * 0.95) paths.push(bore);
        else warnings.push('bore is larger than the root circle');
      }
      const sp = spokeWindows(g, t.d);
      if (sp.warning) warnings.push('spokes: ' + sp.warning);
      paths.push(...sp.windows);
    }
    return { paths, dims: t.d, warnings };
  }

  function pitchRadius(g) {
    return (g.module * g.teeth) / 2;
  }

  /**
   * Operating centre distance and working pressure angle of a meshing pair.
   * For a rack child, `a` is the distance from the gear centre to the rack reference line.
   */
  function meshGeometry(p, c) {
    const alpha = p.pressureAngle * DEG;
    const m = p.module;
    if (isRack(c)) return { a: pitchRadius(p) + shiftOf(p) * m, alphaW: alpha };
    if (p.internal || c.internal) {
      const [ring, pin] = p.internal ? [p, c] : [c, p];
      const dz = ring.teeth - pin.teeth;
      if (dz <= 0 || shiftOf(pin) === 0) return { a: (m * dz) / 2, alphaW: alpha };
      const alphaW = invInverse((2 * Math.tan(alpha) * -shiftOf(pin)) / dz + inv(alpha));
      return { a: ((m * dz) / 2) * Math.cos(alpha) / Math.cos(alphaW), alphaW };
    }
    const zs = p.teeth + c.teeth;
    if (shiftOf(p) + shiftOf(c) === 0) return { a: (m * zs) / 2, alphaW: alpha };
    const alphaW = invInverse((2 * Math.tan(alpha) * (shiftOf(p) + shiftOf(c))) / zs + inv(alpha));
    return { a: ((m * zs) / 2) * Math.cos(alpha) / Math.cos(alphaW), alphaW };
  }

  function centerDistance(p, c) {
    return meshGeometry(p, c).a;
  }

  /**
   * How much (× module) to shorten both tips of a shifted pair so the root clearance stays
   * at its set value. Shifting moves the teeth outwards by (x1 + x2)·m, but the centre
   * distance only grows by (a' − a), so the tips would otherwise dig into the opposite roots.
   * Returns 0 when no shortening is needed.
   */
  function tipReduction(p, c) {
    if (isRack(p) || isRack(c) || (p.internal && c.internal)) return 0;
    const m = p.module;
    const { a } = meshGeometry(p, c);
    let k;
    if (p.internal || c.internal) {
      const [ring, pin] = p.internal ? [p, c] : [c, p];
      if (ring.teeth <= pin.teeth) return 0;
      k = shiftOf(pin) - shiftOf(ring) - ((m * (ring.teeth - pin.teeth)) / 2 - a) / m;
    } else {
      k = shiftOf(p) + shiftOf(c) - (a - (m * (p.teeth + c.teeth)) / 2) / m;
    }
    return k > 1e-9 ? k : 0;
  }

  const wrap = (a, n) => ((a % n) + n) % n;

  /**
   * Where a meshed child sits relative to its parent's centre, and how it moves.
   * th: position angle of the child around the parent; phiP / omegaP: parent angle and speed.
   * Gears get { dx, dy, phi, omega }; racks get { dx, dy, phi, omega: 0, v } (v = slide speed).
   */
  function childPose(p, c, th, phiP, omegaP) {
    if (isRack(c)) {
      // The rack's reference line is tangent to the gear and slides at the pitch-line speed.
      // A finite rack can't travel forever, so it jumps back by whole pitches to stay in mesh.
      const d = dims(c);
      const a = centerDistance(p, c);
      const rp = pitchRadius(p);
      const nx = Math.cos(th), ny = Math.sin(th);
      const span = Math.max(1, c.teeth - 6) * d.p;
      const o = wrap(rp * (phiP - th) + (c.teeth * d.p) / 2 + span / 2, span) - span / 2;
      return { dx: a * nx - o * ny, dy: a * ny + o * nx, phi: th + Math.PI / 2, omega: 0, v: omegaP * rp };
    }
    const dist = centerDistance(p, c);
    const internalPair = p.internal || c.internal;
    const k = internalPair ? 1 : -1;
    const ratio = p.teeth / c.teeth;
    // Contact direction as seen from each gear's centre.
    let psiP, psiC;
    if (!internalPair) { psiP = th; psiC = th + Math.PI; }
    else if (p.internal) { psiP = psiC = th; }
    else { psiP = psiC = th + Math.PI; }
    // Parent tooth at contact <=> child gap at contact.
    return {
      dx: dist * Math.cos(th),
      dy: dist * Math.sin(th),
      phi: psiC + Math.PI / c.teeth + k * (phiP - psiP) * ratio,
      omega: k * omegaP * ratio,
    };
  }

  /** Transverse contact ratio of a meshing pair (parent, child). */
  function contactRatio(p, c) {
    const alpha = p.pressureAngle * DEG;
    const m = p.module;
    const pb = Math.PI * m * Math.cos(alpha);
    const len = (d) => Math.sqrt(Math.max(d.ra * d.ra - d.rb * d.rb, 0));
    if (isRack(c)) {
      const d = dims(p);
      return (len(d) - d.r * Math.sin(alpha) + (m * (1 - shiftOf(p))) / Math.sin(alpha)) / pb;
    }
    const { a, alphaW } = meshGeometry(p, c);
    const dp = dims(p), dc = dims(c);
    if (p.internal || c.internal) {
      const [ring, pin] = p.internal ? [dp, dc] : [dc, dp];
      return (len(pin) - len(ring) + a * Math.sin(alphaW)) / pb;
    }
    return (len(dp) + len(dc) - a * Math.sin(alphaW)) / pb;
  }

  /** Smallest profile shift that avoids undercut (standard rack cutter). */
  function minShift(g) {
    const s = Math.sin(g.pressureAngle * DEG);
    return 1 - (g.teeth * s * s) / 2;
  }

  // ---------- export helpers ----------

  function dedupe(pts) {
    const out = [];
    for (const p of pts) {
      const q = out[out.length - 1];
      if (!q || Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9) out.push(p);
    }
    const f = out[0], l = out[out.length - 1];
    if (out.length > 1 && Math.abs(f[0] - l[0]) <= 1e-9 && Math.abs(f[1] - l[1]) <= 1e-9) out.pop();
    return out;
  }

  function transformPts(pts, tx, ty, rot, flipY) {
    const c = Math.cos(rot), s = Math.sin(rot);
    return pts.map(([x, y]) => {
      const X = tx + x * c - y * s;
      const Y = ty + x * s + y * c;
      return [X, flipY ? -Y : Y];
    });
  }

  function svgPathData(paths) {
    const f = (n) => +n.toFixed(4);
    return paths
      .map((pts) => 'M' + pts.map(([x, y]) => f(x) + ' ' + f(y)).join(' L') + ' Z')
      .join(' ');
  }

  function dxf(pathsList) {
    const out = [
      '0', 'SECTION', '2', 'HEADER',
      '9', '$ACADVER', '1', 'AC1009',
      '9', '$INSUNITS', '70', '4',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
    ];
    const f = (n) => n.toFixed(5);
    for (const pts of pathsList) {
      out.push('0', 'POLYLINE', '8', '0', '66', '1', '70', '1');
      for (const [x, y] of pts) out.push('0', 'VERTEX', '8', '0', '10', f(x), '20', f(y));
      out.push('0', 'SEQEND', '8', '0');
    }
    out.push('0', 'ENDSEC', '0', 'EOF');
    return out.join('\n') + '\n';
  }

  function signedArea(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    return a / 2;
  }

  /**
   * Binary STL of the paths extruded to `thickness` (mm).
   * The loop with the largest area is the outside; every other loop is a hole.
   */
  function stl(paths, thickness, name) {
    if (!earcut) throw new Error('earcut not loaded');
    const loops = paths.map(dedupe).filter((p) => p.length >= 3);
    const areas = loops.map(signedArea);
    let oi = 0;
    areas.forEach((a, i) => { if (Math.abs(a) > Math.abs(areas[oi])) oi = i; });
    const orient = (p, i, ccw) => ((areas[i] > 0) === ccw ? p : p.slice().reverse());
    const outer = orient(loops[oi], oi, true);
    const holes = loops.map((p, i) => (i === oi ? null : orient(p, i, false))).filter(Boolean);

    const flat = [];
    const holeIdx = [];
    for (const [x, y] of outer) flat.push(x, y);
    for (const h of holes) {
      holeIdx.push(flat.length / 2);
      for (const [x, y] of h) flat.push(x, y);
    }
    const tri = earcut(flat, holeIdx, 2);
    const T = thickness;
    const facets = [];
    const V = (i) => [flat[2 * i], flat[2 * i + 1]];
    for (let i = 0; i < tri.length; i += 3) {
      let a = V(tri[i]), b = V(tri[i + 1]), c = V(tri[i + 2]);
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) [b, c] = [c, b];
      facets.push([[a[0], a[1], T], [b[0], b[1], T], [c[0], c[1], T]]);
      facets.push([[a[0], a[1], 0], [c[0], c[1], 0], [b[0], b[1], 0]]);
    }
    for (const loop of [outer, ...holes]) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        facets.push([[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], T]]);
        facets.push([[a[0], a[1], 0], [b[0], b[1], T], [a[0], a[1], T]]);
      }
    }

    const buf = new ArrayBuffer(84 + facets.length * 50);
    const dv = new DataView(buf);
    const header = ('GearGen ' + (name || '')).slice(0, 80);
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
    dv.setUint32(80, facets.length, true);
    let o = 84;
    for (const [p0, p1, p2] of facets) {
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      for (const v of [nx, ny, nz, ...p0, ...p1, ...p2]) { dv.setFloat32(o, v, true); o += 4; }
      dv.setUint16(o, 0, true);
      o += 2;
    }
    return buf;
  }

  global.GearGeom = {
    dims, gearPaths, pitchRadius, centerDistance, meshGeometry, contactRatio, minShift, tipReduction, childPose,
    isRack, transformPts, svgPathData, dxf, stl,
  };
})(typeof window !== 'undefined' ? window : globalThis);
