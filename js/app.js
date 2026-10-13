(function () {
  'use strict';

  const Geom = window.GearGeom;
  const STORAGE_KEY = 'geargen.state.v1';
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const PALETTE = ['#e8a33d', '#4c9be8', '#5cc08a', '#d9634c', '#a77fe0', '#e0c341', '#45bfc4', '#e67fb0'];

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

  // ---------------------------------------------------------------- state

  function makeGear(props) {
    const id = state.nextId++;
    return Object.assign({
      id,
      name: 'Gear ' + id,
      teeth: 20,
      module: 2,
      pressureAngle: 20,
      backlash: 0.1,
      bore: 5,
      internal: false,
      rimWidth: 8,
      color: PALETTE[(id - 1) % PALETTE.length],
      parent: null,
      relation: null, // 'mesh' | 'axle'
      angle: 0, // position angle around parent (mesh)
      x: 0,
      y: 0,
      rpm: 10, // driver gears only
      phase: 0, // driver / same-axle gears only
    }, props);
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

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function loadState(obj) {
    if (!obj || !Array.isArray(obj.gears)) throw new Error('Not a GearGen file');
    const ids = new Set(obj.gears.map((g) => g.id));
    state = {
      gears: obj.gears.map((g) => Object.assign({}, g)),
      nextId: Math.max(obj.nextId || 1, ...obj.gears.map((g) => g.id + 1), 1),
      selected: ids.has(obj.selected) ? obj.selected : (obj.gears[0] ? obj.gears[0].id : null),
    };
    // Make sure every gear's parent is defined before it (draw/solve order relies on it).
    state.gears.forEach((g) => { if (g.parent != null && !ids.has(g.parent)) { g.parent = null; g.relation = null; } });
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
        const w = (g.rpm * TAU) / 60;
        res = { x: g.x, y: g.y, omega: w, phi: g.phase * DEG + w * t, plane: 0, driver: g.id };
      } else {
        visiting.add(g.id);
        const ps = get(p);
        visiting.delete(g.id);
        if (g.relation === 'axle') {
          res = { x: ps.x, y: ps.y, omega: ps.omega, phi: ps.phi + g.phase * DEG, plane: ps.plane + 1, driver: ps.driver };
        } else {
          const dist = Geom.centerDistance(p, g);
          const th = g.angle;
          const internalPair = p.internal || g.internal;
          const k = internalPair ? 1 : -1;
          const ratio = p.teeth / g.teeth;
          // Contact direction as seen from each gear's centre.
          let psiP, psiC;
          if (!internalPair) { psiP = th; psiC = th + Math.PI; }
          else if (p.internal) { psiP = psiC = th; }
          else { psiP = psiC = th + Math.PI; }
          // Parent tooth at contact <=> child gap at contact.
          const phi = psiC + Math.PI / g.teeth + k * (ps.phi - psiP) * ratio;
          res = {
            x: ps.x + dist * Math.cos(th),
            y: ps.y + dist * Math.sin(th),
            omega: k * ps.omega * ratio,
            phi,
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

  function overlaps(a, sa, b, sb) {
    const da = Geom.dims(a), db = Geom.dims(b);
    const dist = Math.hypot(sa.x - sb.x, sa.y - sb.y);
    const eps = 1e-6;
    if (!a.internal && !b.internal) return dist < da.ra + db.ra - eps;
    if (a.internal && b.internal) return dist < da.outer + db.outer - eps && !(dist + db.outer < da.ra || dist + da.outer < db.ra);
    const [ring, rd, ext, ed] = a.internal ? [a, da, b, db] : [b, db, a, da];
    void ring; void ext;
    return dist + ed.ra > rd.ra + eps && dist - ed.ra < rd.outer - eps;
  }

  function warnings() {
    const w = [];
    for (const g of state.gears) {
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
    const key = [g.teeth, g.module, g.pressureAngle, g.backlash, g.bore, g.internal, g.rimWidth].join('|');
    let entry = pathCache.get(key);
    if (!entry) {
      const { paths, dims } = Geom.gearPaths(g);
      const path = new Path2D();
      for (const pts of paths) {
        path.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
        path.closePath();
      }
      entry = { path, dims };
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
    const overlaps = pr.left < r.right && pr.top < r.bottom && pr.bottom > r.top;
    insetR = overlaps ? Math.max(0, r.right - pr.left) : 0;
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

  function draw() {
    ctx.fillStyle = cssVar('--canvas-bg');
    ctx.fillRect(0, 0, cssW, cssH);
    drawGrid();

    const collisions = findCollisions(solved);
    const order = state.gears.slice().sort((a, b) => solved.get(a.id).plane - solved.get(b.id).plane);
    const sel = state.selected;
    const accent = cssVar('--accent');

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
      ctx.restore();

      if (opts.pitch) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = cssVar('--pitch');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, dims.r * view.scale, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }

      // Axle
      ctx.strokeStyle = cssVar('--fg');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 5, sy); ctx.lineTo(sx + 5, sy);
      ctx.moveTo(sx, sy - 5); ctx.lineTo(sx, sy + 5);
      ctx.stroke();
    }

    if (opts.labels) {
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      for (const g of order) {
        const s = solved.get(g.id);
        const [sx, sy] = w2s(s.x, s.y);
        const rpm = (s.omega * 60) / TAU;
        const text = `${g.teeth}T · ${fmt(Math.abs(rpm), 2)} rpm ${rpm >= 0 ? '↻' : '↺'}`;
        const yOff = s.plane * 16 + 20;
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(sx - w / 2, sy + yOff - 12, w, 17);
        ctx.fillStyle = '#fff';
        ctx.fillText(text, sx, sy + yOff);
      }
      ctx.textAlign = 'start';
    }
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

  function changed(opts2) {
    solved = solve(simTime);
    persist();
    if (!opts2 || !opts2.keepForm) renderForm();
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

  function addMeshGear() {
    const p = selected();
    if (!p) return;
    const teeth = p.internal ? Math.max(8, Math.round(p.teeth / 3)) : 20;
    const g = makeGear({
      teeth, module: p.module, pressureAngle: p.pressureAngle, backlash: p.backlash,
      parent: p.id, relation: 'mesh',
    });
    g.angle = freeAngleFor(p, g);
    state.gears.push(g);
    select(g.id);
  }

  function addAxleGear() {
    const p = selected();
    if (!p) return;
    const g = makeGear({
      teeth: Math.max(8, Math.round(p.internal ? p.teeth / 3 : p.teeth / 2)),
      module: p.module, pressureAngle: p.pressureAngle, backlash: p.backlash,
      bore: p.internal ? 5 : p.bore, parent: p.id, relation: 'axle',
    });
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
    if (!g || g.parent == null) return;
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

  const FIELDS = [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'teeth', label: 'Teeth', type: 'number', min: 4, max: 500, step: 1, int: true },
    { key: 'module', label: 'Module (mm)', type: 'number', min: 0.05, max: 100, step: 0.05, mesh: true,
      hint: 'Meshing gears share the same module.' },
    { key: 'pressureAngle', label: 'Pressure angle (°)', type: 'select', options: [14.5, 20, 25], mesh: true },
    { key: 'backlash', label: 'Backlash (mm)', type: 'number', min: 0, max: 5, step: 0.01 },
    { key: 'bore', label: 'Bore Ø (mm)', type: 'number', min: 0, step: 0.5, show: (g) => !g.internal },
    { key: 'internal', label: 'Internal (ring) gear', type: 'checkbox' },
    { key: 'rimWidth', label: 'Rim width (mm)', type: 'number', min: 0, step: 0.5, show: (g) => g.internal },
    { key: 'rpm', label: 'Speed (rpm, + = clockwise)', type: 'number', step: 1, show: (g) => g.parent == null },
    { key: 'x', label: 'Centre X (mm)', type: 'number', step: 1, show: (g) => g.parent == null },
    { key: 'y', label: 'Centre Y (mm)', type: 'number', step: 1, show: (g) => g.parent == null },
    { key: 'angle', label: 'Position around parent (°)', type: 'number', step: 1, show: (g) => g.relation === 'mesh',
      get: (g) => +(((g.angle / DEG) % 360 + 360) % 360).toFixed(2), set: (g, v) => { g.angle = v * DEG; } },
    { key: 'phase', label: 'Phase offset (°)', type: 'number', step: 1, show: (g) => g.relation !== 'mesh' },
    { key: 'color', label: 'Colour', type: 'color' },
  ];

  function renderForm() {
    const g = selected();
    $('sel-section').hidden = !g;
    const box = $('props');
    box.innerHTML = '';
    if (!g) return;
    for (const f of FIELDS) {
      if (f.show && !f.show(g)) continue;
      const row = document.createElement('label');
      row.className = 'field' + (f.type === 'checkbox' ? ' check' : '');
      const span = document.createElement('span');
      span.textContent = f.label;
      let input;
      const value = f.get ? f.get(g) : g[f.key];
      if (f.type === 'select') {
        input = document.createElement('select');
        for (const o of f.options) {
          const opt = document.createElement('option');
          opt.value = o; opt.textContent = o;
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
      input.addEventListener(f.type === 'checkbox' || f.type === 'select' ? 'change' : 'input', () => onField(f, input));
      if (f.type === 'checkbox') { row.appendChild(input); row.appendChild(span); }
      else { row.appendChild(span); row.appendChild(input); }
      if (f.hint) row.title = f.hint;
      box.appendChild(row);
    }
    $('btn-detach').hidden = g.parent == null;
  }

  function onField(f, input) {
    const g = selected();
    if (!g) return;
    let v;
    if (f.type === 'checkbox') v = input.checked;
    else if (f.type === 'number' || f.type === 'select') {
      v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      if (f.int) v = Math.round(v);
      if (f.min != null && v < f.min) return;
      if (f.max != null && v > f.max) return;
    } else v = input.value;

    if (f.key === 'internal' && v) {
      const others = meshNeighbors(g);
      if (others.some((n) => n.internal)) {
        alert('Two internal gears cannot mesh with each other.');
        input.checked = false;
        return;
      }
      const need = Math.max(36, ...others.map((n) => n.teeth + 12));
      if (g.teeth < need) g.teeth = need;
    }

    if (f.set) f.set(g, v);
    else if (f.mesh) meshComponent(g).forEach((x) => { x[f.key] = v; });
    else g[f.key] = v;

    changed({ keepForm: f.type !== 'checkbox' });
  }

  function renderList() {
    const ul = $('gear-list');
    ul.innerHTML = '';
    const depth = (g) => (g.parent == null ? 0 : 1 + depth(byId(g.parent)));
    // Tree order
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
      li.appendChild(document.createTextNode(`${g.name} — ${g.teeth}T${g.internal ? ' ring' : ''}${rel}`));
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
    const rpm = (s.omega * 60) / TAU;
    const driver = byId(s.driver);
    const rows = [
      ['Pitch Ø', fmt(2 * d.r) + ' mm'],
      [g.internal ? 'Tip Ø (inner)' : 'Tip Ø', fmt(2 * d.ra) + ' mm'],
      ['Root Ø', fmt(2 * d.rf) + ' mm'],
      ['Base Ø', fmt(2 * d.rb) + ' mm'],
    ];
    if (g.internal) rows.push(['Outer Ø', fmt(2 * d.outer) + ' mm']);
    rows.push(
      ['Circular pitch', fmt(Math.PI * g.module) + ' mm'],
      ['Tooth height', fmt(2.25 * g.module) + ' mm'],
      ['Speed', `${fmt(Math.abs(rpm))} rpm ${rpm >= 0 ? 'CW' : 'CCW'}`],
    );
    if (driver && driver.id !== g.id && driver.rpm !== 0) {
      const ratio = driver.rpm / rpm;
      rows.push([`Ratio to ${driver.name}`, `${fmt(Math.abs(ratio), 4)} : 1`]);
    }
    if (g.relation === 'mesh') {
      const p = byId(g.parent);
      rows.push(['Centre distance', fmt(Math.abs(Geom.centerDistance(p, g))) + ' mm']);
      rows.push(['Contact ratio', fmt(Geom.contactRatio(p, g), 3)]);
    }
    if (!g.internal) {
      const zmin = Math.ceil(2 / Math.sin(g.pressureAngle * DEG) ** 2);
      if (g.teeth < zmin) rows.push(['Note', `Undercut likely below ${zmin} teeth (not modelled)`]);
    }
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<th></th><td></td>`;
      tr.children[0].textContent = k;
      tr.children[1].textContent = v;
      t.appendChild(tr);
    }
  }

  // ---------------------------------------------------------------- pointer

  function hitTest(sx, sy) {
    const [wx, wy] = s2w(sx, sy);
    const order = state.gears.slice().sort((a, b) => solved.get(b.id).plane - solved.get(a.id).plane);
    let best = null;
    for (const g of order) {
      const s = solved.get(g.id);
      const d = Geom.dims(g);
      const r = Math.hypot(wx - s.x, wy - s.y);
      const inside = g.internal ? r >= d.ra && r <= d.outer : r <= d.ra;
      if (!inside) continue;
      // Prefer the top plane, then the smallest gear on it.
      if (!best || s.plane > best.plane || (s.plane === best.plane && d.ra < best.size)) {
        best = { g, plane: s.plane, size: d.ra };
      }
    }
    return best ? best.g : null;
  }

  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = hitTest(sx, sy);
    const [wx, wy] = s2w(sx, sy);
    if (hit) {
      if (state.selected !== hit.id) select(hit.id);
      // Same-axle gears move with their parent.
      let target = hit;
      while (target.relation === 'axle') target = byId(target.parent);
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

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
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

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  const fileBase = (g) => `${g.name.replace(/[^\w.-]+/g, '_')}_${g.teeth}T_m${g.module}`;

  function exportSelectedSVG() {
    const g = selected();
    if (!g) return;
    const { paths, dims } = Geom.gearPaths(g);
    const R = dims.outer + 2;
    const size = (2 * R).toFixed(3);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}mm" height="${size}mm" viewBox="${-R} ${-R} ${size} ${size}">
  <!-- ${g.name}: ${g.teeth} teeth, module ${g.module}, PA ${g.pressureAngle}°, pitch Ø ${(2 * dims.r).toFixed(3)} mm -->
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

  function exportLayoutSVG() {
    if (!state.gears.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const body = [];
    const order = state.gears.slice().sort((a, b) => solved.get(a.id).plane - solved.get(b.id).plane);
    for (const g of order) {
      const s = solved.get(g.id);
      const { paths, dims } = Geom.gearPaths(g);
      const tp = paths.map((p) => Geom.transformPts(p, s.x, s.y, s.phi, false));
      x0 = Math.min(x0, s.x - dims.outer); x1 = Math.max(x1, s.x + dims.outer);
      y0 = Math.min(y0, s.y - dims.outer); y1 = Math.max(y1, s.y + dims.outer);
      body.push(`  <path id="${fileBase(g)}" d="${Geom.svgPathData(tp)}" fill="${g.color}" fill-opacity="0.85" stroke="#000" stroke-width="0.15" fill-rule="evenodd"/>`);
    }
    const m = 5;
    x0 -= m; y0 -= m; x1 += m; y1 += m;
    const w = (x1 - x0).toFixed(3), h = (y1 - y0).toFixed(3);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${x0.toFixed(3)} ${y0.toFixed(3)} ${w} ${h}">
${body.join('\n')}
</svg>
`;
    download('gear_layout.svg', svg, 'image/svg+xml');
  }

  // ---------------------------------------------------------------- wiring

  function setRunning(r) {
    running = r;
    $('btn-play').textContent = running ? 'Pause' : 'Play';
  }

  $('btn-play').addEventListener('click', () => setRunning(!running));
  $('speed').addEventListener('input', (e) => {
    speed = parseFloat(e.target.value);
    $('speed-val').textContent = speed.toFixed(2) + '×';
  });
  $('btn-fit').addEventListener('click', fit);
  $('opt-pitch').addEventListener('change', (e) => { opts.pitch = e.target.checked; });
  $('opt-labels').addEventListener('change', (e) => { opts.labels = e.target.checked; });
  $('btn-add-free').addEventListener('click', addFreeGear);
  $('btn-add-mesh').addEventListener('click', addMeshGear);
  $('btn-add-axle').addEventListener('click', addAxleGear);
  $('btn-detach').addEventListener('click', detachSelected);
  $('btn-delete').addEventListener('click', deleteSelected);
  $('btn-svg').addEventListener('click', exportSelectedSVG);
  $('btn-dxf').addEventListener('click', exportSelectedDXF);
  $('btn-layout-svg').addEventListener('click', exportLayoutSVG);
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
    if (!confirm('Discard all gears and start over?')) return;
    defaultState();
    changed();
    fit();
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
    if (e.code === 'Space') { e.preventDefault(); setRunning(!running); }
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if (e.key === 'f') fit();
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
