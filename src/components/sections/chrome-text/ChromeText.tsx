"use client";

/* eslint-disable react-hooks/immutability */
// Three.js material uniforms and renderer state are designed to be
// mutated each frame inside useFrame — that's the entire programming
// model. React 19's stricter hook rules (immutability, no setState
// in effect) don't accommodate this pattern. Disabled at file scope.
/**
 * R3F port of Shopify Editions Summer 2025 chrome text effect.
 *
 * Architecture (mirrors the original WordPress vanilla-three port —
 * see `/tmp/old-chrome-scene.ts` or git commit 84641ef for the
 * canonical reference):
 *
 *   1. GPGPU ping-pong simulation (256x128 FBOs) — physics shader
 *      updates each particle's position/velocity using spring forces +
 *      mouse repulsion.
 *   2. **Fixed-size offscreen pipeline** — a useFBO-managed render
 *      target sized to exactly 2680×1168 (regardless of canvas size
 *      or DPR) holds the rasterised discs. Each frame we render
 *      `discScene` into it, then call `KawaseBlurPass.render()`
 *      directly (NOT via an EffectComposer) to blur into the pass's
 *      own internal renderTargetA. The fixed buffer size is what
 *      makes Shopify's exact values (pointSize=5, threshold=0.36,
 *      cutoff=0.6, VERY_LARGE kernel, resolutionScale=0.25) reproduce
 *      Shopify's look. These were extracted from the original Shopify
 *      bundle (`Shopify_2025-JS.js`) — earlier values like pointSize=20
 *      and cutoff=0.72 were a vanilla-port drift, not Shopify's actual
 *      settings.
 *   3. **Chrome plane in main R3F scene** — a textured plane samples
 *      the blurred buffer and runs the chrome matcap shader on it.
 *      The plane handles responsive sizing/positioning.
 *
 * Why NOT postprocessing's `EffectComposer`:
 *   `EffectComposer.setSize(w, h)` calls `renderer.setSize(w, h)`
 *   internally — it would resize the user's canvas to 2680×1168.
 *   Skipping setSize leaves the composer's buffers at canvas-size
 *   (DPR-multiplied), which throws off all the kernel/threshold
 *   tuning. Using KawaseBlurPass standalone lets us own buffer sizes.
 *
 * Why NOT inlining the disc transform into the vertex shader (as my
 * earlier attempt did):
 *   That makes the result look qualitatively wrong — strokes are too
 *   thin, no bulbous chrome volume — because the same kawase kernel
 *   covers a different fraction of a smaller buffer. The fixed-size
 *   offscreen approach is the only way to get the reference look.
 */
import { useEffect, useMemo, useRef } from "react";

import { useFBO, useTexture } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { KawaseBlurPass, KernelSize } from "postprocessing";
import * as THREE from "three";

// ------------------------------------------------------------------ shaders

const simulationVertexShader = /* glsl */ `varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}`;

const simulationFragmentShader = /* glsl */ `uniform sampler2D uParticleState;
uniform sampler2D uInitialState;
uniform vec2 uMouse;
uniform vec2 uMouseVelocity;
uniform float uDeltaTime;
uniform float uInteractionRadius;
uniform float uAspectRatio;

varying vec2 vUv;

const float springConstant = 11.0;
const float damping = 8.0;
const float maxVelocity = 2.1;
const float pushStrength = 37.5;

void main() {
  vec4 particleData = texture2D(uParticleState, vUv);
  vec2 pos = particleData.rg;
  vec2 velocity = particleData.ba;
  vec2 originalPos = texture2D(uInitialState, vUv).rg;
  float distToOriginal = distance(pos.xy, originalPos.xy);

  vec2 mousePos = vec2(uMouse.x, uMouse.y * uAspectRatio * 2.0);
  vec2 dirToMouse = vec2(pos.x, pos.y * uAspectRatio * 2.0) - mousePos;
  float distToMouse = length(dirToMouse);

  float mouseSpeed = length(uMouseVelocity);

  vec2 totalForce = vec2(0.0);
  if (distToMouse < uInteractionRadius) {
    float falloff = smoothstep(0.0, 1.0, 1.0 - distToMouse / uInteractionRadius);
    vec2 pushForce = vec2(0.0);
    if (mouseSpeed > 0.001) {
      pushForce = normalize(uMouseVelocity) * mouseSpeed * pushStrength * falloff;
    }
    totalForce = pushForce;
  }

  vec2 springForce = (originalPos - pos) * springConstant;
  vec2 acceleration = totalForce + springForce;

  float dampingFactor = exp(-damping * uDeltaTime);
  vec2 newVelocity = velocity * dampingFactor + acceleration * uDeltaTime;

  if (length(newVelocity) > maxVelocity) {
    newVelocity = normalize(newVelocity) * maxVelocity;
  }

  vec2 newPos = pos + newVelocity * uDeltaTime;

  if (distToOriginal < 0.05 && length(newVelocity) < 0.05) {
    newPos = mix(pos, originalPos, 0.1);
    newVelocity = vec2(0.0);
  }

  gl_FragColor = vec4(newPos, newVelocity);
}`;

// Disc vertex shader — emits each particle directly into the offscreen
// FBO's clip space. No canvas-aspect math here: the composer has its
// own fixed-size frustum so positions stay decoupled from viewport.
const discVertexShader = /* glsl */ `uniform sampler2D uPositions;
uniform sampler2D uInitialState;

const float pointSize = 5.0;

void main() {
  vec3 pos = texture2D(uPositions, position.xy).xyz;
  vec3 initialPos = texture2D(uInitialState, position.xy).xyz;

  float dist = distance(pos.xy, initialPos.xy);
  float sizeMultiplier = 1.0 + dist * 6.0;

  gl_Position = vec4(pos.xy, 0.0, 1.0);
  gl_PointSize = pointSize * sizeMultiplier;
}`;

const discFragmentShader = /* glsl */ `void main() {
  vec2 uv = gl_PointCoord;
  float dist = distance(uv, vec2(0.5));
  if (dist > 0.5) discard;
  gl_FragColor = vec4(1.0);
}`;

// Chrome plane vertex shader — `modelMatrix * position` only, ignoring
// view/projection. The plane lives directly in clip space, positioned
// & scaled via responsive transforms. Matches Shopify's vertex shader
// exactly (Shopify_2025-JS.js line 4537).
const finalVertexShader = /* glsl */ `varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = modelMatrix * vec4(position, 1.0);
}`;

// Chrome plane fragment shader — verbatim from the working WordPress
// port. Threshold/cutoff/strength values assume the blurred input is
// the fixed-size offscreen FBO from EffectComposer above.
const finalFragmentShader = /* glsl */ `varying vec2 vUv;
uniform sampler2D uBlurredTexture;
uniform sampler2D uMatcap;
uniform float uOpacity;
uniform float uIntroProgress;
uniform float uThreshold;
uniform float uCutoff;

const float matcapRotation = 3.1459;
const float strength = 7.0;
const float offsetStrength = 0.008;

float sampleWithThreshold(vec2 uv) {
  float value = texture2D(uBlurredTexture, uv).r;
  return value > uThreshold ? value : 0.0;
}

const int STEPS = 15;

void main() {
  float normalSample = sampleWithThreshold(vUv);

  if (normalSample <= uCutoff || uOpacity <= 0.0) {
    discard;
    return;
  }

  float stepSize = offsetStrength / float(STEPS);

  float sumDx = 0.0;
  float sumDy = 0.0;
  float weight = 0.0;
  float totalWeight = 0.0;

  for (int i = 1; i <= STEPS; i++) {
    float offset = float(i) * stepSize;
    weight = 1.0 - float(i) / float(STEPS);

    float left   = sampleWithThreshold(vec2(vUv.x - offset, vUv.y));
    float right  = sampleWithThreshold(vec2(vUv.x + offset, vUv.y));
    float top    = sampleWithThreshold(vec2(vUv.x, vUv.y - offset));
    float bottom = sampleWithThreshold(vec2(vUv.x, vUv.y + offset));

    sumDx += (right - left) * weight;
    sumDy += (bottom - top) * weight;
    totalWeight += weight;
  }

  float dx = totalWeight > 0.0 ? sumDx / totalWeight : 0.0;
  float dy = totalWeight > 0.0 ? sumDy / totalWeight : 0.0;

  vec3 normal = normalize(vec3(-dx * strength, -dy * strength, 1.0));

  vec2 matcapUV = normal.xy * 0.5 + 0.5;

  float rotationOffset = 0.0;
  if (uIntroProgress > 0.2) {
    float rotationMask = clamp(vUv.x + 0.55 - uIntroProgress, 0.0, 1.0) * 2.0;
    rotationOffset = (1.0 - uIntroProgress) * 5.0 * rotationMask;
  }

  float s = sin(matcapRotation + rotationOffset);
  float c = cos(matcapRotation + rotationOffset);
  vec2 matcapCenter = vec2(0.5, 0.5);
  vec2 rotatedUV = matcapCenter + mat2(c, -s, s, c) * (matcapUV - matcapCenter);

  vec3 matcapColor = texture2D(uMatcap, rotatedUV).rgb;

  vec3 color = matcapColor;

  float bloomBrightness = 65.0 * uIntroProgress;
  float bloomMask = clamp(vUv.x + 0.2 - uIntroProgress, 0.0, 1.0);
  float bloomFactor = bloomBrightness * bloomMask * bloomMask;

  gl_FragColor = vec4(
    color * 0.95 + vec3(5.0, 5.0, 12.0) * bloomFactor,
    normalSample * uOpacity
  );
}`;

// ------------------------------------------------------------------ helpers

const POSITIONS_URL = "/textures/horizons.png";
const MATCAP_URL = "/textures/matcap_512.png";

// Shopify constants — do NOT change without reading CLAUDE.md tuning notes.
const OFFSCREEN_WIDTH = 1340 * 2;
const OFFSCREEN_HEIGHT = 584 * 2;
const TEXT_ASPECT = OFFSCREEN_HEIGHT / OFFSCREEN_WIDTH;
const SCALE = 2.58;
// Shrinks the WordPress-port-tuned `H * SCALE` by 30% to suit our
// full-viewport hero layout. Hoisted to file scope so the touch
// hit-test (which needs to know where the chrome plane lives in NDC)
// can read the same constant the mesh scale uses.
const SIZE_FACTOR = 0.7;
const GRID_WIDTH = 256;
const GRID_HEIGHT = 128;
const PARTICLE_COUNT = GRID_WIDTH * GRID_HEIGHT;

function extractParticlePositions(
  texture: THREE.Texture,
  count: number
): Float32Array {
  const data = new Float32Array(count * 4);
  const img = texture.image as HTMLImageElement;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2d context");
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const threshold = 200;
  let written = 0;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const idx = (y * canvas.width + x) * 4;
      if (imageData[idx] > threshold && written < count) {
        const i = written * 4;
        data[i + 0] = (x / canvas.width) * 2 - 1;
        data[i + 1] = -((y / canvas.height) * 2 - 1);
        data[i + 2] = 0;
        data[i + 3] = 0;
        written++;
      }
    }
  }
  return data;
}

// Responsive sizing — ported verbatim from the working WordPress
// version's `onWindowResize`. Returns the H scale factor and y-offset
// applied to the chrome plane in the main scene.
function computeResponsive(width: number, height: number) {
  const aspectRatio = width / height;

  let maxSize: number;
  if (width < 768) maxSize = 900;
  else if (width < 1200) maxSize = 1100;
  else if (width < 2000) maxSize = 1400;
  else maxSize = 1100;

  let scale = Math.min(maxSize, width) / width;
  if (width >= 768) scale *= 1.2;

  if (aspectRatio > 1) {
    if (height < 500) scale *= 0.35;
    else if (height < 600) scale *= 0.5;
    else if (height < 700) scale *= 0.6;
    else if (height < 800) scale *= 0.65;
    else if (height < 900) scale *= 0.7;
    else if (height < 1100) scale *= 0.85;
    else if (height < 1200) scale *= 0.9;
  }

  const yOffset = aspectRatio > 1 ? 1 - 2 * 0.434 - 0.35 : 1 - 2 * 0.345 - 0.35;

  return { H: scale, yOffset };
}

// ------------------------------------------------------------------ component

export default function ChromeText() {
  const { gl, size } = useThree();

  const isTouchDevice = useMemo(
    () => typeof window !== "undefined" && "ontouchstart" in window,
    []
  );

  const positionTexture = useTexture(POSITIONS_URL);
  const matcap = useTexture(MATCAP_URL);

  // Two ping-pong FBOs for GPGPU simulation. NearestFilter so particle
  // data isn't smeared between texels.
  const fboOptions = {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    stencilBuffer: false,
    type: THREE.FloatType,
  };
  const simRT1 = useFBO(GRID_WIDTH, GRID_HEIGHT, fboOptions);
  const simRT2 = useFBO(GRID_WIDTH, GRID_HEIGHT, fboOptions);

  const initialStateTexture = useMemo(() => {
    const data = extractParticlePositions(positionTexture, PARTICLE_COUNT);
    const tex = new THREE.DataTexture(
      data,
      GRID_WIDTH,
      GRID_HEIGHT,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    tex.needsUpdate = true;
    return tex;
  }, [positionTexture]);

  // Seed both ping-pong sim targets with the initial state once.
  useEffect(() => {
    const seedScene = new THREE.Scene();
    const seedCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const seedQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: initialStateTexture })
    );
    seedScene.add(seedQuad);

    const prev = gl.getRenderTarget();
    gl.setRenderTarget(simRT1);
    gl.render(seedScene, seedCamera);
    gl.setRenderTarget(simRT2);
    gl.render(seedScene, seedCamera);
    gl.setRenderTarget(prev);

    seedQuad.geometry.dispose();
    (seedQuad.material as THREE.Material).dispose();
  }, [gl, simRT1, simRT2, initialStateTexture]);

  const simulationMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uParticleState: { value: initialStateTexture },
          uInitialState: { value: initialStateTexture },
          uMouse: { value: new THREE.Vector2() },
          uMouseVelocity: { value: new THREE.Vector2() },
          uDeltaTime: { value: 0 },
          uInteractionRadius: { value: isTouchDevice ? 0.075 : 0.065 },
          uAspectRatio: { value: TEXT_ASPECT },
        },
        vertexShader: simulationVertexShader,
        fragmentShader: simulationFragmentShader,
      }),
    [initialStateTexture, isTouchDevice]
  );

  const discMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uPositions: { value: null },
          uInitialState: { value: initialStateTexture },
        },
        vertexShader: discVertexShader,
        fragmentShader: discFragmentShader,
        transparent: false,
        depthTest: false,
      }),
    [initialStateTexture]
  );

  // Points geometry — `position` attribute is the texel coord (0..1)
  // used to sample the simulation texture, NOT a real position.
  const pointsGeometry = useMemo(() => {
    const arr = new Float32Array(PARTICLE_COUNT * 3);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const k = i * 3;
      arr[k + 0] = (i % GRID_WIDTH) / GRID_WIDTH;
      arr[k + 1] = Math.floor(i / GRID_WIDTH) / GRID_HEIGHT;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    return geo;
  }, []);

  // Sim quad scene — rendered manually each frame to ping-pong target.
  const simScene = useMemo(() => {
    const s = new THREE.Scene();
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      simulationMaterial
    );
    mesh.frustumCulled = false;
    s.add(mesh);
    return s;
  }, [simulationMaterial]);

  // Discs scene — rasterised by the offscreen EffectComposer.
  const discScene = useMemo(() => {
    const s = new THREE.Scene();
    const pts = new THREE.Points(pointsGeometry, discMaterial);
    pts.frustumCulled = false;
    s.add(pts);
    return s;
  }, [pointsGeometry, discMaterial]);

  const orthoCamera = useMemo(
    () => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
    []
  );

  // Final chrome material that samples the offscreen blurred buffer.
  // uBlurredTexture is patched in useEffect once the composer exists.
  const finalMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uBlurredTexture: { value: null },
          uMatcap: { value: matcap },
          uOpacity: { value: 1 },
          uIntroProgress: { value: 1.5 },
          uThreshold: { value: 0.36 },
          // 0.6 is Shopify's published value, paired with their LARGE
          // (not VERY_LARGE) kernel below. With less blur halo, 0.65
          // gives a moderate stroke width with hollow letters and
          // clean inter-letter gaps. Tune in 0.05 increments.
          uCutoff: { value: 0.65 },
        },
        vertexShader: finalVertexShader,
        fragmentShader: finalFragmentShader,
        transparent: true,
        depthTest: false,
      }),
    [matcap]
  );

  // Disc FBO (the "input buffer" in Shopify's composer terminology).
  // Holds the raw rasterised particle dots before blur. Sized to
  // Shopify's fixed 2680×1168 — verified against Shopify_2025-JS.js
  // line 4748. Don't canvas-size this; at small viewports the dots
  // become huge relative to FBO and overfill into one blob.
  const discFBO = useFBO(OFFSCREEN_WIDTH, OFFSCREEN_HEIGHT, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    stencilBuffer: false,
    depthBuffer: false,
    type: THREE.UnsignedByteType,
  });

  // Output buffer for the final upscaled blur — what the chrome
  // plane samples. CRITICAL: KawaseBlurPass.render() does its blur
  // iterations at low res (resolutionScale=0.25 → 670×292), then
  // a CopyMaterial pass writes the final result to outputBuffer at
  // whatever size outputBuffer is. We size this at the full disc FBO
  // resolution so the chrome plane samples a high-res upscaled blur.
  // Shopify achieves the same thing via composer.outputBuffer being
  // (o, r)-sized. Sampling the low-res blur target directly leaves
  // visible blocky pixelation under the matcap that reads as letters
  // "merging" into one another.
  const blurOutputFBO = useFBO(OFFSCREEN_WIDTH, OFFSCREEN_HEIGHT, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    stencilBuffer: false,
    depthBuffer: false,
    type: THREE.UnsignedByteType,
  });

  // Standalone KawaseBlurPass. We DON'T put it in an EffectComposer
  // because EffectComposer.setSize would resize the user's canvas.
  //
  // setSize matches Shopify's `composer.setSize(o*R, r*R)` where
  // R = 2 / max(0.5, devicePixelRatio). At DPR=2, R=1 → blur runs
  // at 0.25 * (o, r) = 670×292. At DPR=1, R=2 → 1340×584.
  const blurPass = useMemo(() => {
    const dpr = gl.getPixelRatio();
    const R = 2 / Math.max(0.5, dpr);
    const p = new KawaseBlurPass({
      // Shopify ships VERY_LARGE (4) but with a tighter source PNG
      // than ours. With our denser particle distribution VERY_LARGE
      // produces halos that bridge adjacent letters even after
      // raising cutoff. LARGE (3) keeps the soft chrome look while
      // tightening the inter-letter gaps so r-i, n-s etc. read as
      // separate glyphs. The kernel sequence drops from 7 to 6 blur
      // iterations.
      kernelSize: KernelSize.LARGE,
      resolutionScale: 0.25,
    });
    p.setSize(OFFSCREEN_WIDTH * R, OFFSCREEN_HEIGHT * R);
    return p;
  }, [gl]);

  // Wire the upscaled blur output into the chrome plane material.
  useEffect(() => {
    finalMaterial.uniforms.uBlurredTexture.value = blurOutputFBO.texture;
  }, [blurOutputFBO, finalMaterial]);

  useEffect(() => {
    return () => {
      blurPass.dispose();
      finalMaterial.dispose();
      simulationMaterial.dispose();
      discMaterial.dispose();
      initialStateTexture.dispose();
    };
  }, [
    blurPass,
    finalMaterial,
    simulationMaterial,
    discMaterial,
    initialStateTexture,
  ]);

  // Pointer position + velocity tracker.
  //
  // Stored in **CSS-NDC convention**: top of viewport = -1, bottom = +1.
  // The mouseY math below mirrors Shopify exactly and also matches the
  // OLD WordPress `transformedMouseY` formula in updateParticleSimulation
  // (which used `this.mouse.y - yOffset` with `mouse.y` already flipped
  // to NDC). To keep the math identical to that proven port we ALSO
  // flip Y here, but document carefully why.
  const ndcPointer = useRef(new THREE.Vector2());
  const lastNdcPointer = useRef(new THREE.Vector2());
  const ndcVelocity = useRef(new THREE.Vector2());
  const lastMoveTime = useRef(0);
  const hasReceivedMove = useRef(false);

  // NDC bounds of the chrome plane on the canvas. Touch hit-test uses
  // these to decide whether a gesture should drive the particles
  // (preventDefault, page won't scroll) or be passed through to the
  // browser as a normal scroll. Updated whenever the responsive sizing
  // recomputes; see the useEffect just above the touch handler.
  const textBoundsRef = useRef({ halfW: 1, halfH: 1, centerY: 0 });
  // Whether the current touch gesture started over the text. Set on
  // touchstart, read by touchmove. Avoids re-running the hit-test on
  // every move event and prevents a swipe that started on text from
  // suddenly releasing into a scroll mid-gesture.
  const interceptingTouch = useRef(false);

  useEffect(() => {
    lastMoveTime.current = performance.now();
    const onMove = (cx: number, cy: number) => {
      const now = performance.now();
      const dt = Math.max(now - lastMoveTime.current, 16);

      // Use the canvas's bounding rect, not window — the canvas may
      // not start at viewport top, and using window inflates Y errors
      // proportionally. This matches the old port's
      // `canvas.clientWidth/clientHeight`.
      const rect = gl.domElement.getBoundingClientRect();
      const lx = cx - rect.left;
      const ly = cy - rect.top;
      const nx = (lx / rect.width) * 2 - 1;
      const ny = -((ly / rect.height) * 2 - 1); // NDC: top = +1

      // FIRST move: seed both pointer refs to actual cursor pos and
      // emit zero velocity. Otherwise lastNdcPointer is (0,0) and
      // the first delta computes a huge fake velocity from origin
      // to cursor, kicking particles violently as the canvas mounts
      // — that's the visible "shudder" on load.
      if (!hasReceivedMove.current) {
        hasReceivedMove.current = true;
        ndcPointer.current.set(nx, ny);
        lastNdcPointer.current.set(nx, ny);
        ndcVelocity.current.set(0, 0);
        lastMoveTime.current = now;
        return;
      }

      lastNdcPointer.current.copy(ndcPointer.current);
      ndcPointer.current.set(nx, ny);

      // 150 multiplier matches the old port's velocityScale.
      ndcVelocity.current.set(
        ((nx - lastNdcPointer.current.x) / dt) * 150,
        ((ny - lastNdcPointer.current.y) / dt) * 150
      );
      lastMoveTime.current = now;
    };

    const mouseHandler = (e: MouseEvent) => onMove(e.clientX, e.clientY);

    // Touch handling — only intercept gestures that begin over the
    // text region so the rest of the canvas (empty hero space above /
    // below the text) still scrolls the page normally. Decision is
    // made once on touchstart and locked for the gesture so a swipe
    // that started inside the text can't suddenly release into a
    // scroll mid-stroke.
    const canvas = gl.domElement;

    const isOverText = (cx: number, cy: number) => {
      const rect = canvas.getBoundingClientRect();
      const nx = ((cx - rect.left) / rect.width) * 2 - 1;
      const ny = -(((cy - rect.top) / rect.height) * 2 - 1);
      const { halfW, halfH, centerY } = textBoundsRef.current;
      return Math.abs(nx) <= halfW && Math.abs(ny - centerY) <= halfH;
    };

    const touchstartHandler = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      interceptingTouch.current = isOverText(t.clientX, t.clientY);
      if (interceptingTouch.current) {
        // Seed the pointer so the first move's velocity is meaningful
        // rather than a jump from the previous touch's last position.
        onMove(t.clientX, t.clientY);
      }
    };

    const touchmoveHandler = (e: TouchEvent) => {
      if (!interceptingTouch.current) return;
      const t = e.touches[0];
      if (!t) return;
      e.preventDefault();
      onMove(t.clientX, t.clientY);
    };

    const touchendHandler = () => {
      interceptingTouch.current = false;
    };

    window.addEventListener("mousemove", mouseHandler);
    canvas.addEventListener("touchstart", touchstartHandler, { passive: true });
    canvas.addEventListener("touchmove", touchmoveHandler, { passive: false });
    canvas.addEventListener("touchend", touchendHandler, { passive: true });
    canvas.addEventListener("touchcancel", touchendHandler, { passive: true });
    return () => {
      window.removeEventListener("mousemove", mouseHandler);
      canvas.removeEventListener("touchstart", touchstartHandler);
      canvas.removeEventListener("touchmove", touchmoveHandler);
      canvas.removeEventListener("touchend", touchendHandler);
      canvas.removeEventListener("touchcancel", touchendHandler);
    };
  }, [gl]);

  // Responsive sizing — derived directly from the canvas size on each
  // render. Avoids the previous useState+useEffect pattern, which
  // initialised from window dimensions and then updated to canvas
  // dimensions a frame later. That mismatch caused the chrome plane
  // to physically jump position right after mount — visible as the
  // "shudder" on fade-in.
  const { H, yOffset } = useMemo(
    () => computeResponsive(size.width, size.height),
    [size.width, size.height]
  );

  // Keep the touch hit-test bounds in sync with the responsive sizing.
  // Mirrors the mesh scale calculation below (H * SCALE * SIZE_FACTOR
  // for X, same * canvasAspect * TEXT_ASPECT for Y) — if you change
  // either the mesh scale or SIZE_FACTOR, update this too. A small
  // padding factor on each axis (1.05) makes the touch zone feel
  // slightly more generous than the visible plane.
  useEffect(() => {
    const canvasAspect = size.width / size.height;
    const halfW = H * SCALE * SIZE_FACTOR * 1.05;
    const halfH = H * SCALE * canvasAspect * SIZE_FACTOR * TEXT_ASPECT * 1.05;
    textBoundsRef.current = { halfW, halfH, centerY: yOffset };
  }, [H, yOffset, size.width, size.height]);

  // Ping-pong refs.
  const inputRT = useRef(simRT1);
  const outputRT = useRef(simRT2);

  // Skip the first useFrame call. R3F's clock can report a huge delta
  // on the first tick (time since canvas init, not since last RAF),
  // which makes the spring physics overshoot and visibly shudder
  // before settling. After the first frame, deltas are normal.
  const firstFrameSkipped = useRef(false);

  // Per-frame render loop. Default priority (0) so R3F still
  // auto-renders the main scene after our offscreen passes — that's
  // what draws the chrome plane to the canvas.
  useFrame((state, delta) => {
    if (!firstFrameSkipped.current) {
      firstFrameSkipped.current = true;
      return;
    }
    // Clamp at one 30fps frame. The previous 0.3s clamp let big
    // pauses (tab refocus, slow asset loads) inject huge physics
    // steps that overshoot and shudder.
    const dt = Math.min(delta, 1 / 30);

    // Mouse → simulation-space. From the OLD port:
    //   transformedMouseX = mouse.x / (scale * SCALE)
    //   transformedMouseY = ((mouse.y - yOffset) / scale) * (h/w)
    //                       / (SCALE * TEXT_ASPECT)
    // where mouse is NDC (top = +1), yOffset is the chrome plane's
    // world Y, scale is H, h/w is canvasHeight/canvasWidth.
    const aspectInv = state.size.height / state.size.width;
    const mx = ndcPointer.current.x;
    const my = ndcPointer.current.y;
    const mouseX = mx / (H * SCALE);
    const mouseY = (((my - yOffset) / H) * aspectInv) / (SCALE * TEXT_ASPECT);

    simulationMaterial.uniforms.uMouse.value.set(mouseX, mouseY);
    simulationMaterial.uniforms.uMouseVelocity.value.set(
      ndcVelocity.current.x * aspectInv * 0.5,
      ndcVelocity.current.y * (isTouchDevice ? 2.5 : 1.5)
    );
    simulationMaterial.uniforms.uDeltaTime.value = dt;

    // Ping-pong: read from input, write to output.
    const tmp = inputRT.current;
    inputRT.current = outputRT.current;
    outputRT.current = tmp;
    simulationMaterial.uniforms.uParticleState.value = inputRT.current.texture;

    // Save state — our offscreen passes leave the renderer pointing
    // at intermediate targets; R3F's auto-render needs to start from
    // a clean (autoClear=true, renderTarget=null) state.
    const prevRT = state.gl.getRenderTarget();
    const prevAutoClear = state.gl.autoClear;

    // 1. Simulation pass — write new particle positions.
    state.gl.setRenderTarget(outputRT.current);
    state.gl.render(simScene, orthoCamera);

    // 2. Disc rasterisation — render points into the fixed-size FBO.
    //    Manually clear first since this FBO isn't auto-cleared.
    discMaterial.uniforms.uPositions.value = outputRT.current.texture;
    state.gl.setRenderTarget(discFBO);
    state.gl.autoClear = false;
    state.gl.clear(true, false, false);
    state.gl.render(discScene, orthoCamera);

    // 3. Kawase blur — directly invoke the pass. The pass blurs
    //    discFBO at low res internally, then upscales/copies into
    //    blurOutputFBO via its CopyMaterial step. The chrome plane
    //    samples blurOutputFBO at the full FBO resolution.
    blurPass.render(state.gl, discFBO, blurOutputFBO, dt, false);

    // Restore for R3F's auto-render of the main scene (chrome plane).
    state.gl.setRenderTarget(prevRT);
    state.gl.autoClear = prevAutoClear;
  });

  // Chrome plane lives in the main R3F scene. Vertex shader uses
  // modelMatrix only, so position/scale go straight to clip space.
  // SIZE_FACTOR is at file scope (see top of file) — keep it shared
  // with the touch hit-test so they can't drift apart.
  const canvasAspect = size.width / size.height;
  const planeHeight = 2 * TEXT_ASPECT;

  return (
    <mesh
      position={[0, yOffset, 0]}
      scale={[
        H * SCALE * SIZE_FACTOR,
        H * SCALE * canvasAspect * SIZE_FACTOR,
        1,
      ]}
      frustumCulled={false}
    >
      <planeGeometry args={[2, planeHeight]} />
      <primitive object={finalMaterial} attach="material" />
    </mesh>
  );
}
