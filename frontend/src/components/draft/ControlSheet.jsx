// A sheet rather than a dropdown: it rises near the thumb and gives each row a
// real touch target, where a menu dropping from the top of a tall phone is a
// mis-tap generator.
export default function ControlSheet({ open, onClose, children }) {
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
        data-testid="control-sheet"
        role="dialog"
        aria-label="Draft controls"
        className="relative rounded-t-3xl border-t border-zinc-800 bg-zinc-950 p-4 pb-8 flex flex-col gap-3"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-zinc-700" />
        {children}
      </div>
    </div>
  );
}
