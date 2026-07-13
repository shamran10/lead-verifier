import { connection } from "next/server";

import { BatchTable } from "@/components/batch-table";
import { getRecentBatches } from "@/lib/queries";

export const metadata = { title: "Batches" };

export default async function BatchesPage() {
  await connection();

  let batches;
  try {
    batches = await getRecentBatches(100);
  } catch (error) {
    return (
      <div className="alert alert-error">
        <strong>Batch data is unavailable.</strong>{" "}
        {error instanceof Error ? error.message : "Check Supabase and try again."}
      </div>
    );
  }

  return (
    <div>
      <p className="eyebrow">Imports</p>
      <h1 className="page-title">Batches</h1>
      <p className="page-description mb-8">
        Review parsed workbooks and their extracted founder candidates.
      </p>
      <BatchTable batches={batches} />
    </div>
  );
}
