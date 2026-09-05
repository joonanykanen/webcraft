/** GLSL for the voxel materials (fog · vertex light · day/night dimming · AO · water waves). */

export const CHUNK_VERT = /* glsl */ `
uniform float uTime;
attribute vec2 aUV;
attribute float aTile;
attribute vec2 aLight;
attribute float aTint;
varying vec2 vUV;
varying vec2 vLight;
varying float vTint;
varying float vDepth;
varying vec3 vWorld;

void main() {
  vec3 p = position;
  #ifdef WATER
    vec4 wp0 = modelMatrix * vec4(p, 1.0);
    float phase = wp0.x * 0.75 + wp0.z * 0.55 + uTime * 1.7;
    p.y += sin(phase) * 0.055 + sin(phase * 0.5 + 1.7) * 0.02;
  #endif
  vec4 world = modelMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * world;
  gl_Position = projectionMatrix * mv;
  vDepth = -mv.z;
  vWorld = world.xyz;
  float fu = fract(aUV.x) * 0.9375 + 0.03125;
  float fv = aUV.y * 0.9375 + 0.03125;
  vec2 tilePos = vec2(mod(aTile, 8.0), floor(aTile / 8.0));
  vUV = (tilePos + vec2(fu, fv)) / 8.0;
  vLight = aLight;
  vTint = aTint;
}
`;

export const CHUNK_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform float uDayLight;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAlphaTest;
uniform float uOpacity;
uniform float uColorEdge;
uniform float uAmbient;
varying vec2 vUV;
varying vec2 vLight;
varying float vTint;
varying float vDepth;
varying vec3 vWorld;

void main() {
  vec4 tex = texture2D(uMap, vUV);
  if (tex.a < uAlphaTest) discard;
  float sky = vLight.x * uDayLight;
  float level = max(sky, vLight.y);
  float bright = mix(uAmbient, 1.0, level * level * 0.35 + level * 0.65);
  vec3 col = tex.rgb * vTint * bright;
  #ifdef FANCY
    // subtle height-based shading so large flat areas keep some structure
    col *= 0.94 + 0.06 * clamp(vWorld.y / 96.0, 0.0, 1.0);
  #endif
  if (uColorEdge > 0.5) {
    float eu = fract(vUV.x * 8.0);
    float ev = fract(vUV.y * 8.0);
    float edge = min(min(eu, 1.0 - eu), min(ev, 1.0 - ev));
    col *= mix(1.0, 0.66, smoothstep(0.02, 0.005, edge));
  }
  float fog = smoothstep(uFogNear, uFogFar, vDepth);
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col, tex.a * uOpacity);
}
`;

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

export const SKY_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunGlow;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55));
  col = mix(col, uHorizon * 0.72, clamp(-h * 3.2, 0.0, 1.0));
  float s = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(s, 6.0) * uSunGlow * 0.55;
  col += uSunColor * pow(s, 90.0) * uSunGlow;
  gl_FragColor = vec4(col, 1.0);
}
`;
