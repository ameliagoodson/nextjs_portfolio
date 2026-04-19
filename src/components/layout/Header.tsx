"use client";

export default function Header() {
  return (
    <header className="fixed top-0 right-0 left-0 z-50 flex items-center justify-between px-8 py-4">
      <span className="text-text-muted font-mono text-sm tracking-widest uppercase">
        Amelia Goodson
      </span>
      <nav className="text-text-muted flex gap-8 text-sm">
        <a href="#work" className="hover:text-text transition-colors">
          Work
        </a>
        <a href="#about" className="hover:text-text transition-colors">
          About
        </a>
        <a href="#contact" className="hover:text-text transition-colors">
          Contact
        </a>
      </nav>
    </header>
  );
}
