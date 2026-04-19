"use client";

import { Suspense } from "react";

import { Canvas } from "@react-three/fiber";

import ChromeText from "./ChromeText";

/**
 * Hosts the R3F canvas that the chrome text effect renders into.
 *
 * Notes:
 * - `dpr={Math.min(window.devicePixelRatio, 2)}` caps pixel ratio at 2.
 *   We pass a fixed value (not a range) because R3F's range-based DPR
 *   can settle at the wrong value on initial paint, then switch — that
 *   triggers a canvas resize one frame in, visible as a "shudder".
 * - `gl.alpha = true` so the video underneath shows through.
 * - No camera config: the chrome plane uses clip-space rendering
 *   (vertex shader sets `gl_Position = modelMatrix * position`), so the
 *   camera is irrelevant. Mesh sizing is handled in `ChromeText.tsx`
 *   via responsive H * SCALE * SIZE_FACTOR scale on the mesh.
 * - `pointer-events: auto` so cursor coords aren't intercepted by the
 *   absolutely-positioned overlay above.
 * - No `touch-action: none` here — touches outside the chrome text
 *   region must still scroll the page. The hit-test that decides
 *   whether to consume a gesture lives in `ChromeText.tsx` and runs
 *   on touchstart against the responsive bounds of the chrome plane.
 */
export default function ChromeTextCanvas() {
  const dpr =
    typeof window !== "undefined" ? Math.min(window.devicePixelRatio, 2) : 1;

  return (
    <Canvas
      className="absolute inset-0 z-10 h-full w-full"
      style={{ pointerEvents: "auto" }}
      dpr={dpr}
      gl={{ alpha: true, antialias: true, stencil: false, depth: false }}
    >
      <Suspense fallback={null}>
        <ChromeText />
      </Suspense>
    </Canvas>
  );
}
