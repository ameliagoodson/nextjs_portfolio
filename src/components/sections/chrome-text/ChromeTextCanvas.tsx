"use client";

import { Suspense } from "react";

import { Canvas } from "@react-three/fiber";

import ChromeText from "./ChromeText";

/**
 * Hosts the R3F canvas that the chrome text effect renders into.
 *
 * Notes:
 * - `dpr={[1, 2]}` caps pixel ratio at 2 — the original WordPress port did
 *   the same. Higher DPR has minimal visual benefit here and is expensive
 *   given the GPGPU passes run every frame.
 * - `gl.alpha = true` so the video underneath shows through.
 * - No camera config: the chrome effect ignores the camera (final shader
 *   sets gl_Position from modelMatrix only).
 * - `pointer-events: auto` so cursor coords aren't intercepted by the
 *   absolutely-positioned overlay above.
 */
export default function ChromeTextCanvas() {
  return (
    <Canvas
      className="absolute inset-0 z-10 h-full w-full"
      style={{ pointerEvents: "auto" }}
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true, stencil: false, depth: false }}
    >
      <Suspense fallback={null}>
        <ChromeText />
      </Suspense>
    </Canvas>
  );
}
