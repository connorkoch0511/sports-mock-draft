import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

const LINKS = [
  { to: "/", label: "Home" },
  { to: "/boards", label: "Boards" },
];

export default function NavBar() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const toggleRef = useRef(null);
  const menuRef = useRef(null);

  // Close on route change. Driven off pathname rather than the links' onClick
  // so that programmatic navigation closes the menu too.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e) {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    }
    function onPointerDown(e) {
      if (
        !menuRef.current?.contains(e.target) &&
        !toggleRef.current?.contains(e.target)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <header className="relative flex items-center justify-between py-4">
      <Link
        to="/"
        className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white"
      >
        <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.6)]" />
        PerfectPick
      </Link>

      <button
        ref={toggleRef}
        type="button"
        data-testid="nav-toggle"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls="nav-menu"
        onClick={() => setOpen((v) => !v)}
        className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-lg leading-none text-zinc-200 hover:border-zinc-600"
      >
        ☰
      </button>

      {open && (
        <nav
          id="nav-menu"
          ref={menuRef}
          data-testid="nav-menu"
          className="absolute right-0 top-full z-50 w-48 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur"
        >
          {LINKS.map((link) => {
            const active = pathname === link.to;
            return (
              <Link
                key={link.to}
                to={link.to}
                aria-current={active ? "page" : undefined}
                // The pathname effect misses a click on the route you are
                // already on, since pathname does not change. Close here too.
                onClick={() => setOpen(false)}
                className={`block px-4 py-3 text-sm hover:bg-zinc-900 ${
                  active ? "text-cyan-300" : "text-zinc-200"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
