const CHARACTER_REPLACEMENTS: Record<string, string> = {
  ø: "o",
  ł: "l",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  ð: "d",
  đ: "d",
  þ: "th",
  ħ: "h",
  ı: "i",
  ŧ: "t",
  ŋ: "n",
};

const HONORIFICS = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "miss",
  "prof",
  "sir",
]);

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md"]);

function transliterate(value: string) {
  return value
    .toLowerCase()
    .split("")
    .map((character) => CHARACTER_REPLACEMENTS[character] ?? character)
    .join("")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function normalizeDomain(website: string): string | null {
  const value = website.trim().toLowerCase();

  if (!value || /\s/.test(value)) {
    return null;
  }

  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    let hostname = url.hostname.toLowerCase().replace(/\.$/, "");

    if (hostname.startsWith("www.")) {
      hostname = hostname.slice(4);
    }

    if (
      !hostname.includes(".") ||
      hostname.length > 253 ||
      !/^[a-z0-9.-]+$/.test(hostname) ||
      hostname.split(".").some(
        (label) =>
          !label ||
          label.length > 63 ||
          label.startsWith("-") ||
          label.endsWith("-"),
      )
    ) {
      return null;
    }

    return hostname;
  } catch {
    return null;
  }
}

export type NormalizedName = {
  normalizedFounderName: string;
  firstName: string;
  lastName: string | null;
};

export function normalizeFounderName(name: string): NormalizedName | null {
  const withoutBracketedNotes = name
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ");

  const tokens = transliterate(withoutBracketedNotes)
    .replace(/[’'`\-‐‑‒–—]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  while (tokens.length > 1 && HONORIFICS.has(tokens[0])) {
    tokens.shift();
  }

  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  if (tokens.length === 0) {
    return null;
  }

  const firstName = tokens[0];
  const lastName = tokens.length > 1 ? tokens[tokens.length - 1] : null;

  return {
    normalizedFounderName: tokens.join(""),
    firstName,
    lastName,
  };
}

export function duplicateKey(
  normalizedFounderName: string,
  normalizedDomain: string,
) {
  return `${normalizedFounderName}\u0000${normalizedDomain}`;
}
