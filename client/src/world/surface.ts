import * as THREE from 'three';

/**
 * Weather and season looks on the world's own materials, through one shared
 * set of uniforms (Weather drives them): snow settling on upward faces, the
 * darker wet ground, wind sway of tree tops, and seasonal foliage tints.
 * Every patched material keeps its draw calls; only a few shader lines are added.
 */
export const surfaceUniforms = {
  uSnow: { value: 0 },
  uWet: { value: 0 },
  uTime: { value: 0 },
  /** Tree sway amplitude, 0..1. */
  uWind: { value: 0 },
  /** Leaf trees: 0 summer, 1 autumn colours, 2 winter (bare-ish), 3 spring (fresh). Blended by uSeasonAmt. */
  uSeason: { value: 0 },
  uSeasonAmt: { value: 0 },
};

export type SurfaceKind = 'ground' | 'leaf' | 'evergreen' | 'solid';

const COMMON = /* glsl */ `
uniform float uSnow;
uniform float uWet;
uniform float uSeason;
uniform float uSeasonAmt;
varying float vHash;
`;

const FRAG_APPLY = (kind: SurfaceKind) => /* glsl */ `
#include <normal_fragment_maps>
{
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float up = dot(normal, upV);
  ${
    kind === 'leaf'
      ? `
  if (uSeasonAmt > 0.001) {
    vec3 tint = diffuseColor.rgb;
    float l = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
    if (uSeason < 0.5) tint = diffuseColor.rgb;
    else if (uSeason < 1.5) tint = (vHash < 0.33 ? vec3(0.85, 0.36, 0.12) : vHash < 0.66 ? vec3(0.88, 0.62, 0.16) : vec3(0.72, 0.22, 0.14)) * (0.75 + l * 0.9);
    else if (uSeason < 2.5) tint = mix(vec3(l), vec3(0.52, 0.45, 0.36), 0.6) * 1.05;
    else tint = diffuseColor.rgb * vec3(1.05, 1.12, 0.9) + vec3(0.03, 0.05, 0.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, tint, uSeasonAmt);
  }`
      : kind === 'evergreen'
        ? `
  if (uSeason > 1.5 && uSeason < 2.5) diffuseColor.rgb *= 1.0 - 0.12 * uSeasonAmt;`
        : ''
  }
  float snowEdge = ${kind === 'ground' ? '0.55' : '0.35'};
  float snow = uSnow * smoothstep(snowEdge, snowEdge + 0.3, up) * (0.85 + 0.15 * vHash);
  diffuseColor.rgb *= 1.0 - 0.28 * uWet * (1.0 - snow) * ${kind === 'ground' ? '1.0' : '0.6'};
  ${kind === 'ground' ? 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.9, 0.95, 1.05) + vec3(0.0, 0.01, 0.03), uWet * up * 0.5);' : ''}
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.99), clamp(snow, 0.0, 1.0));
}
`;

const VERT_HASH = /* glsl */ `
#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
  vec3 instPos = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]) + position * 0.7;
#endif
  vHash = fract(sin(dot(instPos.xz, vec2(12.9898, 78.233))) * 43758.5453);
`;

const VERT_SWAY = /* glsl */ `
#ifdef USE_INSTANCING
  {
    float ph = instPos.x * 0.37 + instPos.z * 0.23;
    float h = max(position.y + 1.0, 0.0);
    float s = sin(uTime * 1.6 + ph) + 0.4 * sin(uTime * 3.1 + ph * 1.7);
    transformed.x += s * uWind * h * 0.045;
    transformed.z += cos(uTime * 1.3 + ph) * uWind * h * 0.03;
  }
#endif
`;

/** Add the weather look to a world material (idempotent). */
export function patchSurface<T extends THREE.Material>(material: T, kind: SurfaceKind): T {
  if (material.userData.surface) return material;
  material.userData.surface = kind;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, surfaceUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${COMMON}\nuniform float uTime;\nuniform float uWind;`)
      .replace('#include <begin_vertex>', VERT_HASH + (kind === 'leaf' || kind === 'evergreen' ? VERT_SWAY : ''));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON}`)
      .replace('#include <normal_fragment_maps>', FRAG_APPLY(kind));
  };
  material.customProgramCacheKey = () => `surface-${kind}`;
  material.needsUpdate = true;
  return material;
}

/** Interior window panes (골방, 도서관): the weather outside, driven by Weather. */
export const windowUniforms = {
  uTime: { value: 0 },
  uRain: { value: 0 },
  uSnow: { value: 0 },
  uGrey: { value: 0 },
  uFlash: { value: 0 },
};

const WINDOW_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WINDOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uRain;
uniform float uSnow;
uniform float uGrey;
uniform float uFlash;
varying vec2 vUv;
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  vec3 col = uColor;
  float l = dot(col, vec3(0.3, 0.59, 0.11));
  col = mix(col, vec3(l * 0.85), uGrey) * (1.0 - 0.3 * uGrey);
  if (uRain > 0.01) {
    float cols = 26.0;
    float cx = floor(vUv.x * cols);
    float sp = 1.6 + h1(cx) * 1.4;
    float fy = fract(vUv.y * 1.6 + uTime * sp + h1(cx + 7.0));
    float x = abs(fract(vUv.x * cols) - 0.5);
    float streak = smoothstep(0.12, 0.0, x) * smoothstep(0.55, 1.0, fy) * step(0.35, h1(cx + 3.0));
    col = mix(col, vec3(0.9, 0.93, 0.98), streak * 0.85 * uRain);
  }
  if (uSnow > 0.01) {
    vec2 g = vUv * vec2(9.0, 7.0) + vec2(sin(uTime * 0.7 + vUv.y * 5.0) * 0.25, uTime * 0.45);
    vec2 cell = floor(g);
    vec2 jitter = vec2(h1(cell.x + cell.y * 17.0), h1(cell.y + cell.x * 29.0)) - 0.5;
    float d = length(fract(g) - 0.5 - jitter * 0.6);
    col = mix(col, vec3(1.0), smoothstep(0.12, 0.05, d) * uSnow);
  }
  col += vec3(0.6, 0.65, 0.8) * uFlash;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** A pane that shows rain streaks or snow over its sky colour; `color` works like MeshBasicMaterial's. */
export class WeatherWindowMaterial extends THREE.ShaderMaterial {
  readonly color: THREE.Color;
  constructor(color: number) {
    const c = new THREE.Color(color);
    super({ uniforms: { ...windowUniforms, uColor: { value: c } }, vertexShader: WINDOW_VERT, fragmentShader: WINDOW_FRAG });
    this.color = c;
  }
}
