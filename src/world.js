'use strict';
// ---------------------------------------------------------------------------
// Procedural world: container terminal, cranes, ship, lamps, lights, sea
// ---------------------------------------------------------------------------
const DOCK_Y = 2.6;

// Trochoidal wave set shared by the sea shaders and the CPU (buoys, ship)
const WAVES = (() => {
  const lam = [34, 21, 13, 8.5, 5.5, 3.6, 2.4, 1.7];
  const steep = [0.035, 0.045, 0.055, 0.07, 0.08, 0.085, 0.08, 0.07];
  const off = [0, 0.45, -0.38, 0.8, -0.75, 0.25, -1.1, 1.2];
  return lam.map((l, i) => {
    const k = 2 * Math.PI / l, a = 1.25 + off[i];
    return { dx: Math.cos(a), dz: Math.sin(a), k, amp: steep[i] / k, w: Math.sqrt(9.81 * k) };
  });
})();
function waveHeight(x, z, t) {
  let h = 0;
  for (const w of WAVES) h += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t);
  return h;
}
function blinkValue(t, phase, period) {
  const f = (((t / period + phase) % 1) + 1) % 1;
  return smooth(f / 0.06) * (1 - smooth((f - 0.25) / 0.08));
}

function buildSeaMesh(gl) {
  const rings = 210, segs = 192, v = [], idx = [];
  for (let j = 0; j < rings; j++) {
    const r = 0.6 * (Math.pow(1.045, j) - 1);
    for (let i = 0; i <= segs; i++) v.push(r, i / segs * Math.PI * 2);
  }
  for (let j = 0; j < rings - 1; j++) for (let i = 0; i < segs; i++) {
    const k = j * (segs + 1) + i;
    idx.push(k, k + 1, k + segs + 2, k, k + segs + 2, k + segs + 1);
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, count: idx.length };
}

function buildWorld(gl) {
  const R = mulberry32(20261111);
  const Y0 = DOCK_Y;
  const lights = [], dyn = [];
  const S = new MeshBuilder();

  const SODIUM = [1.0, 0.55, 0.19], LED = [0.74, 0.87, 1.0], TUNG = [1.0, 0.72, 0.42],
        FLUO = [0.62, 1.0, 0.84], RED = [1.0, 0.07, 0.04], GREEN = [0.1, 1.0, 0.4], WARM = [1.0, 0.86, 0.66];

  function addLight(o) {
    const L = Object.assign({ pos: [0, 0, 0], dir: null, color: [1, 1, 1], intensity: 1, range: 30, outer: 60, inner: 35,
                              vol: 1, shadow: false, fixed: false, parent: null, radius: 0.2, mod: 1, blink: null, flicker: false }, o);
    L.lpos = L.pos.slice();
    L.ldir = L.dir ? V3.norm(L.dir) : null;
    L.dir = L.ldir ? L.ldir.slice() : null;
    lights.push(L);
    return L;
  }
  const emissive = (mb, c, k) => mb.material(4, 0.4, 0, k).color(c[0], c[1], c[2]);
  function blinker(mb, pos, c, k, phase, period, r) {
    mb.material(8, 0.3, 0, k).color(c[0], c[1], c[2]);
    mb.uvFix = [phase, period];
    mb.sphere(pos, r, 8);
    mb.uvFix = null;
  }

  const CC = [[0.55, 0.08, 0.06], [0.08, 0.18, 0.42], [0.75, 0.33, 0.05], [0.07, 0.30, 0.20], [0.5, 0.5, 0.5],
              [0.75, 0.75, 0.72], [0.05, 0.32, 0.36], [0.72, 0.6, 0.08], [0.3, 0.07, 0.1], [0.1, 0.1, 0.13]];
  function container(mb, x, y, z, len) {
    const c = CC[(R() * CC.length) | 0], k = 0.7 + R() * 0.45;
    mb.material(2, 0.45, 0.3, 0.28).color(c[0] * k, c[1] * k, c[2] * k);
    mb.box(x, y + 1.295, z, len || 12.19, 2.59, 2.44);
  }

  // ------------------------------- quay ------------------------------------
  S.material(1, 0.5, 0, 0).color(0.13, 0.13, 0.13);
  S.quad([-240, Y0, 0], [240, Y0, 0], [240, Y0, 175], [-240, Y0, 175], 480, 175);
  S.material(7, 0.6, 0, 0).color(0.2, 0.2, 0.19);
  S.quad([-240, -10, 0], [240, -10, 0], [240, Y0, 0], [-240, Y0, 0], 480, 12.6);
  S.quad([-240, -10, 0], [-240, -10, 175], [-240, Y0, 175], [-240, Y0, 0], 175, 12.6);
  S.quad([240, -10, 0], [240, -10, 175], [240, Y0, 175], [240, Y0, 0], 175, 12.6);
  S.material(0, 0.5, 0, 0).color(0.5, 0.38, 0.04);
  S.box(0, Y0 + 0.11, 0.3, 480, 0.22, 0.6);
  // rubber fenders
  S.material(0, 0.75, 0, 0).color(0.02, 0.02, 0.02);
  for (let x = -230; x <= 230; x += 11.5) S.cyl([x, 0.1, -0.55], [x, Y0 - 0.15, -0.55], 0.55, 0.55, 10, true);
  // bollards + low edge marker lights
  for (let x = -230; x <= 230; x += 23) {
    S.material(0, 0.4, 0.4, 0).color(0.04, 0.04, 0.04);
    S.cyl([x, Y0, 1.3], [x, Y0 + 0.55, 1.3], 0.28, 0.24, 12, false);
    S.cyl([x, Y0 + 0.55, 1.3], [x, Y0 + 0.78, 1.3], 0.42, 0.34, 12, true);
  }
  for (let x = -126.5; x <= 140; x += 23) {
    S.material(0, 0.4, 0.5, 0).color(0.1, 0.1, 0.1);
    S.cyl([x, Y0, 0.9], [x, Y0 + 0.5, 0.9], 0.06, 0.06, 6, false);
    emissive(S, [0.3, 0.75, 1.0], 22);
    S.cyl([x, Y0 + 0.5, 0.9], [x, Y0 + 0.62, 0.9], 0.09, 0.09, 8, true);
    addLight({ pos: [x, Y0 + 0.7, 0.9], color: [0.3, 0.75, 1.0], intensity: 9, range: 10, vol: 0.9, radius: 0.1 });
  }
  // crane rails
  S.material(0, 0.3, 1, 0).color(0.45, 0.45, 0.47);
  S.box(0, Y0 + 0.05, 4, 480, 0.1, 0.14);
  S.box(0, Y0 + 0.05, 34, 480, 0.1, 0.14);

  // ---------------------------- container yard -----------------------------
  for (const band of [60, 84, 108, 132]) for (let bx = -140; bx <= 205; bx += 42) {
    const maxT = 1 + ((R() * 5) | 0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 6; j++) {
      const tiers = Math.max(0, maxT - ((R() * 3) | 0));
      for (let t = 0; t < tiers; t++) container(S, bx + (i - 1) * 12.6, Y0 + t * 2.59, band + 1.3 + j * 2.6);
    }
  }

  // ------------------------- high-mast floodlights -------------------------
  function mast(x, z, tx, tz, col, inten) {
    S.material(0, 0.4, 0.8, 0).color(0.3, 0.3, 0.32);
    S.cyl([x, Y0, z], [x, Y0 + 36, z], 0.5, 0.22, 10, false);
    S.box(x, Y0 + 0.4, z, 1.6, 0.8, 1.6);
    const top = [x, Y0 + 36, z], dir = V3.norm(V3.sub([tx, Y0, tz], top));
    const side = V3.norm(V3.cross([0, 1, 0], dir)), up2 = V3.cross(dir, side);
    S.beam(V3.add(top, V3.mul(side, -2.6)), V3.add(top, V3.mul(side, 2.6)), 0.25, 0.25);
    for (let i = -2; i <= 2; i++) {
      const c = V3.add(V3.add(top, V3.mul(side, i * 1.05)), [0, -0.45, 0]);
      emissive(S, col, 55);
      S.obox(c, V3.mul(side, 0.38), V3.mul(up2, 0.26), V3.mul(dir, 0.1));
    }
    addLight({ pos: V3.add(top, V3.add(V3.mul(dir, 1.3), [0, -0.5, 0])), dir, color: col, intensity: inten, range: 160,
               outer: 62, inner: 24, vol: 0.3, shadow: true, fixed: true, radius: 0.7 });
  }
  mast(-168, 57, -150, 18, SODIUM, 7000);
  mast(35, 57, 40, 18, SODIUM, 7500);
  mast(170, 57, 160, 18, SODIUM, 7000);

  // ---------------------- wire-strung swaying work lamps -------------------
  const lampMesh = (() => {
    const m = new MeshBuilder();
    m.material(0, 0.5, 0.3, 0).color(0.03, 0.03, 0.03);
    m.cyl([0, 0, 0], [0, -1.3, 0], 0.018, 0.018, 5, false);
    m.material(0, 0.35, 0.6, 0).color(0.04, 0.12, 0.08);
    m.cyl([0, -1.2, 0], [0, -1.3, 0], 0.07, 0.07, 8, true);
    m.cyl([0, -1.28, 0], [0, -1.52, 0], 0.07, 0.40, 14, false);
    emissive(m, TUNG, 70);
    m.sphere([0, -1.56, 0], 0.09, 10);
    return m.build(gl);
  })();
  const poleZ = 40, poleH = 9, sag = 1.2;
  for (let i = 0; i <= 10; i++) {
    const x = -137.5 + i * 25;
    S.material(0, 0.4, 0.7, 0).color(0.12, 0.13, 0.13);
    S.cyl([x, Y0, poleZ], [x, Y0 + poleH, poleZ], 0.13, 0.09, 8, true);
    S.box(x, Y0 + 0.25, poleZ, 0.6, 0.5, 0.6);
    if (i < 10) {
      S.material(0, 0.5, 0.3, 0).color(0.02, 0.02, 0.02);
      S.cable([x, Y0 + poleH - 0.1, poleZ], [x + 25, Y0 + poleH - 0.1, poleZ], sag, 0.022, 10);
      const pivot = [x + 12.5, Y0 + poleH - 0.1 - sag, poleZ];
      const lamp = {
        mesh: lampMesh, model: M4.translate(pivot[0], pivot[1], pivot[2]), emis: 1,
        ax: (R() - 0.5) * 0.3, az: 0, vx: 0, vz: 0, ph: R() * 20, pivot,
        update(t, dt) {
          const w2 = 9.81 / 1.45, c = 0.3, ph = this.ph;
          const g1 = Math.sin(t * 0.23 + ph) * 0.5 + 0.5, g2 = Math.sin(t * 0.61 + ph * 1.7);
          const Fx = 1.1 * (0.25 * g1 + 0.55 * g1 * Math.sin(t * 2.45 + ph * 3.1) + 0.2 * g2);
          const Fz = 0.6 * (0.45 * g2 * Math.sin(t * 2.7 + ph * 2.3) + 0.15 * Math.sin(t * 0.9 + ph));
          this.vx += (-w2 * Math.sin(this.ax) - c * this.vx + Fx) * dt; this.ax += this.vx * dt;
          this.vz += (-w2 * Math.sin(this.az) - c * this.vz + Fz) * dt; this.az += this.vz * dt;
          this.model = M4.mul(M4.translate(pivot[0], pivot[1], pivot[2]), M4.mul(M4.rotZ(this.ax), M4.rotX(this.az)));
        },
      };
      dyn.push(lamp);
      const L = addLight({ pos: [0, -1.6, 0], dir: [0, -1, 0], color: TUNG, intensity: 520, range: 34, outer: 84, inner: 36,
                           vol: 1.2, shadow: true, parent: lamp, radius: 0.22 });
      if (i === 2) { L.flicker = true; lamp.light = L; }
    }
  }

  // ------------------------- ship-to-shore cranes --------------------------
  function crane(cx, zt, hoistLen, withBox) {
    const H = Y0 + 50, zW = 4, zL = 34, lx = 13, zB = zL + 18, zF = -50;
    const blue = [0.06, 0.13, 0.3], white = [0.6, 0.61, 0.6];
    const st = (c, r) => S.material(0, r || 0.4, 0.5, 0).color(c[0], c[1], c[2]);
    S.push(M4.translate(cx, 0, 0));
    st(blue);
    for (const sx of [-lx, lx]) for (const z of [zW, zL]) {
      S.box(sx, Y0 + 0.9, z, 7, 1.3, 1.4);
      S.box(sx, (Y0 + 1.5 + H) / 2, z, 1.7, H - Y0 - 1.5, 1.7);
    }
    for (const z of [zW, zL]) {
      S.box(0, Y0 + 2.6, z, 2 * lx, 1.4, 1.4);
      S.box(0, Y0 + 17, z, 2 * lx, 1.5, 1.5);
      S.box(0, H - 0.8, z, 2 * lx, 1.6, 1.6);
    }
    for (const sx of [-lx, lx]) {
      S.box(sx, Y0 + 17, (zW + zL) / 2, 1.5, 1.5, zL - zW);
      S.box(sx, H - 0.8, (zW + zL) / 2, 1.4, 1.6, zL - zW);
      S.beam([sx, Y0 + 17.5, zL], [sx, H - 1, zW], 1.1, 1.1);
      S.beam([sx, H, zW], [sx * 0.2, H + 27, zW + 2], 1.1, 1.1);
      S.beam([sx, H, zL], [sx * 0.2, H + 27, zW + 2], 0.8, 0.8);
    }
    S.box(0, H + 27, zW + 2, 6.5, 1, 1);
    st(white);
    for (const sx of [-3.6, 3.6]) S.box(sx, H + 1.2, (zB + zF) / 2, 1.1, 2.4, zB - zF);
    for (let z = zF + 1; z <= zB; z += 6.5) S.box(0, H + 2.1, z, 7.2, 0.35, 0.35);
    st(blue);
    for (const sx of [-3.6, 3.6]) {
      const ap = [sx * 0.7, H + 27, zW + 2];
      S.beam(ap, [sx, H + 2.4, -22], 0.3, 0.3);
      S.beam(ap, [sx, H + 2.4, zF + 2], 0.3, 0.3);
      S.beam(ap, [sx, H + 2.4, zB - 2], 0.3, 0.3);
    }
    st(white, 0.5);
    S.box(0, H + 5.6, zL + 7, 9, 5.5, 15);
    emissive(S, WARM, 5);
    S.box(-4.53, H + 5.2, zL + 3, 0.05, 1.2, 1.6);
    // trolley, operator cab
    st([0.7, 0.5, 0.05]);
    S.box(0, H - 0.3, zt, 7.6, 1, 5.5);
    st(white);
    S.box(2.6, H - 2.6, zt + 4.2, 2.4, 2.6, 3.2);
    emissive(S, [0.55, 0.85, 1.0], 5);
    S.box(2.6, H - 2.9, zt + 2.57, 2.0, 1.2, 0.06);
    S.box(2.6, H - 3.93, zt + 3.6, 1.6, 0.06, 1.4);
    // floodlights under the boom
    const fz = [-36, -15, 8, 27];
    fz.forEach((z, i) => {
      const sx = (i & 1) ? 3.6 : -3.6;
      emissive(S, LED, 60);
      S.box(sx, H - 0.12, z, 1.5, 0.22, 0.7);
      addLight({ pos: [cx + sx, H - 0.7, z], dir: [0, -1, z < 0 ? 0.05 : 0], color: LED, intensity: 11000, range: 95,
                 outer: z === 8 ? 40 : 34, inner: 12, vol: 0.55, radius: 0.6, shadow: z === 8, fixed: z === 8 });
    });
    S.pop();
    // aviation warning lights
    const av = [[cx, H + 28.2, zW + 2, 0.0], [cx, H + 3.0, zF, 0.5]];
    for (const a of av) {
      blinker(S, [a[0], a[1], a[2]], RED, 90, a[3] + cx * 0.013, 2.4, 0.3);
      addLight({ pos: [a[0], a[1] + 0.4, a[2]], color: RED, intensity: 260, range: 34, vol: 1.6, blink: [a[3] + cx * 0.013, 2.4], radius: 0.3 });
    }
    // hoist: cables + spreader (+ container) hanging from the trolley, swaying
    const m = new MeshBuilder();
    m.material(0, 0.4, 0.6, 0).color(0.04, 0.04, 0.04);
    for (const sx of [-5.6, 5.6]) for (const sz of [-1, 1]) m.cyl([sx * 0.4, 0, sz], [sx, -hoistLen, sz], 0.035, 0.035, 5, false);
    m.material(0, 0.4, 0.4, 0).color(0.75, 0.55, 0.05);
    m.box(0, -hoistLen - 0.25, 0, 12.4, 0.5, 2.5);
    if (withBox) container(m, 0, -hoistLen - 0.5 - 2.59, 0);
    const pivot = [cx, H - 0.8, zt];
    dyn.push({
      mesh: m.build(gl), model: M4.translate(pivot[0], pivot[1], pivot[2]), emis: 1,
      update(t) {
        const a = (0.03 * Math.sin(t * 0.62 + cx) + 0.01 * Math.sin(t * 1.7)) * (hoistLen / 22);
        const b = 0.018 * Math.sin(t * 0.55 + 1 + cx) * (hoistLen / 22);
        this.model = M4.mul(M4.translate(pivot[0], pivot[1], pivot[2]), M4.mul(M4.rotZ(a), M4.rotX(b)));
      },
    });
  }
  crane(6, -20, 22, true);
  crane(70.5, -17.5, 7, false);

  // ------------------------------- truck -----------------------------------
  function truck(x, z) {
    S.material(0, 0.5, 0.5, 0).color(0.05, 0.05, 0.06);
    S.box(x - 1, Y0 + 1.05, z, 13.4, 0.3, 2.3);
    container(S, x - 1.6, Y0 + 1.2, z);
    S.material(0, 0.35, 0.3, 0).color(0.75, 0.5, 0.04);
    S.box(x + 7.3, Y0 + 2.0, z, 2.3, 2.5, 2.4);
    S.material(0, 0.08, 0, 0).color(0.02, 0.02, 0.03);
    S.box(x + 8.47, Y0 + 2.45, z, 0.05, 1.0, 2.0);
    S.material(0, 0.7, 0, 0).color(0.02, 0.02, 0.02);
    for (const wx of [-6.2, -4.9, 6.4, 8.0]) for (const s of [-1, 1])
      S.cyl([x + wx, Y0 + 0.52, z + s * 0.85], [x + wx, Y0 + 0.52, z + s * 1.2], 0.52, 0.52, 12, true);
    for (const s of [-1, 1]) {
      emissive(S, [1, 0.93, 0.8], 70);
      S.box(x + 8.48, Y0 + 1.0, z + s * 0.85, 0.06, 0.18, 0.3);
      addLight({ pos: [x + 8.75, Y0 + 1.0, z + s * 0.85], dir: [1, -0.07, 0], color: [1, 0.93, 0.8], intensity: 900, range: 65,
                 outer: 24, inner: 8, vol: 0.45, radius: 0.15 });
      emissive(S, RED, 14);
      S.box(x - 7.72, Y0 + 1.15, z + s * 0.95, 0.05, 0.14, 0.3);
    }
    addLight({ pos: [x - 8.2, Y0 + 1.15, z], color: RED, intensity: 14, range: 10, vol: 0.8 });
  }
  truck(4, 19);

  // ------------------------- warehouse + guard shack -----------------------
  {
    const wx0 = -235, wx1 = -170, wz0 = 62, wz1 = 150, wh = 15;
    S.material(2, 0.5, 0.4, 0.42).color(0.4, 0.43, 0.45);
    S.quad([wx0, Y0, wz0], [wx1, Y0, wz0], [wx1, Y0 + wh, wz0], [wx0, Y0 + wh, wz0], 65, wh);
    S.quad([wx0, Y0, wz1], [wx1, Y0, wz1], [wx1, Y0 + wh, wz1], [wx0, Y0 + wh, wz1], 65, wh);
    S.quad([wx0, Y0, wz0], [wx0, Y0, wz1], [wx0, Y0 + wh, wz1], [wx0, Y0 + wh, wz0], 88, wh);
    const front = (z0, z1, y0, y1) => S.quad([wx1, y0, z0], [wx1, y0, z1], [wx1, y1, z1], [wx1, y1, z0], z1 - z0, y1 - y0);
    front(wz0, 95, Y0, Y0 + wh); front(105, wz1, Y0, Y0 + wh); front(95, 105, Y0 + 8, Y0 + wh);
    S.material(0, 0.5, 0.3, 0).color(0.2, 0.21, 0.22);
    S.quad([wx0, Y0 + wh, wz0], [wx1, Y0 + wh, wz0], [wx1, Y0 + wh, wz1], [wx0, Y0 + wh, wz1], 65, 88);
    S.material(2, 0.45, 0.5, 0.25).color(0.18, 0.2, 0.24);
    S.box(wx1 + 0.1, Y0 + 4, 80, 0.2, 8, 10); S.box(wx1 + 0.1, Y0 + 4, 122, 0.2, 8, 10);
    emissive(S, [1, 0.8, 0.5], 1.3);
    S.quad([wx1 - 22, Y0, 90], [wx1 - 22, Y0, 110], [wx1 - 22, Y0 + 10, 110], [wx1 - 22, Y0 + 10, 90], 20, 10);
    emissive(S, [1, 0.8, 0.5], 0.5);
    S.quad([wx1 - 22, Y0, 90], [wx1, Y0, 90], [wx1, Y0 + 10, 90], [wx1 - 22, Y0 + 10, 90], 22, 10);
    S.quad([wx1 - 22, Y0, 110], [wx1, Y0, 110], [wx1, Y0 + 10, 110], [wx1 - 22, Y0 + 10, 110], 22, 10);
    S.material(0, 0.6, 0, 0).color(0.2, 0.14, 0.08);
    for (let i = 0; i < 9; i++) { const s = 1.2 + R() * 1.4; S.box(wx1 - 6 - R() * 13, Y0 + s / 2, 96.5 + R() * 7, s, s, s); }
    addLight({ pos: [wx1 - 8, Y0 + 7, 100], color: [1, 0.82, 0.55], intensity: 500, range: 18, vol: 0.6 });
    addLight({ pos: [wx1 - 6, Y0 + 7.5, 100], dir: [1, -0.32, 0], color: [1, 0.82, 0.55], intensity: 5200, range: 75, outer: 42, inner: 18, vol: 1.3 });
    for (const z of [80, 122]) {
      emissive(S, FLUO, 30);
      S.box(wx1 + 0.3, Y0 + 10, z, 0.4, 0.25, 1.4);
      addLight({ pos: [wx1 + 0.7, Y0 + 9.8, z], dir: [0.35, -1, 0], color: FLUO, intensity: 520, range: 30, outer: 64, inner: 28, vol: 1.0 });
    }
    // guard shack
    S.material(3, 0.5, 0, 2).color(0.3, 0.32, 0.3);
    S.box(-146, Y0 + 1.6, 45.5, 5.2, 3.2, 2.6);
    S.material(0, 0.4, 0.5, 0).color(0.1, 0.1, 0.11);
    S.box(-146, Y0 + 3.3, 45.5, 6.2, 0.2, 3.6);
    addLight({ pos: [-146, Y0 + 2.2, 43.4], color: TUNG, intensity: 45, range: 13, vol: 0.8 });
  }

  // ------------------------------ dock clutter -----------------------------
  for (let x = -134; x <= 110; x += 2.7) {
    if (((x + 134) / 2.7 | 0) % 9 > 6) continue;
    const orange = R() < 0.18;
    S.material(0, orange ? 0.35 : 0.65, 0, 0).color(orange ? 0.8 : 0.3, orange ? 0.22 : 0.3, orange ? 0.03 : 0.29);
    S.box(x, Y0 + 0.42, 42.7, 2.4, 0.84, 0.5);
  }
  for (let c = 0; c < 9; c++) {
    const bx = -130 + R() * 230, bz = 38.8 + R() * 2.4;
    for (let i = 0; i < 2 + (R() * 3 | 0); i++) {
      const col = [[0.05, 0.15, 0.4], [0.5, 0.08, 0.05], [0.2, 0.2, 0.2], [0.5, 0.4, 0.05]][(R() * 4) | 0];
      S.material(0, 0.4, 0.5, 0).color(col[0], col[1], col[2]);
      const px = bx + (R() - 0.5) * 2, pz = bz + (R() - 0.5) * 1.4;
      S.cyl([px, Y0, pz], [px, Y0 + 0.9, pz], 0.3, 0.3, 10, true);
    }
  }
  // mooring lines (bollard -> hull)
  S.material(0, 0.7, 0, 0).color(0.12, 0.1, 0.07);
  for (const [bx, sx] of [[-80.5, -68], [-57.5, -66], [103.5, 116], [126.5, 118]])
    S.cable([bx, Y0 + 0.62, 1.3], [sx, 9.3, -7.6 - (sx > 100 ? 4 : 0.6)], 1.3, 0.05, 10);

  // -------------------------------- ship -----------------------------------
  const SL = 200, SB = 31, DECK = 9.5, KEEL = -9;
  const shipPos = [25, 0, -22.5];
  const ship = { model: M4.translate(shipPos[0], 0, shipPos[2]), emis: 1 };
  {
    const m = new MeshBuilder();
    const hullPt = (u, v, side) => {
      const y = KEEL + (DECK - KEEL) * v;
      const xs = -SL / 2 + (1 - v) * 6, xb = SL / 2 - (1 - v) * (1 - v) * 7;
      const x = xs + (xb - xs) * u;
      let w = 1;
      if (u > 0.78) { const t = (u - 0.78) / 0.22; w = 1 - Math.pow(t, 1.3 + 1.2 * v); }
      if (u < 0.1) { const t = 1 - u / 0.1; w = 1 - 0.3 * t * t * (1.3 - v); }
      const bil = Math.pow(Math.min(1, v / 0.3), 0.55);
      return [x, y, side * SB / 2 * w * bil, x, y];
    };
    const deckHalf = x => Math.abs(hullPt(clamp((x + SL / 2) / SL, 0, 1), 1, 1)[2]);
    m.material(6, 0.4, 0.3, 0).color(0.05, 0.07, 0.1);
    for (const sd of [-1, 1]) m.grid(60, 12, (u, v) => hullPt(u, v, sd));
    m.grid(1, 12, (a, v) => { const p = hullPt(0, v, -1), q = hullPt(0, v, 1); return [p[0], p[1], p[2] + (q[2] - p[2]) * a, p[0], p[1]]; });
    m.material(0, 0.5, 0.2, 0).color(0.16, 0.06, 0.05);
    m.grid(60, 1, (u, a) => { const p = hullPt(u, 1, -1), q = hullPt(u, 1, 1); return [p[0], DECK, p[2] + (q[2] - p[2]) * a]; });
    // accommodation block, bridge, funnel
    const ax = -SL / 2 + 22;
    m.material(3, 0.5, 0, 1).color(0.36, 0.37, 0.36);
    m.box(ax, DECK + 13, 0, 16, 26, 28);
    m.material(3, 0.5, 0, 0.5).color(0.37, 0.37, 0.36);
    m.box(ax + 1.5, DECK + 27.6, 0, 11, 3.2, 34);
    m.material(0, 0.5, 0.2, 0).color(0.45, 0.45, 0.45);
    m.box(ax + 1.5, DECK + 29.35, 0, 12, 0.3, 35);
    m.cyl([ax, DECK + 29.5, 0], [ax, DECK + 41, 0], 0.4, 0.25, 8, true);
    m.box(ax, DECK + 37, 0, 0.3, 0.3, 9);
    m.box(ax + 0.8, DECK + 34, 0, 0.4, 0.5, 4.5);
    m.material(3, 0.5, 0, 0.35).color(0.34, 0.35, 0.34);
    m.box(-SL / 2 + 7.5, DECK + 5, 0, 9, 10, 22);
    const fx = -SL / 2 + 7.5;
    m.material(0, 0.45, 0.3, 0).color(0.05, 0.1, 0.25);
    m.cyl([fx, DECK + 10, 0], [fx, DECK + 23, 0], 3.4, 2.8, 18, true);
    m.material(0, 0.45, 0.3, 0).color(0.8, 0.32, 0.05);
    m.cyl([fx, DECK + 16.5, 0], [fx, DECK + 19.5, 0], 3.16, 3.02, 18, false);
    addLight({ parent: ship, pos: [fx + 5.5, DECK + 12, 4], dir: [-0.5, 0.75, -0.35], color: WARM, intensity: 900, range: 22, outer: 50, inner: 25, vol: 0.5 });
    // deck floods looking forward over the boxes
    for (const sz of [-9, 9]) {
      emissive(m, WARM, 60);
      m.box(ax + 8.2, DECK + 24, sz, 0.3, 0.5, 1.2);
      addLight({ parent: ship, pos: [ax + 9, DECK + 24, sz], dir: [1, -0.42, 0], color: WARM, intensity: 6000, range: 120, outer: 50, inner: 18, vol: 1.0, radius: 0.5 });
    }
    addLight({ parent: ship, pos: [ax + 2, DECK + 27.5, 19.5], color: WARM, intensity: 120, range: 26, vol: 1.0 });
    // navigation lights
    const nav = [[ax + 3, DECK + 28.6, 17.2, GREEN], [ax + 3, DECK + 28.6, -17.2, RED], [ax, DECK + 41.3, 0, [1, 1, 1]], [SL / 2 - 14, DECK + 13.2, 0, [1, 1, 1]]];
    for (const n of nav) {
      emissive(m, n[3], 80);
      m.sphere([n[0], n[1], n[2]], 0.22, 8);
      addLight({ parent: ship, pos: [n[0], n[1], n[2]], color: n[3], intensity: 55, range: 20, vol: 2.0, radius: 0.2 });
    }
    m.material(0, 0.5, 0.4, 0).color(0.4, 0.4, 0.4);
    m.cyl([SL / 2 - 14, DECK, 0], [SL / 2 - 14, DECK + 13, 0], 0.3, 0.18, 8, true);
    // deck cargo
    let bay = 0;
    for (let bx = -SL / 2 + 42.3; bx < SL / 2 - 22; bx += 12.9, bay++) {
      const hw = Math.min(deckHalf(bx - 6.1), deckHalf(bx + 6.1)) - 1.0;
      const base = bay === 3 ? 2 : 3 + ((R() * 4) | 0);
      for (let r = -5; r <= 5; r++) {
        const z = r * 2.52;
        if (Math.abs(z) + 1.22 > hw) continue;
        let tiers = base - (R() < 0.25 ? 1 : 0);
        if (bay === 3 && Math.abs(z - 2.5) < 4) tiers = 1;
        for (let t = 0; t < tiers; t++) container(m, bx, DECK + 0.5 + t * 2.59, z);
      }
      m.material(0, 0.5, 0.4, 0).color(0.08, 0.08, 0.09);
      const lw = Math.min(hw, 14.5);
      m.box(bx + 6.45, DECK + 4, 0, 0.4, 8, lw * 2);
    }
    ship.mesh = m.build(gl);
    ship.update = function (t) {
      const heave = 0.10 * Math.sin(t * 0.52) + 0.05 * Math.sin(t * 0.83 + 1);
      const roll = 0.010 * Math.sin(t * 0.41 + 0.5) + 0.004 * Math.sin(t * 0.9);
      const pitch = 0.0022 * Math.sin(t * 0.33);
      this.model = M4.mul(M4.translate(shipPos[0], heave, shipPos[2]), M4.mul(M4.rotX(roll), M4.rotZ(pitch)));
    };
    dyn.push(ship);
  }

  // ------------------------------- buoys -----------------------------------
  function buoy(x, z, col, phase) {
    const m = new MeshBuilder();
    m.material(0, 0.4, 0.2, 0).color(col[0] * 0.5, col[1] * 0.35, col[2] * 0.3);
    m.cyl([0, -0.6, 0], [0, 0.5, 0], 1.2, 1.2, 14, true);
    m.material(0, 0.4, 0.6, 0).color(0.1, 0.1, 0.1);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.4; m.cyl([Math.cos(a) * 0.9, 0.5, Math.sin(a) * 0.9], [Math.cos(a) * 0.2, 3.3, Math.sin(a) * 0.2], 0.05, 0.05, 5, false); }
    blinker(m, [0, 3.5, 0], col, 90, phase, 3.2, 0.2);
    const b = {
      mesh: m.build(gl), model: M4.translate(x, 0, z), emis: 1,
      update(t) {
        const h = waveHeight(x, z, t), hx = waveHeight(x + 1, z, t) - waveHeight(x - 1, z, t), hz = waveHeight(x, z + 1, t) - waveHeight(x, z - 1, t);
        this.model = M4.mul(M4.translate(x, h * 0.8, z), M4.mul(M4.rotZ(hx * 0.6), M4.rotX(-hz * 0.6)));
      },
    };
    dyn.push(b);
    addLight({ parent: b, pos: [0, 3.6, 0], color: col, intensity: 150, range: 40, vol: 0.8, blink: [phase, 3.2], radius: 0.25 });
  }
  buoy(-128, -52, GREEN, 0.0);
  buoy(-205, -118, RED, 0.45);

  const world = {
    staticMesh: S.build(gl), dyn, lights, ship, shipPos, shipHalf: [SL / 2 - 12, SB / 2 - 0.5],
    update(t, dt) {
      const steps = Math.max(1, Math.ceil(dt / 0.016));
      for (const o of dyn) {
        if (!o.update) continue;
        if (o.vx !== undefined) for (let s = 0; s < steps; s++) o.update(t - dt + dt * (s + 1) / steps, dt / steps);
        else o.update(t, dt);
      }
      for (const L of lights) {
        if (L.parent) {
          L.pos = M4.point(L.parent.model, L.lpos);
          if (L.ldir) L.dir = M4.dir(L.parent.model, L.ldir);
        }
        L.mod = 1;
        if (L.blink) L.mod = 0.02 + blinkValue(t, L.blink[0], L.blink[1]);
        if (L.flicker) {
          const n = Math.sin(t * 37.0) + Math.sin(t * 53.3 + 1.0) + Math.sin(t * 11.7 + 2.0) + 1.4 * Math.sin(t * 0.7);
          L.mod = n > 2.1 ? 0.12 : (n > 1.7 ? 0.55 : 1);
          L.parent.emis = L.mod;
        }
      }
    },
  };
  return world;
}
