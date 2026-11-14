import * as THREE from 'three';

/**
 * One GPU particle system = one draw call. Each particle is an instanced quad
 * whose position is computed in the vertex shader from a fixed random seed and
 * the time, so nothing is written per frame on the CPU (no allocations, no
 * buffer uploads). Changing the visible count is just `instanceCount`.
 *
 * Modes:
 *  - rain:    camera-centred box, fall and wrap, streaks stretched along the (wind-slanted) velocity
 *  - flake:   camera-centred box, slow fall with sway, soft round dots (snow)
 *  - petal:   camera-centred box, tumbling two-tone quads (cherry petals, autumn leaves)
 *  - firefly: two fixed places, wandering glow points that pulse (additive)
 */
export type ParticleMode = 'rain' | 'flake' | 'petal' | 'firefly';

const VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCenter;
uniform vec3 uCenter2;
uniform vec3 uBox;
uniform vec3 uVel;
uniform vec2 uSize;
uniform float uSway;
attribute vec4 aSeed;
varying vec2 vUv;
varying float vSeed;
varying float vFade;
void main() {
  vUv = uv;
  vSeed = aSeed.w;
  vec2 corner = position.xy;
  float speed = 0.75 + 0.5 * aSeed.w;
#ifdef FIREFLY
  vec3 c = aSeed.w < 0.5 ? uCenter : uCenter2;
  vec3 p = c + (aSeed.xyz - 0.5) * uBox;
  p += vec3(sin(uTime * 0.31 + aSeed.w * 40.0), sin(uTime * 0.53 + aSeed.x * 30.0) * 0.4, cos(uTime * 0.27 + aSeed.z * 50.0)) * uSway;
  vFade = 1.0;
#else
  vec3 p = aSeed.xyz * uBox + uVel * uTime * speed;
  p.x += sin(uTime * 0.9 + aSeed.w * 31.0) * uSway;
  p.z += cos(uTime * 0.7 + aSeed.w * 17.0) * uSway;
  vec3 origin = uCenter - uBox * 0.5;
  p = mod(p - origin, uBox) + origin;
  vec3 d = abs(p - uCenter) / (uBox * 0.5);
  vFade = (1.0 - smoothstep(0.7, 1.0, max(d.x, d.z))) * (1.0 - smoothstep(0.8, 1.0, d.y));
  // Nothing right in front of the lens (big blurry streaks look like scratches).
  vFade *= smoothstep(1.5, 4.5, distance(p, cameraPosition));
#endif
#ifdef RAIN
  vec3 dir = normalize(uVel);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 right = normalize(cross(dir, toCam));
  vec3 w = p + right * corner.x * uSize.x + dir * corner.y * uSize.y * speed;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
#else
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec2 q = corner * uSize * (0.7 + 0.6 * aSeed.w);
#ifdef PETAL
  float a = uTime * (1.2 + aSeed.w * 2.0) + aSeed.x * 6.28;
  q = vec2(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a));
  q.x *= 0.55 + 0.45 * sin(uTime * 2.3 + aSeed.z * 6.28);
#endif
  mv.xy += q;
  gl_Position = projectionMatrix * mv;
#endif
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uOpacity;
uniform float uBright;
uniform float uTime;
varying vec2 vUv;
varying float vSeed;
varying float vFade;
void main() {
  vec2 c = vUv - 0.5;
  float a;
  vec3 col = uColor;
#if defined(RAIN)
  a = (1.0 - smoothstep(0.0, 0.5, abs(c.x))) * smoothstep(-0.5, 0.2, c.y);
#elif defined(FLAKE)
  a = smoothstep(0.5, 0.15, length(c));
#elif defined(PETAL)
  a = smoothstep(0.5, 0.42, length(c * vec2(1.0, 1.6)));
  col = mix(uColor, uColor2, vSeed);
#else
  float r = length(c);
  a = smoothstep(0.5, 0.0, r);
  a = a * a * (0.35 + 0.65 * max(0.0, sin(uTime * (1.5 + vSeed) + vSeed * 40.0)));
#endif
  a *= uOpacity * vFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col * uBright, a);
  #include <colorspace_fragment>
}
`;

export interface ParticleOptions {
  mode: ParticleMode;
  max: number;
  box: [number, number, number];
  size: [number, number];
  color: number;
  color2?: number;
  opacity: number;
  seed?: number;
}

export class Particles {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly max: number;
  readonly uniforms: {
    uTime: { value: number };
    uCenter: { value: THREE.Vector3 };
    uCenter2: { value: THREE.Vector3 };
    uBox: { value: THREE.Vector3 };
    uVel: { value: THREE.Vector3 };
    uSize: { value: THREE.Vector2 };
    uSway: { value: number };
    uColor: { value: THREE.Color };
    uColor2: { value: THREE.Color };
    uOpacity: { value: number };
    uBright: { value: number };
  };

  constructor(o: ParticleOptions) {
    this.max = o.max;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    // Deterministic seeds (no Math.random): the same pattern on every visit.
    const seeds = new Float32Array(o.max * 4);
    let s = (o.seed ?? 1) * 2654435761;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < seeds.length; i++) seeds[i] = rnd();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = 0;
    this.uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uCenter2: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(...o.box) },
      uVel: { value: new THREE.Vector3(0, -1, 0) },
      uSize: { value: new THREE.Vector2(...o.size) },
      uSway: { value: 0 },
      uColor: { value: new THREE.Color(o.color) },
      uColor2: { value: new THREE.Color(o.color2 ?? o.color) },
      uOpacity: { value: o.opacity },
      uBright: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: { [o.mode.toUpperCase()]: '' },
      transparent: true,
      depthWrite: false,
      blending: o.mode === 'firefly' ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.name = `particles-${o.mode}`;
  }

  get count(): number {
    return this.mesh.visible ? this.mesh.geometry.instanceCount : 0;
  }

  setCount(n: number) {
    const c = Math.max(0, Math.min(this.max, Math.round(n)));
    this.mesh.geometry.instanceCount = c;
    this.mesh.visible = c > 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
