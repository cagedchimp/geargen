/*
 * Involute spur gear geometry.
 * Units: millimetres and radians. Tooth 0 is centred on the +X axis.
 */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;
  const inv = (a) => Math.tan(a) - a;
  const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];

  /** Basic radii for a gear description. */
  function dims(g) {
    const m = g.module;
    const alpha = g.pressureAngle * DEG;
    const r = (m * g.teeth) / 2;
    const rb = r * Math.cos(alpha);
    const add = m * (g.addendum != null ? g.addendum : 1);
    const ded = m * (g.dedendum != null ? g.dedendum : 1.25);
    if (g.internal) {
      const rf = r + ded;
      return {
        r, rb, alpha, rf,
        ra: Math.max(r - add, rb),
        outer: rf + Math.max(g.rimWidth || 0, m),
      };
    }
    const ra = r + add;
    return { r, rb, alpha, ra, rf: Math.max(r - ded, m * 0.5), outer: ra };
  }

  /*
   * Half angular width of a tooth as a function of radius.
   * Backlash is the total for a gear pair; each gear takes half of it.
   */
  function externalHalf(g, d) {
    const s = (Math.PI * g.module) / 2 - (g.backlash || 0) / 2;
    const k = s / (2 * d.r) + inv(d.alpha);
    return (R) => (R <= d.rb ? k : k - inv(Math.acos(d.rb / R)));
  }

  // An internal tooth is the space of an external gear with the same pitch circle.
  function internalHalf(g, d) {
    const s = (Math.PI * g.module) / 2 + (g.backlash || 0) / 2;
    const k = Math.PI / g.teeth - s / (2 * d.r) - inv(d.alpha);
    return (R) => (R <= d.rb ? k : k + inv(Math.acos(d.rb / R)));
  }

  function arc(out, R, a0, a1, n) {
    for (let i = 1; i < n; i++) out.push(polar(R, a0 + ((a1 - a0) * i) / n));
  }

  function circle(R, n) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(polar(R, (i / n) * Math.PI * 2));
    return pts;
  }

  /** Closed polyline of the toothed edge. */
  function toothOutline(g, flankSteps) {
    const d = dims(g);
    const z = g.teeth;
    const step = (Math.PI * 2) / z;
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

    const rootHalf = half(rootR);
    const tipHalf = half(tipR);
    const pts = [];
    for (let k = 0; k < z; k++) {
      const c = k * step;
      for (const R of radii) pts.push(polar(R, c - half(R)));
      arc(pts, tipR, c - tipHalf, c + tipHalf, 4);
      for (let i = radii.length - 1; i >= 0; i--) pts.push(polar(radii[i], c + half(radii[i])));
      if (step - 2 * rootHalf > 1e-9) arc(pts, rootR, c + rootHalf, c + step - rootHalf, 6);
    }
    return { pts, d };
  }

  /** All closed paths of a gear (fill with even-odd). */
  function gearPaths(g) {
    const t = toothOutline(g);
    const paths = [t.pts];
    if (g.internal) {
      paths.push(circle(t.d.outer, 180));
    } else if (g.bore > 0 && g.bore / 2 < t.d.rf * 0.95) {
      paths.push(circle(g.bore / 2, 72));
    }
    return { paths, dims: t.d };
  }

  function pitchRadius(g) {
    return (g.module * g.teeth) / 2;
  }

  /** Centre distance of a meshing pair (child placed relative to parent). */
  function centerDistance(p, c) {
    const rp = pitchRadius(p), rc = pitchRadius(c);
    if (p.internal) return rp - rc;
    if (c.internal) return rc - rp;
    return rp + rc;
  }

  /** Transverse contact ratio of a meshing pair. */
  function contactRatio(a, b) {
    const da = dims(a), db = dims(b);
    const alpha = a.pressureAngle * DEG;
    const pb = Math.PI * a.module * Math.cos(alpha);
    const cd = Math.abs(centerDistance(a, b));
    const len = (d) => Math.sqrt(Math.max(d.ra * d.ra - d.rb * d.rb, 0));
    if (a.internal || b.internal) {
      const [ring, pin] = a.internal ? [da, db] : [db, da];
      return (len(pin) - len(ring) + cd * Math.sin(alpha)) / pb;
    }
    return (len(da) + len(db) - cd * Math.sin(alpha)) / pb;
  }

  // ---------- export helpers ----------

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

  global.GearGeom = {
    dims, gearPaths, pitchRadius, centerDistance, contactRatio,
    transformPts, svgPathData, dxf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
