# Chrome Text Effect — Notes

GPGPU particle simulation ported from Shopify Editions Summer 2025.
Original Shopify source is at `../../../../Shopify_2025-JS.js`.

## Visual goal — read these first

Before tuning anything visual, look at the reference images. They are
the **target**, not vague guidance:

- `public/references/shopify-goal-text.png` — Shopify's "Horizons" hero
  in context. Shows the size, position, and overall look.
- `public/references/shopify-goal-text-closeup.png` — closeup of one
  letter. This is the chrome we want: thick bulbous strokes, sharp
  bright specular highlights along the top of each curve, dark shadow
  areas underneath, iridescent purple/blue/pink fringing on the edges.
  Looks like polished liquid mercury, not a glass outline.
- `public/references/previous-commit-attempt-good-not-perfect.png` —
  the previous vanilla Three.js version. Confirms the **current**
  R3F port matches that quality bar.

Acceptance criteria for the visual:

1. Strokes are **thick** — bulbous cylinders, not thin lines.
2. Strong **light/dark contrast** across each stroke (matcap doing real
   3D shading work).
3. **Iridescent edges** — purple/pink/blue colour fringing where the
   normal points sideways.
4. Letters stay **legible** — each character distinct, not merged.

## Architecture

This is an **R3F port** of the Shopify component. The render pipeline
mirrors the original WordPress vanilla-three-js port (git commit
`84641ef`) which was the first version that nailed the visual.

- `ChromeTextCanvas.tsx` — thin wrapper. Hosts the `<Canvas>` and `<Suspense>`.
- `ChromeText.tsx` — the actual effect. Hooks, shaders, simulation, blur, chrome plane.

### Pipeline (per frame)

```
sim FBO (256×128) ─┐
                   ├─► outputRT.texture ─┐
sim FBO (256×128) ─┘                     │
   (ping-pong)                           ▼
                                  discMaterial.uPositions
                                          │
                                          ▼
                            discFBO (FIXED 2680×1168)
                                          │
                                          ▼
                       KawaseBlurPass.render(discFBO, …)
                                          │
                                          ▼
                       blurPass.renderTargetA.texture
                                          │
                                          ▼
       finalMaterial.uBlurredTexture (chrome matcap shader)
                                          │
                                          ▼
              <mesh planeGeometry/> in main R3F scene
                                          │
                                          ▼
                                     canvas pixels
```

### Why a fixed-size offscreen FBO is non-negotiable

The single most important architectural decision: the disc-rasterisation
buffer (`discFBO`) is **always 2680×1168 regardless of viewport or DPR**.

Shopify's tuning values (`pointSize=20`, `threshold=0.36`, `cutoff=0.72`,
`KernelSize.VERY_LARGE`, `strength=7`, `offsetStrength=0.008`) are all
expressed in pixels of that fixed buffer. If you render the discs into
a canvas-sized buffer instead:

- A `VERY_LARGE` kawase kernel covers a different fraction of the
  smaller buffer, so it either smears letters together (small canvas)
  or barely blurs (big canvas).
- `pointSize=20` produces tiny dots on a 4K canvas.
- `threshold=0.36` clips out everything because peak intensity is
  lower when the same disc count spreads over more pixels.

**Lesson learned the hard way:** I previously tried inlining the
responsive disc transform into the vertex shader and rendering directly
into a canvas-sized composer buffer. The result looked qualitatively
wrong — strokes too thin, no bulbous chrome volume. Reverting to the
fixed-size FBO immediately produced the reference look.

### Why NOT `<EffectComposer>` from `@react-three/postprocessing`

I tried this. It's the obvious-looking solution. It doesn't work
because the JSX wrapper sizes its internal buffers to the canvas via
`renderer.setSize()`. Two failure modes:

1. If you call `composer.setSize(2680, 1168)` to fix it, the wrapper
   resizes the **user's canvas** to 2680×1168.
2. If you don't, the composer's buffers stay at canvas size and all of
   Shopify's tuning is wrong (see previous section).

Inspecting `node_modules/postprocessing/build/index.js` also revealed:

- `EffectComposer` permanently sets `renderer.autoClear = false` at
  construction. Any code path that relies on auto-clear (R3F's main
  render does) breaks afterwards.
- `KawaseBlurPass` ignores the composer's `outputBuffer` — it always
  writes to its own internal `renderTargetA`/`renderTargetB`. So
  layering it as an effect inside `<EffectComposer>` doesn't even give
  you the buffer you'd want to sample anyway.

The current setup uses `KawaseBlurPass` **standalone**, sized
explicitly via `setSize(2680, 1168)`, invoked directly with
`blurPass.render(gl, discFBO, null, dt, false)`.

### useFrame at default priority — let R3F render the main scene

The `useFrame` callback runs at the **default priority (0)**. That
matters because R3F still auto-renders the main scene afterwards, and
the chrome plane lives in that main scene. The callback only has to
handle the offscreen passes:

```ts
useFrame((state, delta) => {
  // save state — offscreen passes will leave the renderer in a
  // weird state (custom render target, autoClear=false from blur pass)
  const prevRT = state.gl.getRenderTarget();
  const prevAutoClear = state.gl.autoClear;

  // 1. simulation pass → outputRT
  state.gl.setRenderTarget(outputRT.current);
  state.gl.render(simScene, orthoCamera);

  // 2. discs into the fixed-size FBO
  discMaterial.uniforms.uPositions.value = outputRT.current.texture;
  state.gl.setRenderTarget(discFBO);
  state.gl.autoClear = false;
  state.gl.clear(true, false, false);
  state.gl.render(discScene, orthoCamera);

  // 3. kawase blur into blurPass.renderTargetA
  blurPass.render(state.gl, discFBO, null, dt, false);

  // restore so R3F's auto-render of the main scene works cleanly
  state.gl.setRenderTarget(prevRT);
  state.gl.autoClear = prevAutoClear;
});
```

**Earlier mistake:** I once gave this `useFrame` `priority=1`, which
disables R3F's auto render. The chrome plane never drew, the canvas
went black. Default priority + a `state.gl.setRenderTarget(null)` /
`autoClear=true` restore is what makes the whole thing hang together.

### Wiring the blur output to the chrome plane

`KawaseBlurPass` ping-pongs internally between `renderTargetA` and
`renderTargetB`. With its 7-kernel sequence (`[3,5,7,9,11,13,15]`) the
final write lands in `renderTargetA`. We wire that texture once at mount:

```ts
useEffect(() => {
  const len = blurPass.blurMaterial.kernelSequence.length; // 7
  const finalRT =
    (len - 1) & 1 ? blurPass.renderTargetB : blurPass.renderTargetA;
  finalMaterial.uniforms.uBlurredTexture.value = finalRT.texture;
}, [blurPass, finalMaterial]);
```

Don't refactor this without checking the kernel sequence length.

### Chrome plane sizing lives on the mesh, not the shader

The chrome plane is a 2×planeHeight `planeGeometry` placed at
`y = yOffset` and scaled `[H * SCALE, H * SCALE * canvasAspect, 1]` —
exactly the same transform Shopify applied to its chrome plane. The
disc vertex shader stays in normalised offscreen space because the
discFBO is fixed-size; only the **viewing** plane needs to know about
canvas aspect.

### Offscreen scenes are built imperatively, not via `createPortal`

Lesson from earlier iterations: passing `geometry={…}` and `material={…}`
as props on a portaled intrinsic is fragile under React Strict Mode +
Fast Refresh. The mesh either never attaches or gets reparented away.
The robust pattern (and what's in `ChromeText.tsx`) is to build the
offscreen scenes imperatively inside `useMemo`:

```ts
const discScene = useMemo(() => {
  const s = new THREE.Scene();
  const pts = new THREE.Points(pointsGeometry, discMaterial);
  pts.frustumCulled = false;
  s.add(pts);
  return s;
}, [pointsGeometry, discMaterial]);
```

## How it works (data flow)

1. A PNG (white text on black) is loaded — white pixels become particle
   positions in `extractParticlePositions`.
2. Each frame the physics shader runs on GPU (ping-pong FBOs from
   `useFBO`), updating position/velocity with spring forces + mouse
   repulsion.
3. Discs are rasterised at the new positions into the fixed-size
   `discFBO` (2680×1168).
4. Kawase blur smears them into liquid metaballs.
5. The chrome plane (in the main R3F scene) samples the blurred buffer,
   derives a normal from the gradient, samples a matcap for chrome
   sheen, and `discard`s anything below `cutoff` so the underlying
   video shows through.

## Tuning values (matched to Shopify exactly)

| Parameter                     | Value                        | Notes                                     |
| ----------------------------- | ---------------------------- | ----------------------------------------- |
| `pointSize`                   | `20.0`                       | In disc vertex shader.                    |
| `sizeMultiplier`              | `1.0 + dist * 6.0`           | Scattered particles grow.                 |
| `GRID_WIDTH × GRID_HEIGHT`    | `256 × 128`                  | 32,768 particles.                         |
| `OFFSCREEN_WIDTH × HEIGHT`    | `2680 × 1168`                | Fixed disc-FBO and blur-pass size.        |
| `SCALE`                       | `2.58`                       | Chrome plane scaling factor.              |
| `springConstant`              | `11.0`                       | How fast particles return.                |
| `damping`                     | `8.0`                        | How quickly they settle.                  |
| `maxVelocity` (shader)        | `1.7`                        | Velocity cap in simulation.               |
| `pushStrength`                | `30.0`                       | Mouse repulsion force.                    |
| `interactionRadius` (desktop) | `0.065`                      | Mouse brush size.                         |
| `interactionRadius` (mobile)  | `0.075`                      | Slightly larger on touch.                 |
| `matcapRotation`              | `3.1459`                     | ≈π. Matcap is mostly symmetric.           |
| `strength`                    | `7.0`                        | Normal tilt magnitude.                    |
| `offsetStrength`              | `0.008`                      | Gradient sample distance for normal.      |
| `threshold`                   | `0.36`                       | Below this the normal sample is rejected. |
| `cutoff`                      | `0.72`                       | Below this the chrome shader discards.    |
| `STEPS`                       | `15`                         | Normal sampling iterations.               |
| `KawaseBlur kernelSize`       | `VERY_LARGE`                 | The biggest kawase kernel.                |
| `KawaseBlur resolutionScale`  | `0.5`                        | Slight downsample for performance.        |
| Matcap texture                | `matcap_512.png`             | Carried from old WordPress port.          |
| Position texture              | `hero-text-11-southwave.png` | Our font.                                 |

## Mouse interaction

The pointer is stored in **NDC** (top = +1, bottom = -1) — the
WebGL/Three.js convention, not the CSS one. The mouseY transform in
`useFrame` matches the vanilla port:

```ts
const aspectInv = state.size.height / state.size.width;
const mouseX = ndcX / (H * SCALE);
const mouseY = (((ndcY - yOffset) / H) * aspectInv) / (SCALE * TEXT_ASPECT);
```

If you "fix" the pointer to CSS-NDC (top = -1) without also flipping
the formula, vertical interaction inverts. Do not change one without
the other.

The pointer listener is attached to `gl.domElement` and converts client
coordinates relative to the canvas's bounding rect. Velocity is finite-
difference between the previous and current pointer, divided by frame
delta, with a 16ms-min smoothing.

## Tuning guide

**Too thick / letters bleeding together:**

- Drop `kernelSize` to `LARGE`
- Increase `cutoff` (try 0.78–0.85)
- Reduce `pointSize` in `discVertexShader` (try 16–18)

**Too thin / dots showing:**

- Confirm the disc-FBO is actually 2680×1168 (regressions here are subtle)
- Lower `cutoff` (0.65)
- Increase `pointSize` (try 22–24)

**Less iridescent / looks grey:**

- Bump `strength` (try 8–9). The matcap controls the colour ceiling.
- The font PNG stroke weight is the main cause if the strokes look
  hollow — thicker strokes expose more matcap colour.

**Mouse interaction feels off-centre or upside-down:**

- The pointer is **NDC** (top = +1). See "Mouse interaction" above.
- The responsive `H` (group scale) or `yOffset` being wrong also breaks
  this — compare the responsive useEffect against Shopify lines ~4795–4815.

## Shopify intro animation (not implemented)

Shopify has a 2900ms intro animation (easeOutQuad) driving
`uIntroProgress` 0→1. We set `uIntroProgress = 1.5` (fully revealed,
no intro animation). Add it back if we want the materialise-on-load
effect.
