export default function Footer() {
  return (
    <footer className="text-text-muted border-purple-mid/30 flex items-center justify-between border-t px-8 py-8 text-xs">
      <span>© {new Date().getFullYear()} Amelia Goodson</span>
      <div className="flex gap-6">
        <a
          href="https://github.com/ameliagoodson"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text transition-colors"
        >
          GitHub
        </a>
        <a
          href="https://linkedin.com/in/ameliagoodson"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-text transition-colors"
        >
          LinkedIn
        </a>
      </div>
    </footer>
  );
}
