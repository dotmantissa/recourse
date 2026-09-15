export const address = "0x2222222222222222222222222222222222222222";
const wallet = { address, walletClientType: "privy", switchChain: async () => {}, getEthereumProvider: async () => ({ request: async () => null }) };
export const usePrivy = () => ({ ready: true, authenticated: true, login: () => {}, logout: async () => {}, getAccessToken: async () => "fixture" });
export const useWallets = () => ({ wallets: [wallet] });
