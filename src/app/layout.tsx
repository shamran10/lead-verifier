import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Founder Email Verifier",
    template: "%s · Founder Email Verifier",
  },
  description: "Import and review founder email candidates.",
};

const navigation = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/batches", label: "Batches" },
  { href: "/upload", label: "Upload" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body
        className="min-h-full bg-slate-50 text-slate-800"
        suppressHydrationWarning
      >
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
            <Link className="flex items-center gap-3" href="/dashboard">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-600 text-sm font-black text-white shadow-sm shadow-indigo-200">
                FE
              </span>
              <span>
                <span className="block text-sm font-bold text-slate-950">
                  Founder Email Verifier
                </span>
                <span className="block text-xs text-slate-500">
                  Review-first workflow
                </span>
              </span>
            </Link>
            <nav aria-label="Main navigation">
              <ul className="flex items-center gap-1">
                {navigation.map((item) => (
                  <li key={item.href}>
                    <Link className="nav-link" href={item.href}>
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          {children}
        </main>
      </body>
    </html>
  );
}
