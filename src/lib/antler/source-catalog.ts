import type { AntlerSourceCandidate } from "@/lib/antler/types";

export const ANTLER_PORTFOLIO_URL =
  "https://www.antler.co/portfolio?0b933bfd_page=1";
export const ANTLER_INSIGHTS_URL = "https://www.antler.co/insights";

export const MAINTAINED_ANTLER_SOURCES: readonly AntlerSourceCandidate[] = [
  {
    url: ANTLER_PORTFOLIO_URL,
    sourceKind: "portfolio_directory",
    origin: "catalog",
    discoveredFrom: null,
    yearHint: null,
    programHint: "Antler Portfolio Directory",
  },
  {
    url: "https://www.antler.co/blog/announcing-the-spring-2025-us-portfolio-showcase",
    sourceKind: "showcase",
    origin: "catalog",
    discoveredFrom: null,
    yearHint: 2025,
    programHint: "Spring 2025 U.S. Portfolio Showcase",
  },
  {
    url: "https://www.antler.co/blog/announcing-the-fall-2025-u-s-portfolio-showcase",
    sourceKind: "showcase",
    origin: "catalog",
    discoveredFrom: null,
    yearHint: 2025,
    programHint: "Fall 2025 U.S. Portfolio Showcase",
  },
  {
    url: "https://www.antler.co/blog/announcing-the-spring-2026-u-s-portfolio-showcase",
    sourceKind: "showcase",
    origin: "catalog",
    discoveredFrom: null,
    yearHint: 2026,
    programHint: "Spring 2026 U.S. Portfolio Showcase",
  },
  {
    url: ANTLER_INSIGHTS_URL,
    sourceKind: "insights_index",
    origin: "catalog",
    discoveredFrom: null,
    yearHint: null,
    programHint: null,
  },
] as const;
