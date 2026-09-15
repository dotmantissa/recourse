import { useSyncExternalStore } from "react";

let modalOpen = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useModalStatus = () => ({ isOpen: useSyncExternalStore(subscribe, () => modalOpen, () => false) });

export async function requestWalletApproval() {
  if (!new URLSearchParams(location.search).has("wallet-modal")) return;
  await new Promise<void>((resolve, reject) => {
    const portal = document.createElement("div");
    portal.setAttribute("role", "dialog");
    portal.setAttribute("aria-modal", "true");
    portal.setAttribute("aria-label", "Wallet signature confirmation");
    portal.style.cssText = "position:fixed;inset:0;z-index:999999;background:#111;color:white;display:flex;align-items:center;justify-content:center;gap:20px";
    const finish = (approved: boolean) => {
      portal.remove();
      modalOpen = false;
      for (const listener of listeners) listener();
      if (approved) resolve();
      else reject(Object.assign(new Error("User rejected signing"), { code: 4001 }));
    };
    for (const approved of [true, false]) {
      const button = document.createElement("button");
      button.textContent = approved ? "Confirm wallet signature" : "Cancel wallet signature";
      button.onclick = () => finish(approved);
      portal.append(button);
    }
    document.body.append(portal);
    modalOpen = true;
    for (const listener of listeners) listener();
    requestAnimationFrame(() => portal.querySelector("button")?.focus());
  });
}

export const address = "0x2222222222222222222222222222222222222222";
const wallet = { address, walletClientType: "privy", switchChain: async () => {}, getEthereumProvider: async () => ({ request: async () => null }) };
export const usePrivy = () => ({ ready: true, authenticated: true, login: () => {}, logout: async () => {}, getAccessToken: async () => "fixture" });
export const useWallets = () => ({ wallets: [wallet] });
