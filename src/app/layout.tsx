import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// Typography system (files live in /fonts, all OFL-licensed):
//  Inter       — body/UI text (variable font: covers Regular 400 + Medium 500)
//  Anton       — headings & primary buttons (single-weight display)
//  Metal Mania — hero tagline ONLY; overusing it dulls its impact
const inter = localFont({
  src: [
    { path: "../../fonts/Inter/Inter-VariableFont_opsz,wght.ttf", style: "normal" },
    { path: "../../fonts/Inter/Inter-Italic-VariableFont_opsz,wght.ttf", style: "italic" },
  ],
  weight: "100 900",
  variable: "--font-inter",
  display: "swap",
});

const anton = localFont({
  src: "../../fonts/Anton/Anton-Regular.ttf",
  weight: "400",
  variable: "--font-anton",
  display: "swap",
});

const metalMania = localFont({
  src: "../../fonts/Metal_Mania/MetalMania-Regular.ttf",
  weight: "400",
  variable: "--font-metal-mania",
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bookmark Graveyard",
  description: "Raise your X bookmarks from the dead: a weekly brief and podcast made from what you saved.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${anton.variable} ${metalMania.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
