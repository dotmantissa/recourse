import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recourse | Agent commerce with a way back",
  description: "Request-level escrow and automatic chargebacks for agent commerce.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

