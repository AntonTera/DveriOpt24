import type { Metadata } from "next";
import { ReactNode } from "react";

export const metadata: Metadata = {
  title: "DveriOpt24 Integrations",
  description: "Webhook and queue backend for amoCRM KPI sync."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body
        style={{
          margin: 0,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          background: "#f5f5f0",
          color: "#1f2937"
        }}
      >
        {children}
      </body>
    </html>
  );
}
