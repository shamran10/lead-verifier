import type { AntlerSourceResult } from "@/lib/antler/types";

const FORBIDDEN_KEYS =
  /^(?:html|rawhtml|body|rawbody|headers|password|secret|apikey|authorization|cookie|session|token|rawpayload|braveresponse)$/i;

export function serializeAntlerSourceResult(result: AntlerSourceResult) {
  assertSafeDerivedValue(result, "source");
  return JSON.parse(JSON.stringify(result)) as AntlerSourceResult;
}

export function assertSafeDerivedValue(value: unknown, location = "value"): void {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return;
  }
  if (typeof value === "string") {
    if (/<!doctype\s+html|<html(?:\s|>)/i.test(value)) {
      throw new Error(`Raw HTML cannot be cached at ${location}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSafeDerivedValue(entry, `${location}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Unsupported cache value at ${location}.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key.replace(/[^a-z0-9]/gi, ""))) {
      throw new Error(`Unsafe cache field ${location}.${key}.`);
    }
    assertSafeDerivedValue(entry, `${location}.${key}`);
  }
}
