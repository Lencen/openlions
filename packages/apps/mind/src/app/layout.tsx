import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "Lion's Mind",
  description: "Lion's cognitive management platform — memory, knowledge, learning, reflection, skills & practice",
};

// 2026-10-13 round 76-BQ: mind 前端整体退休后**已无任何页面**(见 archive/frontend-20260905/)。
//   原布局包了一层 antd 的 <AppLayout>(Sidebar) -> 现移除, mind 因此不再依赖 antd / @ant-design/icons。
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
