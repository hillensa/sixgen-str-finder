import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Sixgen STR Finder", description: "Acquisition intelligence for short-term-rental investments." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
