const BLOCKED_PATHS = [
  "/portfolio/company/",
  "/portfolio/showcase/",
  "/showcase-proxy",
  "/showcase-removed",
  "/new-portfolio-companies/",
] as const;

export function normalizeAntlerSourceUrl(value: string, base?: string) {
  const url = new URL(value, base);
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (hostname !== "antler.co" && !hostname.endsWith(".antler.co"))
  ) {
    throw new Error("Antler sources must use HTTPS on antler.co or a subdomain.");
  }
  url.hostname = hostname === "antler.co" ? "www.antler.co" : hostname;
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function isRobotsDisallowedAntlerPath(value: string) {
  try {
    const path = new URL(value).pathname.toLowerCase();
    return BLOCKED_PATHS.some((blocked) =>
      blocked.endsWith("/") ? path.startsWith(blocked) : path === blocked || path.startsWith(`${blocked}/`),
    );
  } catch {
    return true;
  }
}

export function isAntlerOfficialUrl(value: string) {
  try {
    normalizeAntlerSourceUrl(value);
    return true;
  } catch {
    return false;
  }
}
