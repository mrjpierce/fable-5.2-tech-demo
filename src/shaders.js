'use strict';
// ---------------------------------------------------------------------------
// All GLSL for the renderer
// ---------------------------------------------------------------------------
// Quality tier. Phones and tablets get a lighter pipeline: fewer simultaneous lights
// (mobile GPUs cap fragment uniforms at ~256 vectors), fewer/smaller shadow maps,
// shorter reflection and scattering loops, fewer rain streaks and a lower pixel budget.
// Override with ?q=mobile or ?q=desktop.
const QUALITY = (() => {
  const ua = navigator.userAgent || '';
  const q = new URLSearchParams(location.search).get('q');
  const detected = !!(navigator.userAgentData && navigator.userAgentData.mobile) ||
    /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);   // iPadOS reports itself as a Mac
  const mobile = q ? q === 'mobile' : detected;
  return mobile
    ? { name: 'mobile', mobile: true, maxLights: 20, shadows: 3, shadowRes: 512, ssrSteps: 26, ssrGrow: 1.19, volSamples: 3, rain: 16000, pixels: 0.65e6 }
    : { name: 'desktop', mobile: false, maxLights: 64, shadows: 8, shadowRes: 1024, ssrSteps: 64, ssrGrow: 1.085, volSamples: 6, rain: 70000, pixels: 2.8e6 };
})();
const MAX_LIGHTS = QUALITY.maxLights;
const NUM_SHADOWS = QUALITY.shadows;
const NUM_WAVES = 8;
const SHADOW_RES = QUALITY.shadowRes;

const GLSL_HDR = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArrayShadow;
`;

const GLSL_COMMON = `
const float PI = 3.14159265;
float sat(float x){ return clamp(x, 0.0, 1.0); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; } return s; }
float fbm3(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++){ s += a * vnoise(p); p = p * 2.07 + vec2(11.3, 5.1); a *= 0.5; } return s; }
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// expanding ring ripples from rain drops; returns a slope offset
vec2 ripples(vec2 p, float t){
  vec2 acc = vec2(0.0);
  for (int l = 0; l < 3; l++){
    float fl = float(l);
    vec2 q = p * (1.5 + fl * 0.85) + fl * vec2(13.7, 7.3);
    vec2 c = floor(q); vec2 f = fract(q) - 0.5;
    float h = hash12(c + fl * 31.0);
    float tt = t * (1.15 + 0.3 * fl) + h * 7.0;
    float cyc = floor(tt), ph = fract(tt);
    vec2 o = (hash22(c + cyc * 1.7 + fl) - 0.5) * 0.4;
    vec2 d = f - o; float r = length(d) + 1e-4; float R = ph * 0.42;
    float w = sin((r - R) * 44.0) * (1.0 - smoothstep(0.0, 0.07, abs(r - R))) * (1.0 - ph) * (1.0 - ph);
    acc += d / r * w;
  }
  return acc;
}
`;

const GLSL_SKY = `
uniform float uTime;
uniform vec4 uFlash;   // xyz = direction of the lightning, w = intensity
vec3 skyColor(vec3 d){
  d.y = abs(d.y);
  float az = atan(d.z, d.x);
  vec3 zen = vec3(0.006, 0.009, 0.014), hor = vec3(0.050, 0.043, 0.042);
  float hz = exp(-d.y * 6.0);
  vec2 cp = d.xz / (d.y + 0.12) * 0.9 + uTime * vec2(0.012, 0.02);
  float cl = fbm(cp);
  vec3 c = mix(zen, hor, hz) * (0.45 + 1.1 * cl);
  c += vec3(0.055, 0.032, 0.012) * hz * smoothstep(-0.3, 0.6, d.z) * (0.4 + cl);
  float fl = uFlash.w * pow(max(dot(d, uFlash.xyz), 0.0), 3.0);
  c += vec3(0.55, 0.65, 1.0) * (fl * (0.25 + 1.6 * cl * cl) + uFlash.w * 0.03);
  // far shore across the water: skyline silhouette + sodium lights
  float seaSide = 1.0 - smoothstep(-0.2, 0.05, d.z);
  float el = d.y;
  float sil = 0.005 + 0.013 * vnoise(vec2(az * 34.0, 1.0)) + 0.012 * step(0.78, vnoise(vec2(az * 95.0, 7.0)));
  if (el < sil) c = mix(c, vec3(0.004, 0.005, 0.007), seaSide * 0.92);
  vec2 g = vec2(az * 240.0, el * 480.0);
  vec2 ci = floor(g), cf = fract(g) - 0.5;
  float h = hash12(ci);
  float on = step(0.74, h) * step(el, sil + 0.003);
  vec2 off = (hash22(ci) - 0.5) * 0.6;
  float glow = exp(-dot(cf - off, cf - off) * 36.0);
  vec3 lc = mix(vec3(1.0, 0.55, 0.2), vec3(0.8, 0.9, 1.0), step(0.85, hash12(ci + 3.0)));
  lc = mix(lc, vec3(1.0, 0.1, 0.05), step(0.95, hash12(ci + 9.0)));
  float tw = 0.7 + 0.3 * sin(uTime * (2.0 + h * 5.0) + h * 40.0);
  c += lc * glow * on * tw * seaSide * 1.3;
  return c;
}
`;

const GLSL_LIGHTS = `
#define MAXL ${MAX_LIGHTS}
#define NSH ${NUM_SHADOWS}
uniform int uNumLights;
uniform vec4 uLPos[MAXL];   // xyz, range
uniform vec4 uLCol[MAXL];   // rgb * intensity, shadow layer (-1 = none)
uniform vec4 uLDir[MAXL];   // spot direction, cos(outer)  (-2 = point light)
uniform vec4 uLExt[MAXL];   // volumetric strength, cos(inner), source radius, 0
uniform mat4 uShadowM[NSH];
uniform highp sampler2DArrayShadow uShadow;
float shadowTap(int layer, vec3 P){
  vec4 sp = uShadowM[layer] * vec4(P, 1.0);
  if (sp.w <= 0.0) return 1.0;
  vec3 s = sp.xyz / sp.w * 0.5 + 0.5;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  return texture(uShadow, vec4(s.xy, float(layer), s.z));
}
float shadowPCF(int layer, vec3 P){
  vec4 sp = uShadowM[layer] * vec4(P, 1.0);
  if (sp.w <= 0.0) return 1.0;
  vec3 s = sp.xyz / sp.w * 0.5 + 0.5;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  float fl = float(layer); float t = 1.3 / ${SHADOW_RES}.0;
  return 0.25 * (texture(uShadow, vec4(s.xy + vec2(-t, -0.4 * t), fl, s.z)) + texture(uShadow, vec4(s.xy + vec2(0.4 * t, -t), fl, s.z))
               + texture(uShadow, vec4(s.xy + vec2(t, 0.4 * t), fl, s.z)) + texture(uShadow, vec4(s.xy + vec2(-0.4 * t, t), fl, s.z)));
}
`;

// fullscreen triangle
const FSQ_VS = `#version 300 es
out vec2 vUV;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ------------------------------- G-buffer ----------------------------------
const GBUF_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec3 aCol;
layout(location=3) in vec4 aMat; layout(location=4) in vec2 aUV;
uniform mat4 uVP, uModel;
out vec3 vWP; out vec3 vN; out vec3 vCol; out vec4 vMat; out vec2 vUV;
void main(){
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWP = wp.xyz; vN = mat3(uModel) * aNrm; vCol = aCol; vMat = aMat; vUV = aUV;
  gl_Position = uVP * wp;
}`;

const GBUF_FS = GLSL_HDR + GLSL_COMMON + `
in vec3 vWP; in vec3 vN; in vec3 vCol; in vec4 vMat; in vec2 vUV;
uniform vec3 uCam; uniform float uTime; uniform float uWet; uniform float uEmisK;
layout(location=0) out vec4 oAlb; layout(location=1) out vec4 oNrm; layout(location=2) out vec4 oEmi;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(uCam - vWP);
  if (dot(N, V) < 0.0) N = -N;
  int id = int(vMat.x + 0.5);
  vec3 alb = vCol; float rough = vMat.y, metal = vMat.z; vec3 emi = vec3(0.0);
  float dist = length(uCam - vWP);
  float rfade = 1.0 - smoothstep(22.0, 70.0, dist);

  if (id == 1) {
    // ---- wet quay apron: concrete, joints, paint, puddles, rain ripples ----
    vec2 p = vWP.xz;
    float n1 = fbm(p * 0.07), n2 = fbm(p * 0.9), n3 = vnoise(p * 14.0);
    alb = mix(vec3(0.085, 0.085, 0.09), vec3(0.17, 0.165, 0.155), n1) * (0.75 + 0.5 * n2) * (0.85 + 0.3 * n3);
    vec2 q = abs(fract(p / 7.0) - 0.5) * 7.0;
    float joint = 1.0 - smoothstep(0.025, 0.07, 3.5 - max(q.x, q.y));
    float tar = smoothstep(0.60, 0.68, fbm(p * 0.35 + 40.0));
    alb = mix(alb, vec3(0.03), tar * 0.7);
    float wear = smoothstep(0.25, 0.6, fbm(p * 1.7 + 9.0));
    float ly = 1.0 - smoothstep(0.10, 0.13, abs(p.y - 2.2));
    ly = max(ly, 1.0 - smoothstep(0.10, 0.13, abs(p.y - 36.4)));
    float hz = step(37.0, p.y) * step(p.y, 38.6) * step(fract((p.x + p.y) / 1.6), 0.45);
    ly = max(ly, hz);
    float lw = (1.0 - smoothstep(0.07, 0.10, abs(p.y - 50.3))) * step(fract(p.x / 9.0), 0.45);
    lw = max(lw, 1.0 - smoothstep(0.07, 0.10, abs(p.y - 46.0)));
    lw = max(lw, 1.0 - smoothstep(0.07, 0.10, abs(p.y - 54.6)));
    alb = mix(alb, vec3(0.72, 0.52, 0.04), ly * wear * 0.9);
    alb = mix(alb, vec3(0.65), lw * wear * 0.85);
    alb *= 1.0 - joint * 0.6;
    float ph = fbm(p * 0.11 + 3.7) * 0.75 + fbm(p * 0.37) * 0.25;
    float puddle = max(smoothstep(0.455, 0.52, ph), joint * 0.8);
    float e = 0.02;
    vec2 g = vec2(vnoise((p + vec2(e, 0.0)) * 9.0) - vnoise((p - vec2(e, 0.0)) * 9.0),
                  vnoise((p + vec2(0.0, e)) * 9.0) - vnoise((p - vec2(0.0, e)) * 9.0));
    vec2 rp = ripples(p, uTime) * rfade;
    float mf = 1.0 - smoothstep(10.0, 45.0, dist);
    vec2 sl = g * 0.14 * (1.0 - puddle) * mf + rp * mix(0.04, 0.2, puddle);
    N = normalize(vec3(sl.x, 1.0, sl.y));
    rough = mix(0.24 + 0.28 * n2, 0.03, puddle);
    alb *= mix(0.55, 0.32, puddle);
    metal = 0.0;
  } else if (id == 2) {
    // ---- corrugated steel (containers, sheds) ----
    vec3 dp1 = dFdx(vWP), dp2 = dFdy(vWP); vec2 du1 = dFdx(vUV), du2 = dFdy(vUV);
    float det = du1.x * du2.y - du2.x * du1.y;
    float per = max(vMat.w, 0.05);
    float phs = vUV.x * 6.2832 / per;
    float keep = 1.0 - smoothstep(0.9, 2.4, fwidth(phs));
    if (abs(det) > 1e-12) {
      vec3 T = normalize((dp1 * du2.y - dp2 * du1.y) * sign(det));
      float tilt = clamp(sin(phs) * 2.5, -1.0, 1.0) * 0.55 * keep;
      N = normalize(N + T * tilt);
    }
    alb *= mix(1.0, 0.8 + 0.2 * clamp(cos(phs) * 2.0 + 0.5, 0.0, 1.0), keep);
    float rn = fbm(vWP.xy * 0.8 + vWP.z * 0.63 + vCol.r * 50.0);
    float rust = smoothstep(0.56, 0.74, rn);
    alb = mix(alb, vec3(0.16, 0.07, 0.035), rust * 0.75);
    rough = mix(rough, 0.8, rust); metal *= 1.0 - rust;
  } else if (id == 3) {
    // ---- facade with lit windows ----
    vec2 cs = vec2(2.6, 3.2); vec2 c = floor(vUV / cs), f = fract(vUV / cs);
    float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.30, f.y) * step(f.y, 0.74);
    if (win > 0.5 && abs(N.y) < 0.5) {
      float h = hash12(c + floor(vCol.r * 91.0));
      float lit = step(1.0 - 0.38 * vMat.w, h);
      vec3 wc = mix(vec3(1.0, 0.70, 0.38), vec3(0.7, 0.88, 1.0), step(0.8, hash12(c + 7.3)));
      float blind = step(hash12(c + 1.9) * 0.6, 1.0 - (f.y - 0.30) / 0.44);
      alb = vec3(0.02); rough = 0.06; metal = 0.0;
      emi = wc * lit * (1.5 + 5.0 * hash12(c + 3.1)) * mix(0.25, 1.0, blind);
    }
  } else if (id == 4) {
    emi = vCol * vMat.w; alb = vec3(0.02); rough = 0.4;
  } else if (id == 8) {
    float f = fract(uTime / max(vUV.y, 0.1) + vUV.x);
    float b = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.25, 0.33, f));
    emi = vCol * vMat.w * (0.02 + b); alb = vec3(0.02); rough = 0.3;
  } else if (id == 6) {
    // ---- ship hull: uv = (x, height above waterline) ----
    float y = vUV.y;
    alb = mix(vec3(0.30, 0.05, 0.04), vCol, smoothstep(1.2, 1.4, y));
    alb = mix(alb, vec3(0.55), (1.0 - smoothstep(0.10, 0.14, abs(y - 1.65))) * 0.8);
    float st = fbm(vec2(vUV.x * 1.5, y * 0.15));
    alb = mix(alb, vec3(0.2, 0.09, 0.04), smoothstep(0.55, 0.8, st) * 0.6);
    alb *= mix(0.45, 1.0, smoothstep(0.0, 1.0, y));
    rough = mix(0.12, 0.38, smoothstep(0.0, 2.5, y));
  } else if (id == 7) {
    // ---- quay wall ----
    float y = vWP.y; float n = fbm(vec2(vWP.x * 0.5, y * 2.0));
    alb = vec3(0.2, 0.195, 0.185) * (0.6 + 0.6 * n);
    float tide = 1.0 - smoothstep(0.6, 1.3 + 0.5 * n, y);
    alb = mix(alb, vec3(0.03, 0.05, 0.025), tide * 0.85);
    rough = mix(0.5, 0.15, tide);
    float j = 1.0 - smoothstep(0.03, 0.07, abs(fract(vWP.x / 6.0) - 0.5) * 6.0);
    alb *= 1.0 - 0.5 * j;
  }

  if (id != 1 && id != 4 && id != 8 && emi == vec3(0.0)) {
    // generic rain wetness: darker, glossier, water running down vertical faces
    float up = clamp(N.y, 0.0, 1.0);
    float drip = vnoise(vec2(dot(vWP.xz, vec2(7.0, 5.0)), vWP.y * 0.6 + uTime * 0.4));
    float wetF = uWet * (0.55 + 0.45 * up);
    rough = mix(rough, mix(0.10, 0.30, drip), wetF);
    alb *= mix(1.0, 0.62, wetF * (1.0 - metal));
    if (up > 0.7) {
      vec2 rp = ripples(vWP.xz, uTime) * rfade * 0.12;
      N = normalize(N + vec3(rp.x, 0.0, rp.y));
    }
  }
  oAlb = vec4(alb, rough); oNrm = vec4(N, metal); oEmi = vec4(emi * uEmisK, 1.0);
}`;

// --------------------------------- Sea -------------------------------------
const SEA_VS = `#version 300 es
layout(location=0) in vec2 aPolar;
uniform mat4 uVP; uniform vec3 uCam; uniform float uTime;
uniform vec4 uWave[${NUM_WAVES}]; uniform float uWaveW[${NUM_WAVES}];
out vec3 vWP; out vec2 vXZ;
void main(){
  vec2 xz = uCam.xz + aPolar.x * vec2(cos(aPolar.y), sin(aPolar.y));
  vec3 p = vec3(xz.x, 0.0, xz.y);
  float fade = 1.0 - smoothstep(200.0, 700.0, aPolar.x);
  for (int i = 0; i < ${NUM_WAVES}; i++){
    vec2 d = uWave[i].xy; float k = uWave[i].z, A = uWave[i].w * fade;
    float ph = k * dot(d, xz) - uWaveW[i] * uTime;
    p.xz += d * A * cos(ph); p.y += A * sin(ph);
  }
  vXZ = xz; vWP = p;
  gl_Position = uVP * vec4(p, 1.0);
}`;

const SEA_FS = GLSL_HDR + GLSL_COMMON + `
in vec3 vWP; in vec2 vXZ;
uniform vec3 uCam; uniform float uTime; uniform float uPix;
uniform vec4 uWave[${NUM_WAVES}]; uniform float uWaveW[${NUM_WAVES}];
uniform vec4 uShip;
layout(location=0) out vec4 oAlb; layout(location=1) out vec4 oNrm; layout(location=2) out vec4 oEmi;
void main(){
  vec3 Vv = uCam - vWP; float dist = length(Vv); vec3 V = Vv / dist;
  float fp = dist * uPix / max(abs(V.y), 0.04);      // pixel footprint on the water plane
  vec2 sl = vec2(0.0); float var = 0.0;
  for (int i = 0; i < ${NUM_WAVES}; i++){
    vec2 d = uWave[i].xy; float k = uWave[i].z, A = uWave[i].w;
    float ph = k * dot(d, vXZ) - uWaveW[i] * uTime;
    float keep = 1.0 - smoothstep(0.2, 0.9, fp * k / 6.2832);
    sl += d * (k * A * cos(ph) * keep);
    var += (1.0 - keep) * k * A * k * A * 0.5;
  }
  // wind chop: two scrolling noise layers
  float keepD = 1.0 - smoothstep(0.15, 1.2, fp);
  float e = 0.06;
  vec2 q1 = vXZ * 0.85 + uTime * vec2(0.22, 0.38), q2 = vXZ * 2.4 + uTime * vec2(-0.35, 0.3);
  vec2 g1 = vec2(fbm3(q1 + vec2(e, 0.0)) - fbm3(q1 - vec2(e, 0.0)), fbm3(q1 + vec2(0.0, e)) - fbm3(q1 - vec2(0.0, e))) / (2.0 * e);
  vec2 g2 = vec2(fbm3(q2 + vec2(e, 0.0)) - fbm3(q2 - vec2(e, 0.0)), fbm3(q2 + vec2(0.0, e)) - fbm3(q2 - vec2(0.0, e))) / (2.0 * e);
  sl += (g1 * 0.11 + g2 * 0.06) * keepD;
  var += (1.0 - keepD) * 0.012;
  sl += ripples(vXZ * 0.8, uTime) * 0.22 * (1.0 - smoothstep(12.0, 45.0, dist));
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
  float nv = dot(N, V);
  if (nv < 0.03) N = normalize(N + V * (0.03 - nv));
  // foam along the quay wall and the hull
  float fn = fbm(vXZ * 1.3 + uTime * vec2(0.1, 0.22));
  float foam = (1.0 - smoothstep(0.2, 1.8, -vXZ.y)) * smoothstep(0.34, 0.6, fn);
  vec2 hd = abs(vXZ - uShip.xy) - uShip.zw; float sd = max(hd.x, hd.y);
  foam = max(foam, (1.0 - smoothstep(0.0, 1.6, sd)) * step(-3.0, sd) * smoothstep(0.38, 0.62, fn));
  foam *= 1.0 - smoothstep(60.0, 160.0, dist);
  vec3 alb = mix(vec3(0.010, 0.028, 0.034), vec3(0.42, 0.47, 0.47), foam * 0.6);
  float a0 = 0.045 * 0.045;
  float rough = sqrt(sqrt(a0 * a0 + 2.0 * var));
  rough = mix(rough, 0.5, foam);
  oAlb = vec4(alb, rough); oNrm = vec4(N, 0.0); oEmi = vec4(0.0, 0.0, 0.0, 1.0);
}`;

// -------------------------------- Shadows ----------------------------------
const SHADOW_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP, uModel;
void main(){ gl_Position = uVP * uModel * vec4(aPos, 1.0); }`;
const SHADOW_FS = `#version 300 es
precision highp float;
void main(){}`;

// ---------------------------- Deferred lighting ----------------------------
const LIGHT_FS = GLSL_HDR + GLSL_COMMON + GLSL_SKY + GLSL_LIGHTS + `
in vec2 vUV; out vec4 o;
uniform sampler2D uAlb, uNrm, uEmi, uDepth;
uniform mat4 uInvVP; uniform vec3 uCam;
void main(){
  float z = texture(uDepth, vUV).r;
  vec4 wp = uInvVP * vec4(vec3(vUV, z) * 2.0 - 1.0, 1.0); vec3 P = wp.xyz / wp.w;
  vec3 V = normalize(uCam - P);
  if (z >= 1.0) { o = vec4(skyColor(-V), 1.0); return; }
  vec4 ar = texture(uAlb, vUV), nm = texture(uNrm, vUV);
  vec3 alb = ar.rgb; float rough = clamp(ar.a, 0.02, 1.0), metal = nm.a;
  vec3 N = normalize(nm.xyz);
  float NoV = max(dot(N, V), 1e-3);
  vec3 F0 = mix(vec3(0.04), alb, metal);
  vec3 dif = alb * (1.0 - metal) / PI;
  float a = rough * rough;
  float k = (rough + 1.0); k = k * k / 8.0;
  float gv = NoV * (1.0 - k) + k;
  float rs = rough < 0.26 ? 9.0 : 1.0;      // glossy surfaces mirror far-away lamps
  vec3 acc = vec3(0.0);
  for (int i = 0; i < uNumLights; i++){
    vec4 lp = uLPos[i];
    vec3 Lv = lp.xyz - P; float d2 = dot(Lv, Lv); float r2 = lp.w * lp.w;
    if (d2 > r2 * rs) continue;
    float d = sqrt(d2); vec3 L = Lv / d;
    float NoL = dot(N, L); if (NoL <= 0.0) continue;
    vec4 ld = uLDir[i]; vec4 le = uLExt[i]; float spot = 1.0;
    if (ld.w > -1.5) { spot = smoothstep(ld.w, le.y, dot(-L, ld.xyz)); if (spot <= 0.0) continue; }
    float w1 = min(d2 / r2, 1.0); float winD = 1.0 - w1 * w1; winD *= winD;
    float w2 = d2 / (r2 * rs); float winS = 1.0 - w2 * w2; winS *= winS;
    float sh = 1.0; int layer = int(uLCol[i].w);
    if (layer >= 0) { sh = shadowPCF(layer, P + N * (0.05 + 0.006 * d)); if (sh <= 0.0) continue; }
    vec3 H = normalize(L + V);
    float NoH = sat(dot(N, H)), VoH = sat(dot(V, H));
    float ap = clamp(a + le.z / (2.0 * d), 0.0, 1.0);
    float nrm = a / ap; nrm *= nrm;
    float den = NoH * NoH * (ap * ap - 1.0) + 1.0;
    float D = ap * ap / (PI * den * den) * nrm;
    float vis = 1.0 / (4.0 * (NoL * (1.0 - k) + k) * gv);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
    vec3 spec = min(D * vis, 4000.0) * F;
    acc += uLCol[i].rgb * (spot * sh * NoL / (d2 + 0.3)) * (dif * winD + spec * winS);
  }
  float up = N.y * 0.5 + 0.5;
  vec3 amb = alb * (vec3(0.010, 0.014, 0.020) * (0.35 + 0.65 * up) + vec3(0.010, 0.007, 0.004));
  // lightning: a brief unshadowed key light from the storm cell
  float fl = uFlash.w * (0.25 + 0.75 * max(dot(N, uFlash.xyz), 0.0));
  amb += alb * vec3(0.5, 0.6, 0.9) * fl * 0.5;
  o = vec4(texture(uEmi, vUV).rgb + amb + acc, 1.0);
}`;

// ------------------------ Screen-space reflections -------------------------
const SSR_FS = GLSL_HDR + GLSL_COMMON + GLSL_SKY + `
in vec2 vUV; out vec4 o;
uniform sampler2D uAlb, uNrm, uDepth, uLit;
uniform mat4 uView, uProj, uInvProj; uniform vec2 uNF;
float linZ(float d){ float zn = d * 2.0 - 1.0; return 2.0 * uNF.x * uNF.y / (uNF.y + uNF.x - zn * (uNF.y - uNF.x)); }
float sceneZ(vec2 uv){ return linZ(textureLod(uDepth, uv, 0.0).r); }
void main(){
  float z = texture(uDepth, vUV).r;
  if (z >= 1.0) { o = vec4(0.0); return; }
  vec4 vp = uInvProj * vec4(vec3(vUV, z) * 2.0 - 1.0, 1.0); vec3 P = vp.xyz / vp.w;
  mat3 V3m = mat3(uView);
  vec3 N = normalize(V3m * texture(uNrm, vUV).xyz);
  float rough = texture(uAlb, vUV).a;
  vec3 Vd = normalize(P);
  vec3 R = reflect(Vd, N);
  vec3 Rw = R * V3m;   // transpose(view rotation) * R
  vec3 fallback = skyColor(Rw) * smoothstep(-0.35, 0.05, Rw.y);
  if (rough > 0.62) { o = vec4(fallback, 1.0); return; }
  float depthP = -P.z;
  float jitter = ign(gl_FragCoord.xy);
  float stepLen = max(0.05, depthP * 0.008);
  vec3 O = P + N * (0.015 + depthP * 0.0025);
  float t = stepLen * (0.35 + jitter), tPrev = 0.0;
  bool hit = false; vec2 huv = vec2(0.0);
  for (int i = 0; i < ${QUALITY.ssrSteps}; i++){
    vec3 q = O + R * t;
    if (q.z > -uNF.x) break;
    vec4 c = uProj * vec4(q, 1.0); vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float diff = -q.z - sceneZ(uv);
    if (diff > 0.0 && diff < stepLen * 1.7 + 0.35) {
      float a = tPrev, b = t;
      for (int j = 0; j < 5; j++){
        float m = (a + b) * 0.5; vec3 qm = O + R * m;
        vec4 cm = uProj * vec4(qm, 1.0); vec2 um = cm.xy / cm.w * 0.5 + 0.5;
        if (-qm.z - sceneZ(um) > 0.0) b = m; else a = m;
      }
      vec3 qh = O + R * b; vec4 ch = uProj * vec4(qh, 1.0);
      huv = ch.xy / ch.w * 0.5 + 0.5; hit = true; break;
    }
    tPrev = t; stepLen *= ${QUALITY.ssrGrow.toFixed(3)}; t += stepLen;
  }
  vec3 col = fallback;
  if (hit) {
    vec2 e = smoothstep(vec2(0.0), vec2(0.06), huv) * (1.0 - smoothstep(vec2(0.94), vec2(1.0), huv));
    vec3 hc = min(textureLod(uLit, huv, 0.0).rgb, vec3(60.0));
    col = mix(fallback, hc, e.x * e.y);
  }
  o = vec4(col, 1.0);
}`;

// -------------------- Volumetric light scattering (half res) ---------------
const VOL_FS = GLSL_HDR + GLSL_COMMON + GLSL_LIGHTS + `
in vec2 vUV; out vec4 o;
uniform sampler2D uDepth; uniform mat4 uInvVP; uniform vec3 uCam;
uniform float uScatter, uExt, uDockY;
#define NS ${QUALITY.volSamples}
void main(){
  float z = texture(uDepth, vUV).r;
  vec4 wp = uInvVP * vec4(vec3(vUV, min(z, 0.99999)) * 2.0 - 1.0, 1.0); vec3 P = wp.xyz / wp.w;
  vec3 rd = P - uCam; float tmax = length(rd); rd /= tmax; tmax = min(tmax, 600.0);
  float jit = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < uNumLights; i++){
    vec4 le = uLExt[i]; if (le.x <= 0.0) continue;
    vec4 lp = uLPos[i];
    vec3 toL = lp.xyz - uCam; float r2 = lp.w * lp.w;
    float delta = dot(toL, rd); float D2 = dot(toL, toL) - delta * delta;
    if (D2 >= r2) continue;
    float h = sqrt(r2 - D2);
    float a = max(-delta, -h), b = min(tmax - delta, h);
    if (a >= b) continue;
    float D = max(sqrt(max(D2, 0.0)), 0.3);
    float thA = atan(a / D), thB = atan(b / D);
    vec4 ld = uLDir[i]; int layer = int(uLCol[i].w);
    float sum = 0.0;
    float j0 = fract(jit + float(i) * 0.618);
    for (int k = 0; k < NS; k++){
      float u = (float(k) + j0) / float(NS);
      float s = D * tan(mix(thA, thB, u));
      float tt = delta + s;
      vec3 p = uCam + rd * tt;
      vec3 Lv = lp.xyz - p; float d2 = dot(Lv, Lv); vec3 L = Lv * inversesqrt(d2 + 1e-6);
      float w = min(d2 / r2, 1.0); float f = 1.0 - w * w; f *= f;
      if (ld.w > -1.5) f *= smoothstep(ld.w, le.y, dot(-L, ld.xyz));
      if (f <= 0.0) continue;
      if (layer >= 0) f *= shadowTap(layer, p);
      float cs = dot(L, rd);
      float g = 0.55; float phase = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * cs, 1.5));
      phase = phase * 0.8 + 0.2 / (4.0 * PI);
      float dens = 1.0 + 1.6 * exp(-max(p.y - uDockY, 0.0) * 0.45);
      sum += f * phase * dens * exp(-uExt * tt);
    }
    acc += uLCol[i].rgb * (le.x * sum * (thB - thA) / (D * float(NS)));
  }
  o = vec4(acc * uScatter, 1.0);
}`;

const BLUR_FS = GLSL_HDR + `
in vec2 vUV; out vec4 o; uniform sampler2D uTex; uniform vec2 uDir;
void main(){
  vec3 c = texture(uTex, vUV).rgb * 0.227;
  c += (texture(uTex, vUV + uDir * 1.385).rgb + texture(uTex, vUV - uDir * 1.385).rgb) * 0.316;
  c += (texture(uTex, vUV + uDir * 3.231).rgb + texture(uTex, vUV - uDir * 3.231).rgb) * 0.0703;
  o = vec4(c, 1.0);
}`;

// ---------------- Composite: lit + reflections + fog + volumetrics ----------
const COMP_FS = GLSL_HDR + GLSL_COMMON + `
in vec2 vUV; out vec4 o;
uniform sampler2D uAlb, uNrm, uDepth, uLit, uSSR, uVol;
uniform mat4 uInvVP; uniform vec3 uCam; uniform float uFog; uniform vec3 uFogCol;
vec3 envBRDF(vec3 F0, float rough, float NoV){
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022); const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1; float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw; return F0 * AB.x + AB.y;
}
void main(){
  float z = texture(uDepth, vUV).r;
  vec3 c = texture(uLit, vUV).rgb;
  if (z < 1.0) {
    vec4 wp = uInvVP * vec4(vec3(vUV, z) * 2.0 - 1.0, 1.0); vec3 P = wp.xyz / wp.w;
    vec3 Vv = uCam - P; float dist = length(Vv); vec3 V = Vv / dist;
    vec4 ar = texture(uAlb, vUV), nm = texture(uNrm, vUV);
    vec3 N = normalize(nm.xyz); float NoV = max(dot(N, V), 0.0);
    vec3 F0 = mix(vec3(0.04), ar.rgb, nm.a);
    float lod = clamp(ar.a * 7.5 - 0.2, 0.0, 6.0);
    vec3 refl = textureLod(uSSR, vUV, lod).rgb;
    c += refl * envBRDF(F0, ar.a, NoV);
    c = mix(uFogCol, c, exp(-dist * uFog));
  }
  c += texture(uVol, vUV).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  o = vec4(max(c, 0.0), 1.0);
}`;

// ---------------------------------- Rain -----------------------------------
const RAIN_VS = GLSL_HDR + GLSL_LIGHTS + `
layout(location=0) in vec4 aSeed;
uniform mat4 uVP; uniform vec3 uCam; uniform float uTime; uniform vec3 uBox; uniform vec3 uVel;
uniform vec2 uRes; uniform float uPxScale; uniform float uGain;
out vec3 vCol; out vec2 vQ;
void main(){
  vec3 vel = uVel * (0.8 + 0.4 * aSeed.w);
  vel.xz += (fract(aSeed.wx * 7.13) - 0.5) * 1.2;
  vec3 local = mod(aSeed.xyz * uBox + vel * uTime - uCam, uBox) - uBox * 0.5;
  vec3 head = uCam + local;
  vec3 tail = head - vel * 0.032;
  vec4 c0 = uVP * vec4(head, 1.0), c1 = uVP * vec4(tail, 1.0);
  float end = float(gl_VertexID >> 1), side = float(gl_VertexID & 1) * 2.0 - 1.0;
  vec2 s0 = c0.xy / max(c0.w, 1e-3), s1 = c1.xy / max(c1.w, 1e-3);
  vec2 dir = (s1 - s0) * uRes; float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = max(c0.w, 1e-3);
  float raw = 0.0045 * uPxScale / w;
  float px = clamp(raw, 0.75, 2.5);
  float alpha = min(raw / px, 1.0) * smoothstep(0.6, 2.5, w);
  vec4 c = mix(c0, c1, end);
  c.xy += nrm * side * px * 2.0 / uRes * c.w;
  if (c0.w < 0.2 || c1.w < 0.2) c = vec4(2.0, 2.0, 2.0, 1.0);
  gl_Position = c;
  vQ = vec2(side, end);
  // light the drop: forward-scattering phase, shadowed where the lamp is shadowed
  vec3 rd = normalize(head - uCam);
  vec3 acc = vec3(0.008, 0.010, 0.013);
  for (int i = 0; i < uNumLights; i++){
    vec4 lp = uLPos[i];
    vec3 Lv = lp.xyz - head; float d2 = dot(Lv, Lv); float r2 = lp.w * lp.w;
    if (d2 > r2) continue;
    vec3 L = Lv * inversesqrt(d2 + 1e-6);
    float wn = d2 / r2; float f = 1.0 - wn * wn; f *= f / (d2 + 1.0);
    vec4 ld = uLDir[i];
    if (ld.w > -1.5) f *= smoothstep(ld.w, uLExt[i].y, dot(-L, ld.xyz));
    if (f <= 0.0) continue;
    int layer = int(uLCol[i].w);
    if (layer >= 0) f *= shadowTap(layer, head);
    float cs = dot(L, rd);
    float phase = 0.22 + 1.8 * pow(max(cs, 0.0), 6.0) + 0.3 * pow(max(-cs, 0.0), 2.0);
    acc += uLCol[i].rgb * f * phase;
  }
  vCol = acc * alpha * uGain;
}`;
const RAIN_FS = GLSL_HDR + `
in vec3 vCol; in vec2 vQ; out vec4 o;
void main(){
  float a = (1.0 - vQ.x * vQ.x) * sin(vQ.y * 3.14159);
  o = vec4(vCol * a, 1.0);
}`;

// --------------------------------- Bloom -----------------------------------
const BLOOM_DOWN_FS = GLSL_HDR + `
in vec2 vUV; out vec4 o; uniform sampler2D uTex; uniform vec2 uPx; uniform float uFirst;
vec3 pre(vec3 c){
  if (uFirst < 0.5) return c;
  c = min(c, vec3(120.0));
  float l = max(c.r, max(c.g, c.b));
  return c * (max(l - 0.9, 0.0) / max(l, 1e-4) + 0.035);
}
void main(){
  vec3 c = pre(texture(uTex, vUV).rgb) * 4.0;
  c += pre(texture(uTex, vUV + uPx * vec2(-1, -1)).rgb) + pre(texture(uTex, vUV + uPx * vec2(1, -1)).rgb)
     + pre(texture(uTex, vUV + uPx * vec2(-1, 1)).rgb) + pre(texture(uTex, vUV + uPx * vec2(1, 1)).rgb);
  o = vec4(c / 8.0, 1.0);
}`;
const BLOOM_UP_FS = GLSL_HDR + `
in vec2 vUV; out vec4 o; uniform sampler2D uTex, uBase; uniform vec2 uPx; uniform float uMix;
void main(){
  vec3 c = texture(uTex, vUV + uPx * vec2(-2, 0)).rgb + texture(uTex, vUV + uPx * vec2(2, 0)).rgb
         + texture(uTex, vUV + uPx * vec2(0, -2)).rgb + texture(uTex, vUV + uPx * vec2(0, 2)).rgb;
  c += (texture(uTex, vUV + uPx * vec2(-1, -1)).rgb + texture(uTex, vUV + uPx * vec2(1, -1)).rgb
      + texture(uTex, vUV + uPx * vec2(-1, 1)).rgb + texture(uTex, vUV + uPx * vec2(1, 1)).rgb) * 2.0;
  o = vec4(texture(uBase, vUV).rgb + c / 12.0 * uMix, 1.0);
}`;

// ------------------------- Tonemap / grade / FXAA ---------------------------
const FINAL_FS = GLSL_HDR + `
in vec2 vUV; out vec4 o;
uniform sampler2D uHDR, uBloom; uniform float uExposure, uBloomK, uFade, uTime;
float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main(){
  vec2 d = vUV - 0.5; float r2 = dot(d, d);
  vec2 ca = d * r2 * 0.012;
  vec3 c = vec3(texture(uHDR, vUV + ca).r, texture(uHDR, vUV).g, texture(uHDR, vUV - ca).b);
  c += texture(uBloom, vUV).rgb * uBloomK;
  c *= uExposure * (1.0 - 0.9 * r2 * sqrt(r2) * 2.0);
  c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  c = clamp(c, 0.0, 1.0);
  // grade: cool shadows, warm highlights, a touch of contrast
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(c * vec3(0.90, 1.0, 1.10), c * vec3(1.06, 1.0, 0.94), smoothstep(0.0, 0.6, l));
  c = mix(vec3(l), c, 1.08);
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  c += (h(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * 0.022;
  o = vec4(c * uFade, 1.0);
}`;

const FXAA_FS = GLSL_HDR + `
in vec2 vUV; out vec4 o; uniform sampler2D uTex; uniform vec2 uPx;
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 nw = texture(uTex, vUV + vec2(-1, -1) * uPx).rgb, ne = texture(uTex, vUV + vec2(1, -1) * uPx).rgb;
  vec3 sw = texture(uTex, vUV + vec2(-1, 1) * uPx).rgb, se = texture(uTex, vUV + vec2(1, 1) * uPx).rgb;
  vec3 m = texture(uTex, vUV).rgb;
  float lnw = lum(nw), lne = lum(ne), lsw = lum(sw), lse = lum(se), lm = lum(m);
  float lmin = min(lm, min(min(lnw, lne), min(lsw, lse))), lmax = max(lm, max(max(lnw, lne), max(lsw, lse)));
  vec2 dir = vec2(-((lnw + lne) - (lsw + lse)), (lnw + lsw) - (lne + lse));
  float red = max((lnw + lne + lsw + lse) * 0.03125, 0.0078125);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), -8.0, 8.0) * uPx;
  vec3 a = 0.5 * (texture(uTex, vUV + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uTex, vUV + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uTex, vUV - dir * 0.5).rgb + texture(uTex, vUV + dir * 0.5).rgb);
  float lb = lum(b);
  o = vec4((lb < lmin || lb > lmax) ? a : b, 1.0);
}`;
