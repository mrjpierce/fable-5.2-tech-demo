'use strict';
// ---------------------------------------------------------------------------
// Thin WebGL2 helpers: programs, textures, framebuffers
// ---------------------------------------------------------------------------
function compileShader(gl, type, src, label) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const lines = src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n');
    console.error('Shader compile error [' + label + ']\n' + log + '\n' + lines);
    throw new Error('Shader compile error [' + label + ']: ' + log);
  }
  return s;
}

class Program {
  constructor(gl, vs, fs, label) {
    this.gl = gl;
    this.label = label;
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs, label + '.vs'));
    gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs, label + '.fs'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      console.error('Link error [' + label + ']: ' + log);
      throw new Error('Link error [' + label + ']: ' + log);
    }
    this.p = p;
    this.locs = {};
  }
  use() { this.gl.useProgram(this.p); return this; }
  loc(n) {
    let l = this.locs[n];
    if (l === undefined) l = this.locs[n] = this.gl.getUniformLocation(this.p, n);
    return l;
  }
  f1(n, x) { this.gl.uniform1f(this.loc(n), x); return this; }
  i1(n, x) { this.gl.uniform1i(this.loc(n), x); return this; }
  f2(n, x, y) { this.gl.uniform2f(this.loc(n), x, y); return this; }
  f3(n, v) { this.gl.uniform3f(this.loc(n), v[0], v[1], v[2]); return this; }
  f4(n, x, y, z, w) { this.gl.uniform4f(this.loc(n), x, y, z, w); return this; }
  v4(n, arr) { this.gl.uniform4fv(this.loc(n), arr); return this; }
  v1(n, arr) { this.gl.uniform1fv(this.loc(n), arr); return this; }
  m4(n, m) { this.gl.uniformMatrix4fv(this.loc(n), false, m); return this; }
  tex(n, unit, tex, target) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target || gl.TEXTURE_2D, tex);
    gl.uniform1i(this.loc(n), unit);
    return this;
  }
}

function makeTex(gl, w, h, ifmt, fmt, type, filter, mips) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  if (mips) {
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  t.w = w; t.h = h;
  return t;
}

function makeFBO(gl, colors, depth) {
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  const bufs = [];
  colors.forEach((c, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, c, 0);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  gl.drawBuffers(bufs);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) console.error('FBO incomplete: 0x' + st.toString(16));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  f.w = colors.length ? colors[0].w : depth.w;
  f.h = colors.length ? colors[0].h : depth.h;
  return f;
}
