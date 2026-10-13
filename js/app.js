(function () {
  'use strict';

  const Geom = window.GearGeom;
  const STORAGE_KEY = 'geargen.state.v1';
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const PALETTE = ['#e8a33d', '#4c9be8', '#5cc08a', '#d9634c', '#a77fe0', '#e0c341', '#45bfc4', '#e67fb0'];

  // Every gear/rack carries all of these; older saved files are filled in on load.
  const DEFAULTS = {
    type: 'gear', // 'gear' | 'rack'
    teeth: 20,
    module: 2,
    pressureAngle: 20,
    backlash: 0.1,
    clearance: 0.25, // × module
    fillet: 0.3, // root fillet radius, × module
    shift: 0, // profile shift coefficient (external gears)
    bore: 5,
    boreType: 'round', // 'round' | 'keyway' | 'dflat'
    keyWidth: 2,
    keyDepth: 1,
    flatDepth: 0.5,
    spokes: 0,
    hubDiameter: 14,
    rimThickness: 4,
    spokeWidth: 4,
    internal: false,
    rimWidth: 8,
    rackHeight: 6, // backing below the tooth roots
    thickness: 8, // face width, used for STL
    locked: false, // position lock: can't be dragged or deleted
    tipCut: 0, // derived: tip shortening for shifted pairs (× module), recomputed on every change
    parent: null,
    relation: null, // 'mesh' | 'axle'
    angle: 0, // position angle around parent (mesh)
    x: 0,
    y: 0,
    rpm: 10, // driver gears only
    phase: 0, // driver / same-axle gears only
  };
  const GEOM_KEYS = ['type', 'teeth', 'module', 'pressureAngle', 'backlash', 'clearance', 'fillet', 'shift', 'bore',
    'boreType', 'keyWidth', 'keyDepth', 'flatDepth', 'spokes', 'hubDiameter', 'rimThickness', 'spokeWidth',
    'internal', 'rimWidth', 'rackHeight', 'tipCut'];

  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');

  let state = null; // { gears, nextId, selected }
  const view = { x: 0, y: 0, scale: 3 };
  const opts = { pitch: true, labels: true };
  let running = true;
  let speed = 1;
  let simTime = 0;
  let lastFrame = performance.now();
  let cssW = 0, cssH = 0;
  let insetR = 0; // canvas width covered by the floating panel
  let solved = new Map();
  const pathCache = new Map();
  const measure = { on: false, a: null, b: null, dragging: false };

  const isRack = (g) => g.type === 'rack';
  const isExternal = (g) => !isRack(g) && !g.internal;

  // ---------------------------------------------------------------- state

  function makeGear(props) {
    const id = state.nextId++;
    const g = Object.assign({}, DEFAULTS, { id, color: PALETTE[(id - 1) % PALETTE.length] }, props);
    if (!g.name) g.name = (isRack(g) ? 'Rack ' : 'Gear ') + id;
    return g;
  }

  function defaultState() {
    state = { gears: [], nextId: 1, selected: null };
    const a = makeGear({ teeth: 30, bore: 8 });
    state.gears.push(a);
    state.gears.push(makeGear({ teeth: 15, parent: a.id, relation: 'mesh', angle: 0 }));
    state.selected = a.id;
  }

  const byId = (id) => state.gears.find((g) => g.id === id);
  const selected = () => (state.selected == null ? null : byId(state.selected));
  const childrenOf = (id) => state.gears.filter((g) => g.parent === id);

  function meshNeighbors(g) {
    const n = childrenOf(g.id).filter((c) => c.relation === 'mesh');
    if (g.relation === 'mesh') n.push(byId(g.parent));
    return n;
  }

  function meshComponent(g) {
    const seen = new Set([g.id]);
    const out = [g];
    for (let i = 0; i < out.length; i++) {
      for (const n of meshNeighbors(out[i])) {
        if (!seen.has(n.id)) { seen.add(n.id); out.push(n); }
      }
    }
    return out;
  }

  /** The part plus everything attached to it (moves and is deleted with it). */
  function subtree(g) {
    const out = [g];
    for (let i = 0; i < out.length; i++) out.push(...childrenOf(out[i].id));
    return out;
  }

  /** Why moving/deleting this part (and what hangs off it) is blocked, or null. */
  function lockReason(g, verb) {
    if (g.locked) return `${g.name} is locked — untick “Lock position” to ${verb} it.`;
    const l = subtree(g).find((x) => x.locked);
    return l ? `Can't ${verb} ${g.name}: ${l.name}, which is attached to it, is locked.` : null;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function loadState(obj) {
    if (!obj || !Array.isArray(obj.gears)) throw new Error('Not a GearGen file');
    const ids = new Set(obj.gears.map((g) => g.id));
    state = {
      gears: obj.gears.map((g) => Object.assign({}, DEFAULTS, g)),
      nextId: Math.max(obj.nextId || 1, ...obj.gears.map((g) => g.id + 1), 1),
      selected: ids.has(obj.selected) ? obj.selected : (obj.gears[0] ? obj.gears[0].id : null),
    };
    state.gears.forEach((g) => { if (g.parent != null && !ids.has(g.parent)) { g.parent = null; g.relation = null; } });
  }

  // ---------------------------------------------------------------- undo / redo

  const history = { stack: [], index: -1, lastKey: null, lastTime: 0 };
  const snapshot = () => JSON.stringify({ gears: state.gears, nextId: state.nextId });

  /** Record the current state. Consecutive edits of the same field within a second merge into one step. */
  function record(coalesceKey) {
    const snap = snapshot();
    if (history.stack[history.index] === snap) return;
    const now = Date.now();
    if (coalesceKey && coalesceKey === history.lastKey && now - history.lastTime < 1000 && history.index > 0) {
      history.stack[history.index] = snap;
    } else {
      history.stack.length = history.index + 1;
      history.stack.push(snap);
      if (history.stack.length > 200) history.stack.shift();
      history.index = history.stack.length - 1;
    }
    history.lastKey = coalesceKey || null;
    history.lastTime = now;
    updateUndoButtons();
  }

  function restore(snap) {
    const obj = JSON.parse(snap);
    const sel = state.selected;
    state.gears = obj.gears;
    state.nextId = obj.nextId;
    state.selected = byId(sel) ? sel : (state.gears[0] ? state.gears[0].id : null);
    history.lastKey = null;
    changed({ noRecord: true });
    updateUndoButtons();
  }

  function undo() {
    if (history.index <= 0) return;
    history.index--;
    restore(history.stack[history.index]);
  }

  function redo() {
    if (history.index >= history.stack.length - 1) return;
    history.index++;
    restore(history.stack[history.index]);
  }

  function updateUndoButtons() {
    $('btn-undo').disabled = history.index <= 0;
    $('btn-redo').disabled = history.index >= history.stack.length - 1;
  }

  // ---------------------------------------------------------------- kinematics

  function solve(t) {
    const out = new Map();
    const map = new Map(state.gears.map((g) => [g.id, g]));
    const visiting = new Set();
    function get(g) {
      if (out.has(g.id)) return out.get(g.id);
      let res;
      const p = g.parent != null ? map.get(g.parent) : null;
      if (!p || visiting.has(g.id)) {
        const w = isRack(g) ? 0 : (g.rpm * TAU) / 60;
        res = { x: g.x, y: g.y, omega: w, phi: g.phase * DEG + w * t, plane: 0, driver: g.id };
      } else {
        visiting.add(g.id);
        const ps = get(p);
        visiting.delete(g.id);
        if (g.relation === 'axle') {
          res = { x: ps.x, y: ps.y, omega: ps.omega, phi: ps.phi + g.phase * DEG, plane: ps.plane + 1, driver: ps.driver };
        } else {
          const pose = Geom.childPose(p, g, g.angle, ps.phi, ps.omega);
          res = {
            x: ps.x + pose.dx,
            y: ps.y + pose.dy,
            omega: pose.omega,
            v: pose.v,
            phi: pose.phi,
            plane: ps.plane,
            driver: ps.driver,
          };
        }
      }
      out.set(g.id, res);
      return res;
    }
    state.gears.forEach(get);
    return out;
  }

  /** Pairs of gears on the same plane that overlap but are not meshed with each other. */
  function findCollisions(sol) {
    const hits = new Set();
    const gs = state.gears;
    const meshed = (a, b) => (a.parent === b.id && a.relation === 'mesh') || (b.parent === a.id && b.relation === 'mesh');
    for (let i = 0; i < gs.length; i++) {
      for (let j = i + 1; j < gs.length; j++) {
        const a = gs[i], b = gs[j];
        const sa = sol.get(a.id), sb = sol.get(b.id);
        if (sa.plane !== sb.plane || meshed(a, b)) continue;
        if (overlaps(a, sa, b, sb)) { hits.add(a.id); hits.add(b.id); }
      }
    }
    return hits;
  }

  // Racks are not collision-checked (their footprint isn't round).
  function overlaps(a, sa, b, sb) {
    if (isRack(a) || isRack(b)) return false;
    const da = Geom.dims(a), db = Geom.dims(b);
    const dist = Math.hypot(sa.x - sb.x, sa.y - sb.y);
    const eps = 1e-6;
    if (!a.internal && !b.internal) return dist < da.ra + db.ra - eps;
    if (a.internal && b.internal) return dist < da.outer + db.outer - eps && !(dist + db.outer < da.ra || dist + da.outer < db.ra);
    const [rd, ed] = a.internal ? [da, db] : [db, da];
    return dist + ed.ra > rd.ra + eps && dist - ed.ra < rd.outer - eps;
  }

  function warnings() {
    const w = [];
    for (const g of state.gears) {
      for (const msg of getPath(g).warnings) w.push(`${g.name}: ${msg}.`);
      if (g.relation !== 'mesh') continue;
      const p = byId(g.parent);
      if (!p) continue;
      if (p.internal && g.internal) w.push(`${g.name}: two internal gears cannot mesh.`);
      else if (p.internal || g.internal) {
        const [ring, pin] = p.internal ? [p, g] : [g, p];
        if (ring.teeth - pin.teeth < 1) w.push(`${ring.name}: ring must have more teeth than ${pin.name}.`);
        else if (ring.teeth - pin.teeth < 10) w.push(`${ring.name} / ${pin.name}: tooth difference < 10 may cause tip interference.`);
      }
    }
    const col = findCollisions(solved);
    if (col.size) w.push('Overlapping gears: ' + [...col].map((id) => byId(id).name).join(', '));
    return w;
  }

  // ---------------------------------------------------------------- rendering

  function getPath(g) {
    const key = JSON.stringify(GEOM_KEYS.map((k) => g[k]));
    let entry = pathCache.get(key);
    if (!entry) {
      const { paths, dims, warnings: warns } = Geom.gearPaths(g);
      const path = new Path2D();
      for (const pts of paths) {
        path.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
        path.closePath();
      }
      entry = { path, dims, warnings: warns };
      if (pathCache.size > 200) pathCache.clear();
      pathCache.set(key, entry);
    }
    return entry;
  }

  // View centre is the middle of the part of the canvas not covered by the panel.
  const cx = () => (cssW - insetR) / 2;
  const w2s = (x, y) => [cx() + (x - view.x) * view.scale, cssH / 2 + (y - view.y) * view.scale];
  const s2w = (x, y) => [(x - cx()) / view.scale + view.x, (y - cssH / 2) / view.scale + view.y];

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    cssW = r.width; cssH = r.height;
    const pr = $('panel').getBoundingClientRect();
    const covered = pr.left < r.right && pr.top < r.bottom && pr.bottom > r.top;
    insetR = covered ? Math.max(0, r.right - pr.left) : 0;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawGrid() {
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const spacing = steps.find((s) => s * view.scale >= 18) || 1000;
    const [x0, y0] = s2w(0, 0), [x1, y1] = s2w(cssW, cssH);
    ctx.lineWidth = 1;
    for (const major of [false, true]) {
      const sp = major ? spacing * 5 : spacing;
      ctx.strokeStyle = major ? cssVar('--grid-major') : cssVar('--grid');
      ctx.beginPath();
      for (let x = Math.floor(x0 / sp) * sp; x <= x1; x += sp) {
        const sx = Math.round(w2s(x, 0)[0]) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH);
      }
      for (let y = Math.floor(y0 / sp) * sp; y <= y1; y += sp) {
        const sy = Math.round(w2s(0, y)[1]) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(cssW, sy);
      }
      ctx.stroke();
    }
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`grid ${spacing} mm`, 10, cssH - 10);
  }

  function labelText(g, s) {
    if (isRack(g)) return `${g.teeth}T rack · ${fmt(Math.abs(s.v || 0), 1)} mm/s`;
    const rpm = (s.omega * 60) / TAU;
    return `${g.teeth}T · ${fmt(Math.abs(rpm), 2)} rpm ${rpm >= 0 ? '↻' : '↺'}`;
  }

  function draw() {
    ctx.fillStyle = cssVar('--canvas-bg');
    ctx.fillRect(0, 0, cssW, cssH);
    drawGrid();

    const collisions = findCollisions(solved);
    const order = state.gears.slice().sort((a, b) => solved.get(a.id).plane - solved.get(b.id).plane);
    const sel = state.selected;
    const accent = cssVar('--accent');
    const pitchColor = cssVar('--pitch');

    for (const g of order) {
      const s = solved.get(g.id);
      const { path, dims } = getPath(g);
      const [sx, sy] = w2s(s.x, s.y);

      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(view.scale, view.scale);
      ctx.rotate(s.phi);
      ctx.fillStyle = g.color;
      ctx.globalAlpha = s.plane > 0 ? 0.9 : 1;
      ctx.fill(path, 'evenodd');
      ctx.globalAlpha = 1;
      ctx.lineWidth = (g.id === sel ? 2.5 : 1) / view.scale;
      ctx.strokeStyle = collisions.has(g.id) ? '#ff3b30' : g.id === sel ? accent : 'rgba(0,0,0,0.55)';
      ctx.stroke(path);
      if (!isRack(g)) {
        // Rotation marker
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 2 / view.scale;
        ctx.beginPath();
        if (g.internal) {
          ctx.moveTo(dims.rf, 0); ctx.lineTo(dims.outer, 0);
        } else {
          ctx.moveTo(Math.max(g.bore / 2, dims.rf * 0.15), 0); ctx.lineTo(dims.rf * 0.8, 0);
        }
        ctx.stroke();
      }
      ctx.restore();

      if (opts.pitch) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = pitchColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (isRack(g)) {
          const hx = (Math.cos(s.phi) * dims.len) / 2, hy = (Math.sin(s.phi) * dims.len) / 2;
          ctx.moveTo(sx - hx * view.scale, sy - hy * view.scale);
          ctx.lineTo(sx + hx * view.scale, sy + hy * view.scale);
        } else {
          ctx.arc(sx, sy, dims.r * view.scale, 0, TAU);
        }
        ctx.stroke();
        ctx.restore();
      }

      if (!isRack(g)) {
        ctx.strokeStyle = cssVar('--fg');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx - 5, sy); ctx.lineTo(sx + 5, sy);
        ctx.moveTo(sx, sy - 5); ctx.lineTo(sx, sy + 5);
        ctx.stroke();
      }
    }

    if (opts.labels) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      for (const g of order) {
        const s = solved.get(g.id);
        const [sx, sy] = w2s(s.x, s.y);
        const text = labelText(g, s);
        const yOff = s.plane * 16 + 20;
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(sx - w / 2, sy + yOff - 12, w, 17);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, sx, sy + yOff);
      }
      ctx.textAlign = 'start';
    }

    drawMeasure();
  }

  function drawMeasure() {
    const { a, b } = measure;
    if (!measure.on || !a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const [ax, ay] = w2s(a.x, a.y), [bx, by] = w2s(b.x, b.y);
    const color = cssVar('--measure');
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    // End ticks, perpendicular to the line
    const sl = Math.hypot(bx - ax, by - ay) || 1;
    const px = (-(by - ay) / sl) * 7, py = ((bx - ax) / sl) * 7;
    for (const [x, y] of [[ax, ay], [bx, by]]) { ctx.moveTo(x - px, y - py); ctx.lineTo(x + px, y + py); }
    ctx.stroke();
    for (const [pt, x, y] of [[a, ax, ay], [b, bx, by]]) {
      if (!pt.snapped) continue;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, TAU);
      ctx.stroke();
    }
    if (len > 1e-9) {
      // Angle with Y pointing up, like a drawing.
      const ang = Math.atan2(-dy, dx) / DEG;
      const lines = [`${fmt(len, 2)} mm`, `Δx ${fmt(dx, 2)}  Δy ${fmt(-dy, 2)}  ${fmt(ang, 1)}°`];
      ctx.font = '600 13px system-ui, sans-serif';
      const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 14;
      const mx = (ax + bx) / 2 + 10, my = (ay + by) / 2 - 10;
      ctx.fillStyle = 'rgba(5, 15, 30, 0.85)';
      ctx.fillRect(mx, my - 30, w, 38);
      ctx.fillStyle = color;
      ctx.fillText(lines[0], mx + 7, my - 13);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(lines[1], mx + 7, my + 2);
    }
    ctx.restore();
  }

  function frame(now) {
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;
    if (running) simTime += dt * speed;
    solved = solve(simTime);
    draw();
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- editing

  /** Shorten tips of profile-shifted gears so every mesh keeps its root clearance. */
  function applyTipCuts() {
    for (const g of state.gears) g.tipCut = 0;
    for (const g of state.gears) {
      if (g.relation !== 'mesh') continue;
      const p = byId(g.parent);
      if (!p) continue;
      const k = Geom.tipReduction(p, g);
      if (k > 0) {
        g.tipCut = Math.max(g.tipCut, k);
        p.tipCut = Math.max(p.tipCut, k);
      }
    }
  }

  function changed(o) {
    o = o || {};
    applyTipCuts();
    solved = solve(simTime);
    persist();
    if (!o.noRecord) record(o.coalesce);
    if (!o.keepForm) renderForm();
    renderList();
    renderInfo();
  }

  function select(id) {
    state.selected = id;
    changed();
  }

  function freeAngleFor(parent, child) {
    const sol = solve(simTime);
    const ps = sol.get(parent.id);
    const dist = Geom.centerDistance(parent, child);
    const plane = ps.plane;
    for (let i = 0; i < 24; i++) {
      const th = ((i * 45 + (i >= 8 ? 22.5 : 0) + (i >= 16 ? 11.25 : 0)) % 360) * DEG;
      const s = { x: ps.x + dist * Math.cos(th), y: ps.y + dist * Math.sin(th), plane };
      const clash = state.gears.some((g) => {
        if (g.id === parent.id) return false;
        const gs = sol.get(g.id);
        return gs.plane === plane && overlaps(child, s, g, gs);
      });
      if (!clash) return th;
    }
    return 0;
  }

  const inherit = (p) => ({ module: p.module, pressureAngle: p.pressureAngle, backlash: p.backlash, clearance: p.clearance, thickness: p.thickness });

  function addMeshGear() {
    const p = selected();
    if (!p || isRack(p)) return;
    const teeth = p.internal ? Math.max(8, Math.round(p.teeth / 3)) : 20;
    const g = makeGear(Object.assign(inherit(p), { teeth, parent: p.id, relation: 'mesh' }));
    g.angle = freeAngleFor(p, g);
    state.gears.push(g);
    select(g.id);
  }

  function addAxleGear() {
    const p = selected();
    if (!p || isRack(p)) return;
    const g = makeGear(Object.assign(inherit(p), {
      teeth: Math.max(8, Math.round(p.internal ? p.teeth / 3 : p.teeth / 2)),
      bore: p.internal ? 5 : p.bore, boreType: p.internal ? 'round' : p.boreType,
      parent: p.id, relation: 'axle',
    }));
    state.gears.push(g);
    select(g.id);
  }

  function addRack() {
    const p = selected();
    if (!p || !isExternal(p)) return;
    const g = makeGear(Object.assign(inherit(p), {
      type: 'rack', teeth: 16, rackHeight: Math.round(3 * p.module * 10) / 10,
      parent: p.id, relation: 'mesh', angle: Math.PI / 2,
    }));
    state.gears.push(g);
    select(g.id);
  }

  function addFreeGear() {
    const g = makeGear({ x: Math.round(view.x), y: Math.round(view.y) });
    state.gears.push(g);
    select(g.id);
  }

  function deleteSelected() {
    const g = selected();
    if (!g) return;
    const why = lockReason(g, 'delete');
    if (why) { toast(why); return; }
    const doomed = new Set([g.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of state.gears) {
        if (x.parent != null && doomed.has(x.parent) && !doomed.has(x.id)) { doomed.add(x.id); grew = true; }
      }
    }
    state.gears = state.gears.filter((x) => !doomed.has(x.id));
    state.selected = g.parent != null && !doomed.has(g.parent) ? g.parent : (state.gears[0] ? state.gears[0].id : null);
    changed();
  }

  /** Make a child gear the driver: detach from its parent at its current position. */
  function detachSelected() {
    const g = selected();
    if (!g || g.parent == null || isRack(g)) return;
    const s = solved.get(g.id);
    g.x = +s.x.toFixed(3);
    g.y = +s.y.toFixed(3);
    g.rpm = +((s.omega * 60) / TAU).toFixed(4);
    g.phase = 0;
    g.parent = null;
    g.relation = null;
    changed();
  }

  // ---------------------------------------------------------------- form

  const hasSpokes = (g) => isExternal(g) && g.spokes >= 2;
  const FIELDS = [
    { section: 'Basics' },
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'teeth', label: 'Teeth', type: 'number', min: 4, max: 500, step: 1, int: true },
    { key: 'module', label: 'Module (mm)', type: 'number', min: 0.05, max: 100, step: 0.05, mesh: true,
      hint: 'Tooth size. Meshing parts share the same module.' },
    { key: 'pressureAngle', label: 'Pressure angle (°)', type: 'select', options: [14.5, 20, 25], mesh: true },
    { key: 'color', label: 'Colour', type: 'color' },

    { section: 'Tooth form' },
    { key: 'backlash', label: 'Backlash (mm)', type: 'number', min: 0, max: 5, step: 0.01,
      hint: 'Total play between meshing teeth; each part is thinned by half of it.' },
    { key: 'clearance', label: 'Clearance (× module)', type: 'number', min: 0, max: 1, step: 0.05,
      hint: 'Gap between a tooth tip and the bottom of the opposite tooth space. Standard is 0.25.' },
    { key: 'fillet', label: 'Root fillet (× module)', type: 'number', min: 0, max: 1, step: 0.05, show: (g) => !isRack(g),
      hint: 'Radius of the rounded corner at the base of each tooth. Reduced automatically if it does not fit.' },
    { key: 'shift', label: 'Profile shift (x)', type: 'number', min: -1, max: 1.5, step: 0.05, show: isExternal,
      hint: 'Moves the tooth profile outwards (+) to strengthen small gears and avoid undercut. Centre distances adjust automatically.' },

    { section: 'Body' },
    { key: 'internal', label: 'Internal (ring) gear', type: 'checkbox', show: (g) => !isRack(g) },
    { key: 'rimWidth', label: 'Ring rim width (mm)', type: 'number', min: 0, step: 0.5, show: (g) => !isRack(g) && g.internal },
    { key: 'rackHeight', label: 'Backing height (mm)', type: 'number', min: 0.5, step: 0.5, show: isRack,
      hint: 'Solid material below the tooth roots.' },
    { key: 'bore', label: 'Bore Ø (mm)', type: 'number', min: 0, step: 0.5, show: isExternal },
    { key: 'boreType', label: 'Bore shape', type: 'select', text: true, rerender: true, show: (g) => isExternal(g) && g.bore > 0,
      options: [['round', 'Round'], ['keyway', 'Keyway'], ['dflat', 'D-flat']] },
    { key: 'keyWidth', label: 'Keyway width (mm)', type: 'number', min: 0, step: 0.1,
      show: (g) => isExternal(g) && g.bore > 0 && g.boreType === 'keyway' },
    { key: 'keyDepth', label: 'Keyway depth (mm)', type: 'number', min: 0, step: 0.1,
      show: (g) => isExternal(g) && g.bore > 0 && g.boreType === 'keyway', hint: 'Measured outwards from the bore edge.' },
    { key: 'flatDepth', label: 'Flat depth (mm)', type: 'number', min: 0, step: 0.1,
      show: (g) => isExternal(g) && g.bore > 0 && g.boreType === 'dflat', hint: 'How far the flat cuts into the bore circle.' },
    { key: 'spokes', label: 'Spokes (0 = solid)', type: 'number', min: 0, max: 24, step: 1, int: true, rerender: true, show: isExternal },
    { key: 'hubDiameter', label: 'Hub Ø (mm)', type: 'number', min: 0, step: 0.5, show: hasSpokes },
    { key: 'rimThickness', label: 'Rim thickness (mm)', type: 'number', min: 0, step: 0.5, show: hasSpokes,
      hint: 'Solid material between the cut-outs and the tooth roots.' },
    { key: 'spokeWidth', label: 'Spoke width (mm)', type: 'number', min: 0.5, step: 0.5, show: hasSpokes },
    { key: 'thickness', label: 'Thickness (mm, for STL)', type: 'number', min: 0.1, step: 0.5 },

    { section: 'Motion & position' },
    { key: 'locked', label: 'Lock position', type: 'checkbox',
      hint: 'Stops this part being dragged or deleted by accident. Anything that would move it is blocked too.' },
    { key: 'rpm', label: 'Speed (rpm, + = clockwise)', type: 'number', step: 1, show: (g) => g.parent == null },
    { key: 'x', label: 'Centre X (mm)', type: 'number', step: 1, show: (g) => g.parent == null, lockable: true },
    { key: 'y', label: 'Centre Y (mm)', type: 'number', step: 1, show: (g) => g.parent == null, lockable: true },
    { key: 'angle', label: 'Position around parent (°)', type: 'number', step: 1, show: (g) => g.relation === 'mesh', lockable: true,
      get: (g) => +(((g.angle / DEG) % 360 + 360) % 360).toFixed(2), set: (g, v) => { g.angle = v * DEG; } },
    { key: 'phase', label: 'Phase offset (°)', type: 'number', step: 1, show: (g) => g.relation !== 'mesh' },
  ];

  function renderForm() {
    const g = selected();
    $('sel-section').hidden = !g;
    const box = $('props');
    box.innerHTML = '';
    if (!g) return;
    let pendingSection = null;
    for (const f of FIELDS) {
      if (f.section) { pendingSection = f.section; continue; }
      if (f.show && !f.show(g)) continue;
      if (pendingSection) {
        const h = document.createElement('h3');
        h.textContent = pendingSection;
        box.appendChild(h);
        pendingSection = null;
      }
      const row = document.createElement('label');
      row.className = 'field' + (f.type === 'checkbox' ? ' check' : '');
      const span = document.createElement('span');
      span.textContent = f.key === 'teeth' && isRack(g) ? 'Teeth (sets length)' : f.label;
      let input;
      const value = f.get ? f.get(g) : g[f.key];
      if (f.type === 'select') {
        input = document.createElement('select');
        for (const o of f.options) {
          const [val, text] = Array.isArray(o) ? o : [o, o];
          const opt = document.createElement('option');
          opt.value = val; opt.textContent = text;
          input.appendChild(opt);
        }
        input.value = value;
      } else {
        input = document.createElement('input');
        input.type = f.type;
        if (f.type === 'checkbox') input.checked = !!value;
        else input.value = value;
        for (const a of ['min', 'max', 'step']) if (f[a] != null) input[a] = f[a];
      }
      input.dataset.key = f.key;
      if (f.lockable && g.locked) input.disabled = true;
      const evt = f.type === 'checkbox' || f.type === 'select' || f.rerender ? 'change' : 'input';
      input.addEventListener(evt, () => onField(f, input));
      if (f.type === 'checkbox') { row.appendChild(input); row.appendChild(span); }
      else { row.appendChild(span); row.appendChild(input); }
      if (f.hint) row.title = f.hint;
      box.appendChild(row);
    }
    $('btn-add-mesh').hidden = isRack(g);
    $('btn-add-axle').hidden = isRack(g);
    $('btn-add-rack').hidden = !isExternal(g);
    $('btn-detach').hidden = g.parent == null || isRack(g);
  }

  function onField(f, input) {
    const g = selected();
    if (!g) return;
    let v;
    if (f.type === 'checkbox') v = input.checked;
    else if (f.type === 'number' || (f.type === 'select' && !f.text)) {
      v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      if (f.int) v = Math.round(v);
      if (f.min != null && v < f.min) return;
      if (f.max != null && v > f.max) return;
    } else v = input.value;

    if (f.key === 'internal' && v) {
      const others = meshNeighbors(g);
      let problem = null;
      if (others.some((n) => n.internal)) problem = 'Two internal gears cannot mesh with each other.';
      else if (others.some(isRack)) problem = 'A rack can only mesh with an external gear.';
      if (problem) {
        alert(problem);
        input.checked = false;
        return;
      }
      const need = Math.max(36, ...others.map((n) => n.teeth + 12));
      if (g.teeth < need) g.teeth = need;
    }

    if (f.set) f.set(g, v);
    else if (f.mesh) meshComponent(g).forEach((x) => { x[f.key] = v; });
    else g[f.key] = v;

    const rerender = f.type === 'checkbox' || f.rerender;
    changed({ keepForm: !rerender, coalesce: rerender ? null : `field:${g.id}:${f.key}` });
  }

  function renderList() {
    const ul = $('gear-list');
    ul.innerHTML = '';
    const depth = (g) => (g.parent == null ? 0 : 1 + depth(byId(g.parent)));
    const ordered = [];
    const walk = (parentId) => {
      for (const g of state.gears.filter((x) => x.parent === parentId)) { ordered.push(g); walk(g.id); }
    };
    walk(null);
    for (const g of ordered) {
      const li = document.createElement('li');
      li.className = g.id === state.selected ? 'active' : '';
      li.style.paddingLeft = 8 + depth(g) * 14 + 'px';
      const sw = document.createElement('i');
      sw.style.background = g.color;
      li.appendChild(sw);
      const rel = g.relation === 'axle' ? ' ⊙' : g.relation === 'mesh' ? '' : ' ★';
      const kind = isRack(g) ? ' rack' : g.internal ? ' ring' : '';
      li.appendChild(document.createTextNode(`${g.name} — ${g.teeth}T${kind}${rel}${g.locked ? ' 🔒' : ''}`));
      li.addEventListener('click', () => select(g.id));
      ul.appendChild(li);
    }
  }

  function fmt(n, d = 3) {
    return Number.isFinite(n) ? (+n.toFixed(d)).toString() : '—';
  }

  function renderInfo() {
    const g = selected();
    const t = $('info');
    t.innerHTML = '';
    const ws = warnings();
    $('status').textContent = ws.join('  •  ');
    $('status').hidden = !ws.length;
    if (!g) return;
    const d = Geom.dims(g);
    const s = solved.get(g.id);
    const rows = [];
    const p = g.parent != null ? byId(g.parent) : null;

    if (isRack(g)) {
      rows.push(
        ['Pitch', fmt(d.p) + ' mm'],
        ['Length', fmt(d.len) + ' mm'],
        ['Overall height', fmt(d.tipY - d.backY) + ' mm'],
        ['Tooth height', fmt(d.tipY - d.rootY) + ' mm'],
        ['Linear speed', fmt(Math.abs(s.v || 0), 2) + ' mm/s'],
      );
      if (p) {
        rows.push(['Travel per turn of ' + p.name, fmt(Math.PI * p.module * p.teeth) + ' mm']);
        rows.push(['Contact ratio', fmt(Geom.contactRatio(p, g), 3)]);
      }
    } else {
      const rpm = (s.omega * 60) / TAU;
      const driver = byId(s.driver);
      rows.push(
        ['Pitch Ø', fmt(2 * d.r) + ' mm'],
        [g.internal ? 'Tip Ø (inner)' : 'Tip Ø', fmt(2 * d.ra) + ' mm'],
        ['Root Ø', fmt(2 * d.rf) + ' mm'],
        ['Base Ø', fmt(2 * d.rb) + ' mm'],
      );
      if (g.internal) rows.push(['Outer Ø', fmt(2 * d.outer) + ' mm']);
      rows.push(
        ['Circular pitch', fmt(Math.PI * g.module) + ' mm'],
        ['Tooth height', fmt(Math.abs(d.ra - d.rf)) + ' mm'],
      );
      if (g.tipCut > 0) rows.push(['Tip shortened (keeps clearance)', fmt(g.tipCut * g.module) + ' mm']);
      rows.push(['Speed', `${fmt(Math.abs(rpm))} rpm ${rpm >= 0 ? 'CW' : 'CCW'}`]);
      if (driver && driver.id !== g.id && driver.rpm !== 0) {
        rows.push([`Ratio to ${driver.name}`, `${fmt(Math.abs(driver.rpm / rpm), 4)} : 1`]);
      }
      if (g.relation === 'mesh' && p) {
        const mg = Geom.meshGeometry(p, g);
        rows.push(['Centre distance', fmt(Math.abs(mg.a)) + ' mm']);
        if (Math.abs(mg.alphaW - g.pressureAngle * DEG) > 1e-6) rows.push(['Working pressure angle', fmt(mg.alphaW / DEG, 2) + '°']);
        rows.push(['Contact ratio', fmt(Geom.contactRatio(p, g), 3)]);
      }
      if (isExternal(g)) {
        const xmin = Geom.minShift(g);
        if (g.shift < xmin - 1e-3) {
          const fix = Math.ceil(xmin * 100) / 100;
          const btn = document.createElement('button');
          btn.textContent = `Set shift to ${fix}`;
          btn.addEventListener('click', () => { g.shift = fix; changed(); });
          rows.push(['Undercut likely (not drawn)', btn]);
        }
      }
    }
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      const td = document.createElement('td');
      th.textContent = k;
      if (v instanceof Node) td.appendChild(v); else td.textContent = v;
      tr.append(th, td);
      t.appendChild(tr);
    }
  }

  // ---------------------------------------------------------------- pointer

  function hitTest(sx, sy) {
    const [wx, wy] = s2w(sx, sy);
    let best = null;
    for (const g of state.gears) {
      const s = solved.get(g.id);
      const d = Geom.dims(g);
      let inside, size;
      if (isRack(g)) {
        const dx = wx - s.x, dy = wy - s.y, c = Math.cos(s.phi), sn = Math.sin(s.phi);
        const lx = dx * c + dy * sn, ly = -dx * sn + dy * c;
        inside = Math.abs(lx) <= d.len / 2 && ly >= d.backY && ly <= d.tipY;
        size = d.len / 2;
      } else {
        const r = Math.hypot(wx - s.x, wy - s.y);
        inside = g.internal ? r >= d.ra && r <= d.outer : r <= d.ra;
        size = d.ra;
      }
      if (!inside) continue;
      // Prefer the top plane, then the smallest part on it.
      if (!best || s.plane > best.plane || (s.plane === best.plane && size < best.size)) {
        best = { g, plane: s.plane, size };
      }
    }
    return best ? best.g : null;
  }

  let drag = null;

  const pointerPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  /** Measuring snaps to part centres within a few pixels. */
  function measurePoint(sx, sy, from, angleSnap) {
    let best = null, bestD = 10;
    for (const g of state.gears) {
      const s = solved.get(g.id);
      const [px, py] = w2s(s.x, s.y);
      const dd = Math.hypot(px - sx, py - sy);
      if (dd < bestD) { bestD = dd; best = [s.x, s.y]; }
    }
    if (best) return { x: best[0], y: best[1], snapped: true };
    let [wx, wy] = s2w(sx, sy);
    if (angleSnap && from) {
      const len = Math.hypot(wx - from.x, wy - from.y);
      const ang = Math.round(Math.atan2(wy - from.y, wx - from.x) / (15 * DEG)) * 15 * DEG;
      wx = from.x + len * Math.cos(ang);
      wy = from.y + len * Math.sin(ang);
    }
    return { x: wx, y: wy, snapped: false };
  }

  function setMeasure(on) {
    measure.on = on;
    measure.a = measure.b = null;
    measure.dragging = false;
    $('btn-measure').classList.toggle('active', on);
    canvas.style.cursor = on ? 'crosshair' : '';
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = pointerPos(e);
    if (measure.on) {
      measure.a = measurePoint(sx, sy);
      measure.b = measure.a;
      measure.dragging = true;
      return;
    }
    const hit = hitTest(sx, sy);
    const [wx, wy] = s2w(sx, sy);
    if (hit) {
      if (state.selected !== hit.id) select(hit.id);
      // Same-axle gears move with their parent.
      let target = hit;
      while (target.relation === 'axle') target = byId(target.parent);
      const why = lockReason(target, 'move');
      if (why) {
        drag = { mode: 'blocked', why, sx, sy };
        return;
      }
      drag = { mode: 'gear', target, wx, wy, moved: false };
      if (target.relation === 'mesh') {
        const ps = solved.get(target.parent);
        drag.startMouse = Math.atan2(wy - ps.y, wx - ps.x);
        drag.startAngle = target.angle;
      } else {
        drag.startX = target.x; drag.startY = target.y;
      }
    } else {
      drag = { mode: 'pan', sx, sy, vx: view.x, vy: view.y, moved: false };
    }
  });

  function hoverCursor(sx, sy) {
    if (measure.on) return 'crosshair';
    const hit = hitTest(sx, sy);
    if (!hit) return '';
    let target = hit;
    while (target.relation === 'axle') target = byId(target.parent);
    return lockReason(target, 'move') ? 'not-allowed' : 'move';
  }

  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = pointerPos(e);
    if (measure.on) {
      if (measure.dragging) measure.b = measurePoint(sx, sy, measure.a, e.shiftKey);
      return;
    }
    if (!drag) { canvas.style.cursor = hoverCursor(sx, sy); return; }
    if (drag.mode === 'blocked') {
      if (!drag.warned && Math.hypot(sx - drag.sx, sy - drag.sy) > 4) { drag.warned = true; toast(drag.why); }
      return;
    }
    drag.moved = true;
    if (drag.mode === 'pan') {
      view.x = drag.vx - (sx - drag.sx) / view.scale;
      view.y = drag.vy - (sy - drag.sy) / view.scale;
      return;
    }
    const [wx, wy] = s2w(sx, sy);
    const t = drag.target;
    if (t.relation === 'mesh') {
      const ps = solved.get(t.parent);
      t.angle = drag.startAngle + Math.atan2(wy - ps.y, wx - ps.x) - drag.startMouse;
    } else {
      let nx = drag.startX + wx - drag.wx, ny = drag.startY + wy - drag.wy;
      if (e.shiftKey) { nx = Math.round(nx); ny = Math.round(ny); }
      t.x = +nx.toFixed(3); t.y = +ny.toFixed(3);
    }
    solved = solve(simTime);
  });

  function endDrag() {
    if (measure.on) {
      measure.dragging = false;
      return;
    }
    if (!drag) return;
    if (drag.mode === 'pan' && !drag.moved) select(null);
    else if (drag.mode === 'gear' && drag.moved) changed();
    drag = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const [wx, wy] = s2w(sx, sy);
    const f = Math.exp(-e.deltaY * 0.0015);
    view.scale = Math.min(200, Math.max(0.05, view.scale * f));
    // keep point under the cursor fixed
    view.x = wx - (sx - cx()) / view.scale;
    view.y = wy - (sy - cssH / 2) / view.scale;
  }, { passive: false });

  function fit() {
    if (!state.gears.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of state.gears) {
      const s = solved.get(g.id);
      const r = Geom.dims(g).outer;
      x0 = Math.min(x0, s.x - r); x1 = Math.max(x1, s.x + r);
      y0 = Math.min(y0, s.y - r); y1 = Math.max(y1, s.y + r);
    }
    view.x = (x0 + x1) / 2;
    view.y = (y0 + y1) / 2;
    view.scale = Math.min((cssW - insetR) / (x1 - x0), cssH / (y1 - y0)) * 0.85;
  }

  // ---------------------------------------------------------------- export

  function download(name, data, type) {
    const blob = new Blob([data], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  const fileBase = (g) => `${g.name.replace(/[^\w.-]+/g, '_')}_${g.teeth}T_m${g.module}`;

  function bounds(pathsList) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pts of pathsList) {
      for (const [x, y] of pts) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return { x0, y0, x1, y1 };
  }

  function describe(g) {
    const d = Geom.dims(g);
    const base = `${g.name}: ${g.teeth} teeth, module ${g.module}, PA ${g.pressureAngle}°`;
    if (isRack(g)) return `${base}, rack length ${fmt(d.len)} mm`;
    return `${base}, pitch Ø ${fmt(2 * d.r)} mm` + (g.shift ? `, shift ${g.shift}` : '');
  }

  function exportSelectedSVG() {
    const g = selected();
    if (!g) return;
    const { paths } = Geom.gearPaths(g);
    const b = bounds(paths);
    const m = 2;
    const w = (b.x1 - b.x0 + 2 * m).toFixed(3), h = (b.y1 - b.y0 + 2 * m).toFixed(3);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${(b.x0 - m).toFixed(3)} ${(b.y0 - m).toFixed(3)} ${w} ${h}">
  <!-- ${describe(g)} -->
  <path d="${Geom.svgPathData(paths)}" fill="none" stroke="#000" stroke-width="0.1" fill-rule="evenodd"/>
  <circle cx="0" cy="0" r="0.5" fill="none" stroke="#f00" stroke-width="0.1"/>
</svg>
`;
    download(fileBase(g) + '.svg', svg, 'image/svg+xml');
  }

  function exportSelectedDXF() {
    const g = selected();
    if (!g) return;
    const { paths } = Geom.gearPaths(g);
    download(fileBase(g) + '.dxf', Geom.dxf(paths.map((p) => Geom.transformPts(p, 0, 0, 0, true))), 'application/dxf');
  }

  function exportSelectedSTL() {
    const g = selected();
    if (!g) return;
    const { paths } = Geom.gearPaths(g);
    // Flip Y so the part looks the same from above (+Z) as on screen.
    const buf = Geom.stl(paths.map((p) => Geom.transformPts(p, 0, 0, 0, true)), g.thickness, describe(g));
    download(fileBase(g) + '.stl', buf, 'model/stl');
  }

  /** World-space paths for every part in the current layout. */
  function layoutParts() {
    const order = state.gears.slice().sort((a, b) => solved.get(a.id).plane - solved.get(b.id).plane);
    return order.map((g) => {
      const s = solved.get(g.id);
      const paths = Geom.gearPaths(g).paths.map((p) => Geom.transformPts(p, s.x, s.y, s.phi, false));
      return { g, s, paths };
    });
  }

  function exportLayoutSVG() {
    if (!state.gears.length) return;
    const parts = layoutParts();
    const b = bounds(parts.flatMap((p) => p.paths));
    const m = 5;
    const w = (b.x1 - b.x0 + 2 * m).toFixed(3), h = (b.y1 - b.y0 + 2 * m).toFixed(3);
    const body = parts.map(({ g, paths }) =>
      `  <path id="${fileBase(g)}" d="${Geom.svgPathData(paths)}" fill="${g.color}" fill-opacity="0.85" stroke="#000" stroke-width="0.15" fill-rule="evenodd"/>`);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${(b.x0 - m).toFixed(3)} ${(b.y0 - m).toFixed(3)} ${w} ${h}">
${body.join('\n')}
</svg>
`;
    download('gear_layout.svg', svg, 'image/svg+xml');
  }

  // ---------------------------------------------------------------- print (true scale)

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function printParts(which) {
    let parts;
    if (which === 'selected') {
      const g = selected();
      if (!g) return;
      parts = [{ g, s: { x: 0, y: 0, phi: 0 }, paths: Geom.gearPaths(g).paths }];
    } else {
      if (!state.gears.length) return;
      parts = layoutParts();
    }
    const b = bounds(parts.flatMap((p) => p.paths));
    const m = 6;
    const bar = 50; // mm
    const x0 = b.x0 - m, y0 = b.y0 - m;
    const w = b.x1 - b.x0 + 2 * m;
    const h = b.y1 - b.y0 + 2 * m + 14; // room for the scale bar
    const body = [];
    for (const { g, s, paths } of parts) {
      body.push(`<path d="${Geom.svgPathData(paths)}" fill="${which === 'selected' ? 'none' : g.color}" fill-opacity="0.25" stroke="#000" stroke-width="0.2" fill-rule="evenodd"/>`);
      if (!isRack(g)) {
        body.push(`<path d="M${s.x - 3} ${s.y} H${s.x + 3} M${s.x} ${s.y - 3} V${s.y + 3}" stroke="#000" stroke-width="0.15"/>`);
      }
    }
    const by = b.y1 + m + 6;
    body.push(`<path d="M${x0 + m} ${by} h${bar} M${x0 + m} ${by - 2} v4 M${x0 + m + bar} ${by - 2} v4" stroke="#000" stroke-width="0.3" fill="none"/>`);
    body.push(`<text x="${x0 + m}" y="${by + 6}" font-size="3" font-family="sans-serif">${bar} mm — measure this to check the print scale</text>`);

    const list = parts.map(({ g }) => `<li>${esc(describe(g))}</li>`).join('');
    const tooBig = w > 190 || h > 277;
    $('print-area').innerHTML = `
      <h1>GearGen — ${which === 'selected' ? esc(parts[0].g.name) : 'layout'} (1:1)</h1>
      <p>Print at <b>100% / “Actual size”</b> with scaling turned off. The bar below the drawing should measure exactly ${bar} mm.</p>
      ${tooBig ? `<p class="warn">This drawing is ${fmt(w, 0)} × ${fmt(h, 0)} mm, which is larger than an A4 page — choose a larger paper size or export the SVG instead.</p>` : ''}
      <svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(3)}mm" height="${h.toFixed(3)}mm" viewBox="${x0.toFixed(3)} ${y0.toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}">${body.join('')}</svg>
      <ul>${list}</ul>`;
    window.print();
  }

  // ---------------------------------------------------------------- wiring

  function setRunning(r) {
    running = r;
    $('btn-play').textContent = running ? 'Pause' : 'Play';
  }

  $('btn-play').addEventListener('click', () => setRunning(!running));
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('speed').addEventListener('input', (e) => {
    speed = parseFloat(e.target.value);
    $('speed-val').textContent = speed.toFixed(2) + '×';
  });
  $('btn-fit').addEventListener('click', fit);
  $('btn-measure').addEventListener('click', () => setMeasure(!measure.on));
  $('opt-pitch').addEventListener('change', (e) => { opts.pitch = e.target.checked; });
  $('opt-labels').addEventListener('change', (e) => { opts.labels = e.target.checked; });
  $('btn-add-free').addEventListener('click', addFreeGear);
  $('btn-add-mesh').addEventListener('click', addMeshGear);
  $('btn-add-axle').addEventListener('click', addAxleGear);
  $('btn-add-rack').addEventListener('click', addRack);
  $('btn-detach').addEventListener('click', detachSelected);
  $('btn-delete').addEventListener('click', deleteSelected);
  $('btn-svg').addEventListener('click', exportSelectedSVG);
  $('btn-dxf').addEventListener('click', exportSelectedDXF);
  $('btn-stl').addEventListener('click', exportSelectedSTL);
  $('btn-layout-svg').addEventListener('click', exportLayoutSVG);
  $('btn-print-sel').addEventListener('click', () => printParts('selected'));
  $('btn-print-layout').addEventListener('click', () => printParts('layout'));
  $('btn-save').addEventListener('click', () => download('gears.json', JSON.stringify(state, null, 2), 'application/json'));
  $('btn-load').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      loadState(JSON.parse(await file.text()));
      changed();
      fit();
    } catch (err) {
      alert('Could not load file: ' + err.message);
    }
  });
  $('btn-reset').addEventListener('click', () => {
    if (!confirm('Discard all gears and start over? (You can undo this.)')) return;
    defaultState();
    changed();
    fit();
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && key === 'y') { e.preventDefault(); redo(); }
    else if (mod) return;
    else if (e.code === 'Space') { e.preventDefault(); setRunning(!running); }
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if (key === 'f') fit();
    else if (key === 'm') setMeasure(!measure.on);
    else if (e.key === 'Escape' && measure.on) setMeasure(false);
  });

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  ro.observe($('panel'));

  // ---------------------------------------------------------------- boot

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) loadState(JSON.parse(saved)); else defaultState();
  } catch (e) {
    defaultState();
  }
  resize();
  changed();
  fit();
  requestAnimationFrame(frame);
})();
