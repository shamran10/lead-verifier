import "server-only";

import { duplicateKey } from "@/lib/founder-normalization";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { ParsedFounder, PreviewFounder } from "@/lib/types";

const QUERY_CHUNK_SIZE = 100;

export async function findExistingFounderKeys(founders: ParsedFounder[]) {
  const supabase = getSupabaseAdmin();
  const normalizedNames = [
    ...new Set(founders.map((founder) => founder.normalizedFounderName)),
  ];
  const keys = new Set<string>();

  for (let index = 0; index < normalizedNames.length; index += QUERY_CHUNK_SIZE) {
    const nameChunk = normalizedNames.slice(index, index + QUERY_CHUNK_SIZE);
    const { data, error } = await supabase
      .from("fev_founders")
      .select("normalized_founder_name, normalized_domain")
      .in("normalized_founder_name", nameChunk);

    if (error) {
      throw new Error(`Could not check existing founders: ${error.message}`);
    }

    for (const row of data ?? []) {
      keys.add(
        duplicateKey(row.normalized_founder_name, row.normalized_domain),
      );
    }
  }

  return keys;
}

export function classifyFounders(
  founders: ParsedFounder[],
  existingKeys: Set<string>,
): PreviewFounder[] {
  const seenKeys = new Set(existingKeys);

  return founders.map((founder) => {
    const key = duplicateKey(
      founder.normalizedFounderName,
      founder.normalizedDomain,
    );
    const status = seenKeys.has(key) ? "duplicate" : "ready";
    seenKeys.add(key);

    return { ...founder, status };
  });
}
