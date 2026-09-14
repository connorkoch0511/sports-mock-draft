import { useEffect, useRef } from "react";

// A sheet rather than a dropdown: it rises near the thumb and gives each row a
// real touch target, where a menu dropping from the top of a tall phone is a
// mis-tap generator.
export default function ControlSheet({ open, onClose, children }) {
  const panel = useRef(null);
  const restoreTo = useRef(null);

  // role="dialog" is a promise about behaviour, not a label. Without these a
  // keyboard user tabs straight through the dimmed backdrop into the page
  // behind, and Escape -- the one key everyone tries -- does nothing.
  useEffect(() => {
    if (!open) return undefined;
    restoreTo.current = document.activeElement;
    panel.current?.focus();

    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Send focus back where it came from, so dismissing the sheet does not
      // dump the caret at the top of the document.
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="lg:hidden fixed inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close controls"
        data-testid="close-controls"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        ref={panel}
        tabIndex={-1}
        data-testid="control-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Draft controls"
        className="relative rounded-t-3xl border-t border-zinc-800 bg-zinc-950 p-4 pb-8 flex flex-col gap-3 outline-none"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-zinc-700" />
        {children}
      </div>
    </div>
  );
}
