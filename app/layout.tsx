import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const origin = new URL(`${protocol}://${host}`);
  const description = "在本机安全浏览、搜索和分析微信只读快照。";
  return {
    metadataBase: origin,
    title: "Weixin AgentOS · 本地只读微信工作台",
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Weixin AgentOS",
      description,
      type: "website",
      images: [{ url: new URL("/og.png", origin).toString(), width: 1680, height: 945, alt: "Weixin AgentOS 本地只读私有工作台" }],
    },
    twitter: { card: "summary_large_image", title: "Weixin AgentOS", description, images: [new URL("/og.png", origin).toString()] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
