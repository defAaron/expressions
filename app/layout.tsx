import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Expressions",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ backgroundColor: "#ffffff", color: "#000000" }}>
        <script src="/face.js" defer />
        {children}
      </body>
    </html>
  );
}
