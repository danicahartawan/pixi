import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pixi — Spatial notebook OCR",
  description: "Turn handwritten notebook pages into faithful spatial Markdown without losing their shape.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
