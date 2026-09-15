import { useEffect, useRef } from "react";

// A sheet rather than a dropdown: it rises near the thumb and gives each row a
// real touch target, where a menu dropping from the top of a tall phone is a
// mis-tap generator.
export default function ControlSheet({ open, onClose, children }) {
  const panel = useRef(null);

  // Keyed on `open` ALONE, deliberately. `onClose` is an inline arrow recreated
  // on every render of Draft, and a live draft re-renders once a second from
  // the countdown tick -- so including it here tore this effect down and ran it
  // again every second, restoring focus and then re-stealing it. Measured:
  // focus placed on the board select was back on the panel within 1.6s, which
  // made the sheet's headline control impossible to use and would dismiss a
  // native picker mid-selection. The keydown listener below can take `onClose`
  // because re-registering a listener costs nothing and moves no focus.
  useEffect(() => {
    if (!open) return undefined;
    const restoreTo = document.activeElement;
    panel.current?.focus();
    return () => restoreTo?.focus?.();
  }, [open]);

  // role="dialog" is a promise about behaviour, not a label. Escape is the key
  // everyone tries first.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="xl:hidden fixed inset-0 z-40 flex flex-col justify-end">
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
