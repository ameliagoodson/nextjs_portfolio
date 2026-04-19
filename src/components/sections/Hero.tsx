"use client";

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

      {/* Content — chrome text will go here */}
      <div className="relative z-10 px-4 text-center">
        <h1 className="text-text text-6xl font-bold tracking-tight md:text-8xl">
          Amelia Goodson
        </h1>
        <p className="text-text-muted mx-auto mt-4 max-w-lg text-lg md:text-xl">
          Frontend Developer
        </p>
      </div>
    </section>
  );
}
