import {
  resolveCountry,
  resolveCountryByIso2,
  type EligibleRegion,
} from "@/lib/geography";

export type ResolvedMassChallengeRosterLocation = {
  listedLocation: string;
  canonicalCountry: string;
  countryIso2: string;
  region: EligibleRegion | null;
  confidence: number;
  matchedBy: "country" | "city_country" | "us_state" | "canadian_province";
};

const US_STATE_CODES = new Set(`AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC`.split(" "));
const CANADIAN_PROVINCE_CODES = new Set(
  `AB BC MB NB NL NS NT NU ON PE QC SK YT`.split(" "),
);
const US_STATE_NAMES = new Set(
  `Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia`
    .split("|")
    .map(normalizeSubdivision),
);
const CANADIAN_PROVINCE_NAMES = new Set(
  `Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland and Labrador|Nova Scotia|Ontario|Prince Edward Island|Quebec|Saskatchewan|Northwest Territories|Nunavut|Yukon`
    .split("|")
    .map(normalizeSubdivision),
);

export function resolveMassChallengeRosterLocation(
  value: string | null | undefined,
): ResolvedMassChallengeRosterLocation | null {
  const listedLocation = cleanLocation(value ?? "");
  if (!listedLocation) return null;
  const directCountry = resolveCountry(listedLocation);
  if (directCountry) {
    return resolved(listedLocation, directCountry.iso2, 0.98, "country");
  }

  const segments = listedLocation.split(",").map((part) => part.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  const last = segments.at(-1)!;
  if (segments.length === 2 && isUsState(last)) {
    return resolved(listedLocation, "US", 0.96, "us_state");
  }
  if (segments.length === 2 && isCanadianProvince(last)) {
    return resolved(listedLocation, "CA", 0.96, "canadian_province");
  }
  const finalCountry = resolveCountry(last);
  if (finalCountry) {
    const subdivision = segments.at(-2) ?? "";
    if (finalCountry.iso2 === "US" && isUsState(subdivision)) {
      return resolved(listedLocation, "US", 0.97, "us_state");
    }
    if (finalCountry.iso2 === "CA" && isCanadianProvince(subdivision)) {
      return resolved(listedLocation, "CA", 0.97, "canadian_province");
    }
    return resolved(listedLocation, finalCountry.iso2, 0.94, "city_country");
  }

  return null;
}

export function extractMassChallengeRosterLocation(
  value: string | null | undefined,
) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const candidates = [
    text.match(/^\s*\(([^)]{2,120})\)\s*:?(?:\s|$)/)?.[1],
    text.match(/\b(?:location|headquarters|hq)\s*:\s*([^|•;–—]{2,120})/i)?.[1],
    text.match(/\bbased\s+in\s+([^|•;–—.]{2,120})/i)?.[1],
  ];
  for (const candidate of candidates) {
    const resolvedLocation = resolveMassChallengeRosterLocation(candidate);
    if (resolvedLocation) return resolvedLocation;
  }
  return null;
}

function isUsState(value: string) {
  const upper = value.trim().toUpperCase().replace(/\./g, "");
  return US_STATE_CODES.has(upper) || US_STATE_NAMES.has(normalizeSubdivision(value));
}

function isCanadianProvince(value: string) {
  const upper = value.trim().toUpperCase().replace(/\./g, "");
  return (
    CANADIAN_PROVINCE_CODES.has(upper) ||
    CANADIAN_PROVINCE_NAMES.has(normalizeSubdivision(value))
  );
}

function resolved(
  listedLocation: string,
  iso2: string,
  confidence: number,
  matchedBy: ResolvedMassChallengeRosterLocation["matchedBy"],
): ResolvedMassChallengeRosterLocation {
  const country = resolveCountryByIso2(iso2);
  if (!country) throw new Error(`Unsupported roster country: ${iso2}`);
  return {
    listedLocation,
    canonicalCountry: country.canonicalName,
    countryIso2: country.iso2,
    region: country.region,
    confidence,
    matchedBy,
  };
}

function cleanLocation(value: string) {
  return value
    .replace(/^\s*[([]\s*/, "")
    .replace(/\s*[)\]]\s*:?.*$/, "")
    .replace(/^\s*(?:location|headquarters|hq)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeSubdivision(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
