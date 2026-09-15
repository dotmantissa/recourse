"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

const lastFocused = new WeakMap<HTMLDialogElement, HTMLElement>();

export function ModalShell({ title, eyebrow, onClose, children }: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const parent = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1);
    const previous = document.activeElement === document.body && parent ? lastFocused.get(parent) : document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      requestAnimationFrame(() => { if (previous?.isConnected) previous.focus(); });
    };
  }, []);
  return <dialog className="modal-backdrop" ref={dialogRef} aria-labelledby={titleId} onFocusCapture={(event) => { if (event.target instanceof HTMLElement) lastFocused.set(event.currentTarget, event.target); }} onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter((element) => element.getClientRects().length > 0);
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div className="modal">
      <div className="modal-head">
        <div><span className="eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div>
        <button className="icon-button" aria-label="Close dialog" title="Close dialog" onClick={onClose}><X size={18} /></button>
      </div>
      {children}
    </div>
  </dialog>;
}
