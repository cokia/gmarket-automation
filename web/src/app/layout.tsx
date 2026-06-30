import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Watermark } from "@/components/watermark";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "지마켓 결제 자동화 시스템",
  description: "퍼스트페이/퍼스트핀 전용",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Watermark />
        {children}
      </body>
    </html>
  );
}
