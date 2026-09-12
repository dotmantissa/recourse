"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { defineChain } from "viem";
import { CHAIN_ID, EXPLORER_URL, RPC_URL } from "@/lib/config";

export const studioNextChain = defineChain({
  id: CHAIN_ID,
  name: "GenLayer Studio Next",
  network: "genlayer-studio-next",
  nativeCurrency: {
    name: "GEN",
    symbol: "GEN",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: {
      name: "Studio Explorer",
      url: EXPLORER_URL,
    },
  },
});

export default function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";

  if (!appId) {
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#c8ff38",
          walletChainType: "ethereum-only",
          showWalletLoginFirst: true,
        },
        defaultChain: studioNextChain,
        supportedChains: [studioNextChain],
        embeddedWallets: {
          ethereum: {
            createOnLogin: "all-users",
          },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
