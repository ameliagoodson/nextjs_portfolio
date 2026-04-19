"use client";

/* eslint-disable react-hooks/immutability, react-hooks/set-state-in-effect */
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
 *      makes Shopify's exact values (pointSize=20, threshold=0.36,
 *      cutoff=0.72, VERY_LARGE kernel) reproduce Shopify's look.
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
import { useEffect, useMemo, useRef, useState } from "react";

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
const float maxVelocity = 1.7;
const float pushStrength = 30.0;

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
// & scaled via responsive transforms.
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
          uCutoff: { value: 0.72 },
        },
        vertexShader: finalVertexShader,
        fragmentShader: finalFragmentShader,
        transparent: true,
        depthTest: false,
      }),
    [matcap]
  );

  // Offscreen disc FBO at fixed Shopify resolution. NOT canvas-sized,
  // so DPR changes don't shift our tuning constants.
  const discFBO = useFBO(OFFSCREEN_WIDTH, OFFSCREEN_HEIGHT, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    stencilBuffer: false,
    depthBuffer: false,
    type: THREE.UnsignedByteType,
  });

  // Standalone KawaseBlurPass. We DON'T put it in an EffectComposer
  // because EffectComposer.setSize would resize the user's canvas.
  // Calling pass.render() directly with our discFBO as inputBuffer
  // works fine — the pass uses its own internal ping-pong targets
  // (renderTargetA/B) for the blur iterations.
  //
  // For VERY_LARGE the kernel sequence has 7 entries; the final
  // write at i=6 lands in renderTargetA ((6 & 1) === 0 → A).
  const blurPass = useMemo(() => {
    const p = new KawaseBlurPass({
      kernelSize: KernelSize.VERY_LARGE,
      resolutionScale: 0.5,
    });
    p.setSize(OFFSCREEN_WIDTH, OFFSCREEN_HEIGHT);
    return p;
  }, []);

  // Wire the blur output into the chrome plane material. Determines
  // A vs B from kernelSequence parity so the kernel size can change
  // without breaking the wiring.
  useEffect(() => {
    // KawaseBlurPass keeps its kernelSequence and ping-pong render
    // targets internal — not part of the public type. We need to
    // reach in to know which target the final blur write lands in so
    // we can sample it from the chrome plane material.
    const internals = blurPass as unknown as {
      blurMaterial?: { kernelSequence?: number[] };
      renderTargetA: THREE.WebGLRenderTarget;
      renderTargetB: THREE.WebGLRenderTarget;
    };
    const len = internals.blurMaterial?.kernelSequence?.length ?? 7;
    const lastIdx = len - 1;
    const finalTarget =
      (lastIdx & 1) === 0 ? internals.renderTargetA : internals.renderTargetB;
    finalMaterial.uniforms.uBlurredTexture.value = finalTarget.texture;
  }, [blurPass, finalMaterial]);

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
    const touchHandler = (e: TouchEvent) => {
      if (e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY);
    };

    window.addEventListener("mousemove", mouseHandler);
    window.addEventListener("touchmove", touchHandler, { passive: true });
    return () => {
      window.removeEventListener("mousemove", mouseHandler);
      window.removeEventListener("touchmove", touchHandler);
    };
  }, [gl]);

  // Responsive sizing.
  const [{ H, yOffset }, setResponsive] = useState(() =>
    computeResponsive(
      typeof window !== "undefined" ? window.innerWidth : 1024,
      typeof window !== "undefined" ? window.innerHeight : 768
    )
  );

  useEffect(() => {
    setResponsive(computeResponsive(size.width, size.height));
  }, [size.width, size.height]);

  // Ping-pong refs.
  const inputRT = useRef(simRT1);
  const outputRT = useRef(simRT2);

  // Per-frame render loop. Default priority (0) so R3F still
  // auto-renders the main scene after our offscreen passes — that's
  // what draws the chrome plane to the canvas.
  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.3);

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

    // 3. Kawase blur — directly invoke the pass with our discFBO as
    //    the input buffer. Output is in blurPass.renderTargetA.
    blurPass.render(state.gl, discFBO, null, dt, false);

    // Restore for R3F's auto-render of the main scene (chrome plane).
    state.gl.setRenderTarget(prevRT);
    state.gl.autoClear = prevAutoClear;
  });

  // Chrome plane lives in the main R3F scene. Vertex shader uses
  // modelMatrix only, so position/scale go straight to clip space.
  const canvasAspect = size.width / size.height;
  const planeHeight = 2 * TEXT_ASPECT;

  return (
    <mesh
      position={[0, yOffset, 0]}
      scale={[H * SCALE, H * SCALE * canvasAspect, 1]}
      frustumCulled={false}
    >
      <planeGeometry args={[2, planeHeight]} />
      <primitive object={finalMaterial} attach="material" />
    </mesh>
  );
}
