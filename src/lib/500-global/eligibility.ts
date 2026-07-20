import type { DiscoveryEligibilityStatus } from "@/lib/500-global/types";
import type { EligibleRegion } from "@/lib/geography";

export type LocationResolution =
  | "missing"
  | "provisional"
  | "confirmed"
  | "conflicting";

export type EligibilityInput = {
  hasUsableDomain: boolean;
  acceleratorYearAllowed: boolean;
  sourceApproved: boolean;
  locationResolution: LocationResolution;
  locationRegion: EligibleRegion | null;
  locationCountry: string | null;
  targetRegions: string[];
  hasEvidenceBackedActiveFounder: boolean;
};

export type EligibilityResult = {
  status: DiscoveryEligibilityStatus;
  reasons: string[];
};

export function evaluateDiscoveryEligibility(
  input: EligibilityInput,
): EligibilityResult {
  const reasons: string[] = [];
  if (!input.hasUsableDomain) reasons.push("Website does not contain a usable domain.");
  if (!input.acceleratorYearAllowed) reasons.push("Accelerator year is outside this run's target years.");
  if (!input.sourceApproved) reasons.push("Primary source is not approved.");

  if (input.locationResolution === "conflicting") {
    reasons.push("Headquarters/current-location evidence conflicts and requires review.");
  } else if (input.locationResolution === "missing") {
    reasons.push("Headquarters/current location is missing.");
  } else if (
    input.locationResolution === "confirmed" &&
    (!input.locationRegion || !input.targetRegions.includes(input.locationRegion))
  ) {
    return {
      status: "ineligible",
      reasons: [
        `Confirmed headquarters/current location${input.locationCountry ? ` in ${input.locationCountry}` : ""} is outside Europe and North America.`,
      ],
    };
  } else if (input.locationResolution === "provisional") {
    reasons.push("Company-owned headquarters/current-location confirmation is still required.");
  }

  if (!input.hasEvidenceBackedActiveFounder) {
    reasons.push("At least one evidence-backed active founder is required.");
  }

  return { status: reasons.length ? "needs_review" : "eligible", reasons };
}
