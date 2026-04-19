"use client";

import dynamic from "next/dynamic";

const ChromeTextCanvas = dynamic(
  () => import("./chrome-text/ChromeTextCanvas"),
  { ssr: false }
);

export default function Hero() {
  return (
    <section className="relative flex h-dvh w-full items-center justify-center overflow-hidden">
      {/* Video background */}
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src="/video/hero.mp4"
        autoPlay
        muted
        loop
        playsInline
      />

      {/* Overlay */}
      <div className="bg-bg/40 absolute inset-0" />

      {/* Chrome text canvas — transparent, sits above overlay */}
      <ChromeTextCanvas />
    </section>
  );
}
