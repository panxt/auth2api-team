import { ReactNode, useEffect } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
}

export function Modal({ open, onClose, title, children, size = "md" }: ModalProps) {
  // ESC to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sizeClass = {
    sm: "max-w-md",
    md: "max-w-xl",
    lg: "max-w-3xl",
  }[size];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className={`${sizeClass} w-full rounded-lg border border-ink-700 bg-ink-900 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-ink-800">
          <h2 className="text-lg font-medium">{title}</h2>
          <button onClick={onClose} className="btn-ghost text-xl leading-none">
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
