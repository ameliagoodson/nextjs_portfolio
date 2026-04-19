"use client";

import { useEffect, useRef } from "react";

import * as THREE from "three";

import { ChromeTextScene } from "./ChromeTextScene";

export default function ChromeTextCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pixelRatio = Math.min(window.devicePixelRatio, 2);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });

    renderer.setPixelRatio(pixelRatio);

    let stableWidth = window.innerWidth;
    let stableHeight = window.innerHeight;

    const isPortrait = () => stableHeight > stableWidth;

    const getViewportDimensions = () => {
      if (isPortrait()) {
        const minAspectRatio = 1.4;
        return {
          width: Math.floor(stableHeight * minAspectRatio),
          height: stableHeight,
        };
      }
      return { width: stableWidth, height: stableHeight };
    };

    const resizeCanvas = () => {
      const dims = getViewportDimensions();
      if (isPortrait()) {
        renderer.setSize(dims.width, dims.height, false);
        canvas.style.width = stableWidth + "px";
        canvas.style.height = stableHeight + "px";
      } else {
        renderer.setSize(stableWidth, stableHeight);
      }
    };

    resizeCanvas();

    // Only re-render on true orientation/width change — not mobile browser chrome hide/show
    const handleResize = () => {
      if (window.innerWidth !== stableWidth) {
        stableWidth = window.innerWidth;
        stableHeight = window.innerHeight;
        resizeCanvas();
      }
    };

    window.addEventListener("resize", handleResize);

    const scene = new ChromeTextScene(renderer, canvas, getViewportDimensions);

    return () => {
      window.removeEventListener("resize", handleResize);
      scene.cleanup();
      renderer.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-10 h-full w-full"
      style={{ pointerEvents: "auto" }}
    />
  );
}
