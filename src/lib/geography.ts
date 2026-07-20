export type EligibleRegion = "europe" | "north_america";

export type RecognizedCountry = {
  canonicalName: string;
  iso2: string;
  region: EligibleRegion | null;
};

export type EligibleCountry = RecognizedCountry & {
  region: EligibleRegion;
};

const REGION_BY_ISO2 = new Map<string, EligibleRegion>([
  ["US", "north_america"], ["CA", "north_america"], ["MX", "north_america"],
  ...`AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO SM RS SK SI ES SE CH UA GB VA`
    .split(" ")
    .map((iso2) => [iso2, "europe"] as const),
]);

const ISO2_CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW`.split(" ");

const COUNTRY_OVERRIDES: Record<string, { canonicalName: string; aliases: string[] }> = {
  AE: { canonicalName: "United Arab Emirates", aliases: ["UAE", "U.A.E."] },
  BA: { canonicalName: "Bosnia and Herzegovina", aliases: ["Bosnia & Herzegovina"] },
  BO: { canonicalName: "Bolivia", aliases: ["Bolivia, Plurinational State of"] },
  BN: { canonicalName: "Brunei", aliases: ["Brunei Darussalam"] },
  CI: { canonicalName: "Côte d’Ivoire", aliases: ["Cote d'Ivoire", "Cote d’Ivoire", "Ivory Coast"] },
  CZ: { canonicalName: "Czechia", aliases: ["Czech Republic"] },
  GB: { canonicalName: "United Kingdom", aliases: ["UK", "U.K.", "U. K.", "Great Britain"] },
  IR: { canonicalName: "Iran", aliases: ["Iran, Islamic Republic of"] },
  KR: { canonicalName: "South Korea", aliases: ["Korea, Republic of"] },
  LA: { canonicalName: "Laos", aliases: ["Lao People's Democratic Republic"] },
  MD: { canonicalName: "Moldova", aliases: ["Republic of Moldova"] },
  MK: { canonicalName: "North Macedonia", aliases: ["Macedonia"] },
  NL: { canonicalName: "Netherlands", aliases: ["The Netherlands"] },
  PS: { canonicalName: "Palestine", aliases: ["Palestinian Territories"] },
  RU: { canonicalName: "Russia", aliases: ["Russian Federation"] },
  SY: { canonicalName: "Syria", aliases: ["Syrian Arab Republic"] },
  TR: { canonicalName: "Türkiye", aliases: ["Turkey", "Turkiye"] },
  TZ: { canonicalName: "Tanzania", aliases: ["Tanzania, United Republic of"] },
  US: { canonicalName: "United States", aliases: ["USA", "U.S.", "U. S.", "U.S.A.", "U. S. A.", "United States of America"] },
  VA: { canonicalName: "Vatican City", aliases: ["Holy See", "Vatican"] },
  VE: { canonicalName: "Venezuela", aliases: ["Venezuela, Bolivarian Republic of"] },
  VN: { canonicalName: "Vietnam", aliases: ["Viet Nam"] },
  XK: { canonicalName: "Kosovo", aliases: [] },
};

const countryByAlias = new Map<string, RecognizedCountry>();
const countryByIso2 = new Map<string, RecognizedCountry>();
const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

for (const iso2 of ISO2_CODES) {
  const override = COUNTRY_OVERRIDES[iso2];
  const displayed = displayNames.of(iso2);
  const canonicalName = override?.canonicalName ?? (displayed && displayed !== iso2 ? displayed : iso2);
  const country: RecognizedCountry = {
    canonicalName,
    iso2,
    region: REGION_BY_ISO2.get(iso2) ?? null,
  };
  countryByIso2.set(iso2, country);
  for (const alias of [canonicalName, iso2, displayed, ...(override?.aliases ?? [])]) {
    if (alias) countryByAlias.set(normalizeCountryKey(alias), country);
  }
}

export function normalizeCountryKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function resolveCountry(value: string): RecognizedCountry | null {
  const match = countryByAlias.get(normalizeCountryKey(value));
  return match ? { ...match } : null;
}

export function resolveCountryByIso2(value: string): RecognizedCountry | null {
  const match = countryByIso2.get(value.trim().toUpperCase());
  return match ? { ...match } : null;
}

export function resolveEligibleCountry(value: string): EligibleCountry | null {
  const match = resolveCountry(value);
  return match?.region ? { ...match, region: match.region } : null;
}

export function isRecognizedCountry(value: string) {
  return resolveCountry(value) !== null;
}
