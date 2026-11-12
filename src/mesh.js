'use strict';
// ---------------------------------------------------------------------------
// Procedural mesh builder.
// Vertex layout (15 floats): pos3 | normal3 | color3 | mat4(id, rough, metal, param) | uv2
// ---------------------------------------------------------------------------
const VERT_FLOATS = 15;

class MeshBuilder {
  constructor() {
    this.v = []; this.idx = []; this.n = 0;
    this.col = [0.5, 0.5, 0.5];
    this.mat = [0, 0.6, 0, 0];
    this.m = null; this.stack = [];
    this.uvFix = null;
  }
  color(r, g, b) { this.col = [r, g, b]; return this; }
  material(id, rough, metal, param) { this.mat = [id, rough, metal || 0, param || 0]; return this; }
  push(m) { this.stack.push(this.m); this.m = this.m ? M4.mul(this.m, m) : m; return this; }
  pop() { this.m = this.stack.pop(); return this; }

  vert(p, n, u, v) {
    if (this.m) { p = M4.point(this.m, p); n = M4.dir(this.m, n); }
    if (this.uvFix) { u = this.uvFix[0]; v = this.uvFix[1]; }
    const c = this.col, m = this.mat;
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], m[0], m[1], m[2], m[3], u, v);
    return this.n++;
  }
  // a,b,c,d around the quad; uv a(0,0) b(su,0) c(su,sv) d(0,sv)
  quad(a, b, c, d, su, sv) {
    const n = V3.norm(V3.cross(V3.sub(b, a), V3.sub(d, a)));
    const i = this.vert(a, n, 0, 0);
    this.vert(b, n, su, 0); this.vert(c, n, su, sv); this.vert(d, n, 0, sv);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    return this;
  }
  // oriented box from centre and three half-extent vectors
  obox(c, ax, ay, az) {
    const P = (sx, sy, sz) => [c[0] + sx * ax[0] + sy * ay[0] + sz * az[0],
                               c[1] + sx * ax[1] + sy * ay[1] + sz * az[1],
                               c[2] + sx * ax[2] + sy * ay[2] + sz * az[2]];
    const lx = 2 * V3.len(ax), ly = 2 * V3.len(ay), lz = 2 * V3.len(az);
    this.quad(P(1, -1, -1), P(1, -1, 1), P(1, 1, 1), P(1, 1, -1), lz, ly);
    this.quad(P(-1, -1, 1), P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), lz, ly);
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), lx, ly);
    this.quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), lx, ly);
    this.quad(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1), lx, lz);
    this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), lx, lz);
    return this;
  }
  box(cx, cy, cz, sx, sy, sz) {
    return this.obox([cx, cy, cz], [sx / 2, 0, 0], [0, sy / 2, 0], [0, 0, sz / 2]);
  }
  // rectangular beam between two points
  beam(p0, p1, w, h, up) {
    const axis = V3.sub(p1, p0), len = V3.len(axis);
    if (len < 1e-6) return this;
    let side = V3.cross(up || [0, 1, 0], axis);
    if (V3.len(side) < 1e-4 * len) side = V3.cross([1, 0, 0], axis);
    side = V3.norm(side);
    const u2 = V3.norm(V3.cross(axis, side));
    return this.obox(V3.lerp(p0, p1, 0.5), V3.mul(side, w / 2), V3.mul(u2, (h === undefined ? w : h) / 2), V3.mul(axis, 0.5));
  }
  // cylinder / cone between two points
  cyl(p0, p1, r0, r1, seg, cap) {
    const axis = V3.norm(V3.sub(p1, p0)), len = V3.dist(p0, p1);
    let b = V3.cross(axis, Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]);
    b = V3.norm(b);
    const c = V3.cross(axis, b);
    const base = this.n;
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
      const d = [b[0] * cs + c[0] * sn, b[1] * cs + c[1] * sn, b[2] * cs + c[2] * sn];
      const sl = (r0 - r1) / (len || 1);
      const nn = V3.norm([d[0] + axis[0] * sl, d[1] + axis[1] * sl, d[2] + axis[2] * sl]);
      this.vert([p0[0] + d[0] * r0, p0[1] + d[1] * r0, p0[2] + d[2] * r0], nn, i / seg * 6.283 * r0, 0);
      this.vert([p1[0] + d[0] * r1, p1[1] + d[1] * r1, p1[2] + d[2] * r1], nn, i / seg * 6.283 * r0, len);
    }
    for (let i = 0; i < seg; i++) {
      const k = base + i * 2;
      this.idx.push(k, k + 2, k + 3, k, k + 3, k + 1);
    }
    if (cap) {
      for (const [p, r, s] of [[p0, r0, -1], [p1, r1, 1]]) {
        if (r < 1e-4) continue;
        const nn = V3.mul(axis, s);
        const ci = this.vert(p, nn, 0, 0);
        for (let i = 0; i <= seg; i++) {
          const a = i / seg * Math.PI * 2, cs = Math.cos(a), sn = Math.sin(a);
          this.vert([p[0] + (b[0] * cs + c[0] * sn) * r, p[1] + (b[1] * cs + c[1] * sn) * r, p[2] + (b[2] * cs + c[2] * sn) * r], nn, cs * r, sn * r);
        }
        for (let i = 0; i < seg; i++) this.idx.push(ci, ci + 1 + i, ci + 2 + i);
      }
    }
    return this;
  }
  sphere(c, r, seg) {
    const rings = Math.max(3, seg >> 1), base = this.n;
    for (let j = 0; j <= rings; j++) {
      const ph = j / rings * Math.PI, y = Math.cos(ph), s = Math.sin(ph);
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI * 2, n = [Math.cos(a) * s, y, Math.sin(a) * s];
        this.vert([c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r], n, i / seg, j / rings);
      }
    }
    for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
      const k = base + j * (seg + 1) + i;
      this.idx.push(k, k + 1, k + seg + 2, k, k + seg + 2, k + seg + 1);
    }
    return this;
  }
  // parametric surface; fn(u,v) -> [x,y,z,(tu,tv)], smooth normals by finite differences
  grid(nu, nv, fn) {
    const P = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) P.push(fn(i / nu, j / nv));
    const at = (i, j) => P[clamp(j, 0, nv) * (nu + 1) + clamp(i, 0, nu)];
    const base = this.n;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const p = at(i, j);
      const du = V3.sub(at(i + 1, j), at(i - 1, j)), dv = V3.sub(at(i, j + 1), at(i, j - 1));
      this.vert(p, V3.norm(V3.cross(du, dv)), p.length > 3 ? p[3] : i / nu, p.length > 3 ? p[4] : j / nv);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const k = base + j * (nu + 1) + i;
      this.idx.push(k, k + 1, k + nu + 2, k, k + nu + 2, k + nu + 1);
    }
    return this;
  }
  // sagging cable made of thin cylinders
  cable(p0, p1, sag, r, segs) {
    let prev = p0;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs, p = V3.lerp(p0, p1, t);
      p[1] -= sag * (1 - (2 * t - 1) * (2 * t - 1));
      this.cyl(prev, p, r, r, 5, false);
      prev = p;
    }
    return this;
  }

  build(gl) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.v), gl.STATIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(this.idx), gl.STATIC_DRAW);
    const stride = VERT_FLOATS * 4;
    const sizes = [3, 3, 3, 4, 2];
    let off = 0;
    for (let i = 0; i < sizes.length; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, sizes[i], gl.FLOAT, false, stride, off);
      off += sizes[i] * 4;
    }
    gl.bindVertexArray(null);
    return { vao, count: this.idx.length, verts: this.n };
  }
}
