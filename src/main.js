'use strict';
// ---------------------------------------------------------------------------
// Renderer: shadow maps -> G-buffer -> deferred lighting -> SSR -> volumetrics
//           -> composite -> rain -> bloom -> tonemap -> FXAA
// ---------------------------------------------------------------------------
(function () {
  const canvas = document.getElementById('c');
  const hudEl = document.getElementById('hud'), errEl = document.getElementById('err'), titleEl = document.getElementById('title');
  function fail(msg) { errEl.style.display = 'flex'; errEl.textContent = msg; throw new Error(msg); }

  // Friendly full-screen notice for devices the renderer can't run on.
  function unsupported(heading, detail) {
    const el = document.getElementById('nosup');
    el.querySelector('h1').textContent = heading;
    el.querySelector('p').textContent = detail;
    el.style.display = 'flex';
    canvas.style.display = hudEl.style.display = titleEl.style.display = 'none';
  }
  const ua = navigator.userAgent || '';
  const isMobile = (navigator.userAgentData && navigator.userAgentData.mobile) ||
    /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);   // iPadOS reports itself as a Mac
  if (isMobile) {
    unsupported('Not available on mobile', 'This demo runs a full deferred renderer with 55 dynamic lights and needs a desktop or laptop GPU. Please open it on a computer.');
    return;
  }

  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  if (!gl) fail('WebGL2 is not available in this browser.');
  if (!gl.getExtension('EXT_color_buffer_float')) fail('EXT_color_buffer_float is required (HDR render targets).');
  gl.getExtension('OES_texture_float_linear');
  // The lighting shader carries every light as uniforms; some GPUs/drivers cap these too low.
  if (gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) < MAX_LIGHTS * 4 + NUM_SHADOWS * 4 + 32) {
    unsupported('Graphics hardware not supported', "This device's GPU does not expose enough shader resources for the demo's lighting. Please try a desktop or laptop with a dedicated or recent integrated GPU.");
    return;
  }

  let P, world, sea;
  try {
    P = {
      gbuf: new Program(gl, GBUF_VS, GBUF_FS, 'gbuf'),
      sea: new Program(gl, SEA_VS, SEA_FS, 'sea'),
      shadow: new Program(gl, SHADOW_VS, SHADOW_FS, 'shadow'),
      light: new Program(gl, FSQ_VS, LIGHT_FS, 'light'),
      ssr: new Program(gl, FSQ_VS, SSR_FS, 'ssr'),
      vol: new Program(gl, FSQ_VS, VOL_FS, 'vol'),
      blur: new Program(gl, FSQ_VS, BLUR_FS, 'blur'),
      comp: new Program(gl, FSQ_VS, COMP_FS, 'comp'),
      rain: new Program(gl, RAIN_VS, RAIN_FS, 'rain'),
      bdown: new Program(gl, FSQ_VS, BLOOM_DOWN_FS, 'bdown'),
      bup: new Program(gl, FSQ_VS, BLOOM_UP_FS, 'bup'),
      final: new Program(gl, FSQ_VS, FINAL_FS, 'final'),
      fxaa: new Program(gl, FSQ_VS, FXAA_FS, 'fxaa'),
    };
    world = buildWorld(gl);
    sea = buildSeaMesh(gl);
  } catch (e) { fail(String(e.message || e)); }

  const emptyVAO = gl.createVertexArray();
  const IDENT = M4.ident();
  const lights = world.lights;
  if (lights.length > MAX_LIGHTS) console.warn('too many lights', lights.length);

  // ---- shadow map array ----
  const shadowTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, shadowTex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT24, SHADOW_RES, SHADOW_RES, NUM_SHADOWS);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  const shadowFbos = [];
  for (let i = 0; i < NUM_SHADOWS; i++) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, shadowTex, 0, i);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    shadowFbos.push(f);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // ---- rain instances ----
  const RAIN_N = 70000;
  const rainVAO = gl.createVertexArray();
  {
    const r = mulberry32(99), seeds = new Float32Array(RAIN_N * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = r();
    gl.bindVertexArray(rainVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
  }

  // ---- wave uniforms ----
  const waveA = new Float32Array(NUM_WAVES * 4), waveW = new Float32Array(NUM_WAVES);
  WAVES.forEach((w, i) => { waveA.set([w.dx, w.dz, w.k, w.amp], i * 4); waveW[i] = w.w; });

  // ---- render targets ----
  let T = null, W = 0, H = 0, scale = 1, autoScale = true;
  const BLOOM_LEVELS = 6;
  function allocTargets() {
    if (T) { T.tex.forEach(t => gl.deleteTexture(t)); T.fbo.forEach(f => gl.deleteFramebuffer(f)); }
    T = { tex: [], fbo: [] };
    const tex = (w, h, ifmt, fmt, type, filter, mips) => { const t = makeTex(gl, w, h, ifmt, fmt, type, filter, mips); T.tex.push(t); return t; };
    const fbo = (c, d) => { const f = makeFBO(gl, c, d); T.fbo.push(f); return f; };
    const hdr = (w, h, mips) => tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR, mips);
    T.alb = tex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    T.nrm = tex(W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    T.emi = tex(W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    T.depth = tex(W, H, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
    T.fG = fbo([T.alb, T.nrm, T.emi], T.depth);
    T.lit = hdr(W, H); T.fLit = fbo([T.lit]);
    T.ssr = hdr(W, H, true); T.fSSR = fbo([T.ssr]);
    const hw = Math.max(2, W >> 1), hh = Math.max(2, H >> 1);
    T.volA = hdr(hw, hh); T.fVolA = fbo([T.volA]);
    T.volB = hdr(hw, hh); T.fVolB = fbo([T.volB]);
    T.hdr = hdr(W, H); T.fComp = fbo([T.hdr]); T.fRain = fbo([T.hdr], T.depth);
    T.down = []; T.up = [];
    let w = W, h = H;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(2, w >> 1); h = Math.max(2, h >> 1);
      const d = hdr(w, h), u = hdr(w, h);
      T.down.push({ t: d, f: fbo([d]), w, h }); T.up.push({ t: u, f: fbo([u]), w, h });
    }
    T.ldr = tex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR); T.fLDR = fbo([T.ldr]);
  }
  function resize(force) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(2, Math.floor(canvas.clientWidth * dpr)), ch = Math.max(2, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; force = true; }
    const cap = Math.min(1, Math.sqrt(2.8e6 / (cw * ch)));
    const w = Math.max(2, Math.floor(cw * scale * cap)), h = Math.max(2, Math.floor(ch * scale * cap));
    if (force || w !== W || h !== H) { W = w; H = h; allocTargets(); }
  }

  // ---- lights -> uniform arrays ----
  const LP = new Float32Array(MAX_LIGHTS * 4), LC = new Float32Array(MAX_LIGHTS * 4), LD = new Float32Array(MAX_LIGHTS * 4), LE = new Float32Array(MAX_LIGHTS * 4);
  const shadowMats = new Float32Array(NUM_SHADOWS * 16);
  let shadowList = [];
  function packLights(camPos) {
    for (const L of lights) L.layer = -1;
    const fixed = lights.filter(L => L.shadow && L.fixed);
    const cands = lights.filter(L => L.shadow && !L.fixed).sort((a, b) => V3.dist(a.pos, camPos) - V3.dist(b.pos, camPos));
    shadowList = fixed.concat(cands).slice(0, NUM_SHADOWS);
    shadowList.forEach((L, i) => {
      L.layer = i;
      const fov = Math.min(2 * L.outer + 6, 140) * DEG;
      const up = Math.abs(L.dir[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
      const view = M4.lookAt(L.pos, V3.add(L.pos, L.dir), up);
      L.vp = M4.mul(M4.perspective(fov, 1, L.fixed ? 1.0 : 0.3, L.range), view);
      shadowMats.set(L.vp, i * 16);
    });
    const n = Math.min(lights.length, MAX_LIGHTS);
    for (let i = 0; i < n; i++) {
      const L = lights[i], k = L.intensity * L.mod, j = i * 4;
      LP[j] = L.pos[0]; LP[j + 1] = L.pos[1]; LP[j + 2] = L.pos[2]; LP[j + 3] = L.range;
      LC[j] = L.color[0] * k; LC[j + 1] = L.color[1] * k; LC[j + 2] = L.color[2] * k; LC[j + 3] = L.layer;
      if (L.dir) { LD[j] = L.dir[0]; LD[j + 1] = L.dir[1]; LD[j + 2] = L.dir[2]; LD[j + 3] = Math.cos(L.outer * DEG); LE[j + 1] = Math.cos(L.inner * DEG); }
      else { LD[j] = 0; LD[j + 1] = -1; LD[j + 2] = 0; LD[j + 3] = -2; LE[j + 1] = 1; }
      LE[j] = L.vol; LE[j + 2] = L.radius; LE[j + 3] = 0;
    }
    return n;
  }
  function setLightUniforms(p, n) {
    p.i1('uNumLights', n).v4('uLPos', LP).v4('uLCol', LC).v4('uLDir', LD).v4('uLExt', LE);
    gl.uniformMatrix4fv(p.loc('uShadowM'), false, shadowMats);
    p.tex('uShadow', 7, shadowTex, gl.TEXTURE_2D_ARRAY);
  }

  function drawScene(p, emis) {
    p.m4('uModel', IDENT);
    if (emis) p.f1('uEmisK', 1);
    gl.bindVertexArray(world.staticMesh.vao);
    gl.drawElements(gl.TRIANGLES, world.staticMesh.count, gl.UNSIGNED_INT, 0);
    for (const o of world.dyn) {
      p.m4('uModel', o.model);
      if (emis) p.f1('uEmisK', o.emis);
      gl.bindVertexArray(o.mesh.vao);
      gl.drawElements(gl.TRIANGLES, o.mesh.count, gl.UNSIGNED_INT, 0);
    }
  }
  function fsq(fboT, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboT);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---- camera ----
  const Y0 = DOCK_Y;
  const shots = [
    { p0: [-58, Y0 + 1.0, 41.7], p1: [-47, Y0 + 1.25, 41.3], t0: [-12, Y0 + 9, 14], t1: [-6, Y0 + 11, 10], fov: 58 },
    { p0: [-152, 1.6, -72], p1: [-136, 2.0, -61], t0: [-20, 15, 12], t1: [-10, 17, 14], fov: 52 },
    { p0: [-123, Y0 + 1.5, 37.2], p1: [-110, Y0 + 1.8, 37.6], t0: [-40, Y0 + 5.6, 40.5], t1: [-30, Y0 + 5.9, 40.8], fov: 44 },
    { p0: [-104, Y0 + 1.7, 2.5], p1: [-91, Y0 + 1.95, 3.1], t0: [10, 11, -15], t1: [12, 14, -14], fov: 50 },
    { p0: [36, Y0 + 1.2, 27], p1: [29, Y0 + 1.5, 25], t0: [6, Y0 + 5, 17], t1: [6, Y0 + 9, 15], fov: 52 },
    { p0: [-98, 50, 98], p1: [-72, 45, 82], t0: [0, 8, 6], t1: [6, 8, 4], fov: 50 },
    { p0: [-88, Y0 + 1.2, 10], p1: [-81, Y0 + 1.45, 6.5], t0: [-52, 26, -20], t1: [-50, 29, -20], fov: 60 },
  ];
  const SHOT_DUR = 17;
  const cam = { mode: 'cine', pos: [0, 10, 40], dir: [0, 0, -1], yaw: 0, pitch: 0, fov: 55, shot: 0, shotT: 0, fade: 1 };
  const keys = {};
  function updateCamera(t, dt) {
    if (cam.mode === 'cine') {
      cam.shotT += dt;
      if (cam.shotT > SHOT_DUR) { cam.shotT = 0; cam.shot = (cam.shot + 1) % shots.length; }
      const s = shots[cam.shot], u = cam.shotT / SHOT_DUR, e = 0.5 * u + 0.5 * smooth(u);
      const tgt = V3.lerp(s.t0, s.t1, e);
      cam.pos = V3.lerp(s.p0, s.p1, e);
      const d = V3.dist(tgt, cam.pos) * 0.006;   // gentle handheld drift
      tgt[0] += d * (Math.sin(t * 0.71) + 0.5 * Math.sin(t * 1.63));
      tgt[1] += d * (Math.sin(t * 0.93 + 2) + 0.5 * Math.sin(t * 1.31));
      cam.pos[1] += 0.02 * Math.sin(t * 1.1);
      cam.dir = V3.norm(V3.sub(tgt, cam.pos));
      cam.fov = s.fov;
      cam.fade = Math.min(1, cam.shotT / 1.4, (SHOT_DUR - cam.shotT) / 1.4);
    } else {
      const sp = (keys.ShiftLeft || keys.ShiftRight ? 32 : 8) * dt;
      cam.dir = [Math.cos(cam.pitch) * Math.cos(cam.yaw), Math.sin(cam.pitch), Math.cos(cam.pitch) * Math.sin(cam.yaw)];
      const right = V3.norm(V3.cross(cam.dir, [0, 1, 0]));
      const mv = (v, k) => { cam.pos = V3.add(cam.pos, V3.mul(v, k)); };
      if (keys.KeyW) mv(cam.dir, sp); if (keys.KeyS) mv(cam.dir, -sp);
      if (keys.KeyD) mv(right, sp); if (keys.KeyA) mv(right, -sp);
      if (keys.KeyE) mv([0, 1, 0], sp); if (keys.KeyQ) mv([0, 1, 0], -sp);
      cam.fade = Math.min(1, cam.fade + dt);
    }
  }
  function goFree() {
    if (cam.mode === 'free') return;
    cam.mode = 'free';
    cam.yaw = Math.atan2(cam.dir[2], cam.dir[0]); cam.pitch = Math.asin(clamp(cam.dir[1], -1, 1));
  }
  let dragging = false;
  canvas.addEventListener('pointerdown', e => { dragging = true; canvas.setPointerCapture(e.pointerId); goFree(); startAudio(); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    cam.yaw += e.movementX * 0.0032; cam.pitch = clamp(cam.pitch - e.movementY * 0.0032, -1.5, 1.5);
  });
  canvas.addEventListener('wheel', e => { goFree(); cam.fov = clamp(cam.fov + Math.sign(e.deltaY) * 3, 18, 95); e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code)) goFree();
    if (e.code === 'KeyC') { cam.mode = 'cine'; cam.shotT = 0; }
    if (e.code === 'KeyH') { hudOn = !hudOn; hudEl.style.opacity = hudOn ? 1 : 0; }
    if (e.code === 'KeyL') triggerFlash();
    if (e.code === 'KeyM') { startAudio(); if (audio) { audio.muted = !audio.muted; audio.master.gain.value = audio.muted ? 0 : 0.8; } }
    if (e.code === 'BracketLeft') { autoScale = false; scale = Math.max(0.4, scale - 0.1); resize(true); }
    if (e.code === 'BracketRight') { autoScale = false; scale = Math.min(1, scale + 0.1); resize(true); }
    if (e.code.startsWith('Digit')) { const n = +e.code.slice(5) - 1; if (n >= 0 && n < shots.length) { cam.mode = 'cine'; cam.shot = n; cam.shotT = 0; } }
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });
  let hudOn = true;

  // ---- lightning ----
  const flash = { t0: -100, dir: [0, 0.5, -0.86], next: 14 };
  function triggerFlash() {
    flash.t0 = time;
    flash.dir = V3.norm([Math.random() * 1.6 - 0.8, 0.35 + Math.random() * 0.3, -1]);
    flash.next = time + 18 + Math.random() * 30;
    if (audio && !audio.muted) thunder(1.2 + Math.random() * 2.5);
  }
  function flashValue(t) {
    const x = t - flash.t0;
    if (x < 0 || x > 1.3) return 0;
    return 2.2 * (Math.exp(-x * 9) * (0.6 + 0.4 * Math.cos(x * 55)) + 0.8 * Math.exp(-Math.pow((x - 0.3) / 0.06, 2)) + 0.4 * Math.exp(-Math.pow((x - 0.47) / 0.04, 2)));
  }

  // ---- procedural audio: rain hiss, patter, harbour rumble, thunder ----
  let audio = null;
  function startAudio() {
    if (audio) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = new AC();
    const buf = ctx.createBuffer(2, ctx.sampleRate * 4, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    master.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 3);
    const layer = (type, freq, q, gain, rate) => {
      const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate || 1;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = gain;
      s.connect(f); f.connect(g); g.connect(master); s.start(0, Math.random() * 3);
      return g;
    };
    layer('highpass', 2500, 0.3, 0.10);
    layer('bandpass', 1100, 0.6, 0.11, 0.8);
    const sea = layer('lowpass', 220, 0.5, 0.5, 0.5);
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.11; lg.gain.value = 0.22;
    lfo.connect(lg); lg.connect(sea.gain); lfo.start();
    audio = { ctx, master, buf, muted: false };
  }
  function thunder(delay) {
    const { ctx, buf, master } = audio, t = ctx.currentTime + delay;
    const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = 0.35;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(60, t + 5);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1.6, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.5, t + 1.2); g.gain.exponentialRampToValueAtTime(0.001, t + 7);
    s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random() * 2); s.stop(t + 7.5);
  }

  // ---- frame ----
  let time = 0, last = 0, frames = 0, ema = 16, cooldown = 120, fpsText = '';
  const NEAR = 0.3, FAR = 8000;
  function render(dt) {
    time += dt;
    resize(false);
    world.update(time, dt);
    updateCamera(time, dt);
    if (time > flash.next) triggerFlash();
    const fl = flashValue(time);

    const camPos = cam.pos, fovR = cam.fov * DEG;
    const view = M4.lookAt(camPos, V3.add(camPos, cam.dir), [0, 1, 0]);
    const proj = M4.perspective(fovR, W / H, NEAR, FAR);
    const VP = M4.mul(proj, view), invVP = M4.invert(VP), invProj = M4.invert(proj);
    const nL = packLights(camPos);

    // 1. shadow maps
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2.0, 4.0);
    P.shadow.use();
    gl.viewport(0, 0, SHADOW_RES, SHADOW_RES);
    for (const L of shadowList) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbos[L.layer]);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      P.shadow.m4('uVP', L.vp);
      drawScene(P.shadow, false);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // 2. G-buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fG);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    P.gbuf.use().m4('uVP', VP).f3('uCam', camPos).f1('uTime', time).f1('uWet', 1);
    drawScene(P.gbuf, true);
    P.sea.use().m4('uVP', VP).f3('uCam', camPos).f1('uTime', time).v4('uWave', waveA).v1('uWaveW', waveW)
      .f1('uPix', 2 * Math.tan(fovR / 2) / H)
      .f4('uShip', world.shipPos[0], world.shipPos[2], world.shipHalf[0], world.shipHalf[1]);
    gl.bindVertexArray(sea.vao);
    gl.drawElements(gl.TRIANGLES, sea.count, gl.UNSIGNED_INT, 0);

    // 3. deferred lighting
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    P.light.use().tex('uAlb', 0, T.alb).tex('uNrm', 1, T.nrm).tex('uEmi', 2, T.emi).tex('uDepth', 3, T.depth)
      .m4('uInvVP', invVP).f3('uCam', camPos).f1('uTime', time).f4('uFlash', flash.dir[0], flash.dir[1], flash.dir[2], fl);
    setLightUniforms(P.light, nL);
    fsq(T.fLit, W, H);

    // 4. screen-space reflections (+ mip chain for roughness)
    P.ssr.use().tex('uAlb', 0, T.alb).tex('uNrm', 1, T.nrm).tex('uDepth', 3, T.depth).tex('uLit', 4, T.lit)
      .m4('uView', view).m4('uProj', proj).m4('uInvProj', invProj).f2('uNF', NEAR, FAR)
      .f1('uTime', time).f4('uFlash', flash.dir[0], flash.dir[1], flash.dir[2], fl);
    fsq(T.fSSR, W, H);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, T.ssr); gl.generateMipmap(gl.TEXTURE_2D);

    // 5. volumetric scattering at half resolution, then blur
    P.vol.use().tex('uDepth', 3, T.depth).m4('uInvVP', invVP).f3('uCam', camPos)
      .f1('uScatter', 0.0030).f1('uExt', 0.003).f1('uDockY', Y0);
    setLightUniforms(P.vol, nL);
    fsq(T.fVolA, T.volA.w, T.volA.h);
    P.blur.use().tex('uTex', 0, T.volA).f2('uDir', 1 / T.volA.w, 0); fsq(T.fVolB, T.volA.w, T.volA.h);
    P.blur.tex('uTex', 0, T.volB).f2('uDir', 0, 1 / T.volA.h); fsq(T.fVolA, T.volA.w, T.volA.h);

    // 6. composite
    P.comp.use().tex('uAlb', 0, T.alb).tex('uNrm', 1, T.nrm).tex('uDepth', 3, T.depth).tex('uLit', 4, T.lit)
      .tex('uSSR', 5, T.ssr).tex('uVol', 6, T.volA).m4('uInvVP', invVP).f3('uCam', camPos).f1('uFog', 0.003)
      .f3('uFogCol', [0.036 + fl * 0.05, 0.036 + fl * 0.06, 0.040 + fl * 0.09]);
    fsq(T.fComp, W, H);

    // 7. rain streaks (additive, depth tested against the scene)
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fRain);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    P.rain.use().m4('uVP', VP).f3('uCam', camPos).f1('uTime', time).f3('uBox', [56, 34, 56]).f3('uVel', [2.6, -9.8, 1.0])
      .f2('uRes', W, H).f1('uPxScale', H * 0.5 * proj[5]).f1('uGain', 0.085);
    setLightUniforms(P.rain, nL);
    gl.bindVertexArray(rainVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, RAIN_N);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);

    // 8. bloom
    P.bdown.use();
    let src = T.hdr, sw = W, sh = H;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const d = T.down[i];
      P.bdown.tex('uTex', 0, src).f2('uPx', 1 / sw, 1 / sh).f1('uFirst', i === 0 ? 1 : 0);
      fsq(d.f, d.w, d.h);
      src = d.t; sw = d.w; sh = d.h;
    }
    P.bup.use();
    let cur = T.down[BLOOM_LEVELS - 1];
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      const u = T.up[i];
      P.bup.tex('uTex', 0, cur.t).tex('uBase', 1, T.down[i].t).f2('uPx', 1 / cur.w, 1 / cur.h).f1('uMix', 0.9);
      fsq(u.f, u.w, u.h);
      cur = u;
    }

    // 9. tonemap + grade, 10. FXAA to screen
    P.final.use().tex('uHDR', 0, T.hdr).tex('uBloom', 1, cur.t).f1('uExposure', 1.0).f1('uBloomK', 0.16).f1('uFade', cam.fade).f1('uTime', time);
    fsq(T.fLDR, W, H);
    P.fxaa.use().tex('uTex', 0, T.ldr).f2('uPx', 1 / W, 1 / H);
    fsq(null, canvas.width, canvas.height);
  }

  function loop(now) {
    const dtRaw = (now - last) / 1000; last = now;
    const dt = clamp(dtRaw, 0.001, 0.05);
    try { render(dt); } catch (e) { fail(String(e.stack || e)); }
    frames++;
    if (dtRaw < 0.12) {
      ema += (dtRaw * 1000 - ema) * 0.05;
      if (autoScale && --cooldown < 0 && ema > 27 && scale > 0.5) { scale = Math.max(0.5, scale * 0.85); cooldown = 90; ema = 18; resize(true); }
    }
    if (frames % 20 === 0) {
      fpsText = (1000 / ema).toFixed(0) + ' fps · ' + W + '×' + H + ' · ' + lights.length + ' lights';
      hudEl.textContent = (cam.mode === 'cine' ? 'CINEMATIC  shot ' + (cam.shot + 1) + '/' + shots.length : 'FREE CAMERA') + '   ' + fpsText +
        '\ndrag look · WASD/QE fly · shift fast · wheel zoom · 1-7 shots · C cinematic · L lightning · M sound · [ ] resolution · H hide';
    }
    if (frames === 300) titleEl.style.opacity = 0;
    requestAnimationFrame(loop);
  }
  resize(true);
  window.__dock = { render, cam, shots, world, gl, get time() { return time; }, set scale(s) { autoScale = false; scale = s; resize(true); } };
  requestAnimationFrame(t => { last = t; requestAnimationFrame(loop); });
})();
