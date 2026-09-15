"use client";

import { useId, useLayoutEffect, useRef } from "react";
import { useModalStatus } from "@privy-io/react-auth";
import { X } from "lucide-react";

const lastFocused = new WeakMap<HTMLDialogElement, HTMLElement>();
const mountedDialogs = new Set<HTMLDialogElement>();
let walletModalOpen = false;

function synchronizeDialogs(isWalletOpen: boolean) {
  walletModalOpen = isWalletOpen;
  if (isWalletOpen) {
    for (const dialog of Array.from(mountedDialogs).reverse()) dialog.close();
    return;
  }
  for (const dialog of mountedDialogs) {
    if (dialog.open) continue;
    dialog.showModal();
    lastFocused.get(dialog)?.focus();
  }
}

export function ModalShell({ title, eyebrow, onClose, children }: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { isOpen: isWalletOpen } = useModalStatus();
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const parent = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1);
    const previous = document.activeElement === document.body && parent ? lastFocused.get(parent) : document.activeElement as HTMLElement | null;
    mountedDialogs.add(dialog);
    return () => {
      mountedDialogs.delete(dialog);
      dialog.close();
      requestAnimationFrame(() => {
        if (walletModalOpen) return;
        const top = Array.from(mountedDialogs).at(-1);
        if (previous?.isConnected && (!top || top.contains(previous))) previous.focus();
      });
    };
  }, []);
  useLayoutEffect(() => { synchronizeDialogs(isWalletOpen); }, [isWalletOpen]);
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
