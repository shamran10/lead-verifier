import { processNextCompanyEnrichment } from "@/lib/500-global/enrichment";
import { discoveryErrorResponse } from "@/lib/500-global/types";
import { authorizeAdminMutation } from "@/lib/admin-authorization";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const unauthorized = await authorizeAdminMutation(request);
    if (unauthorized) return unauthorized;
    const { runId } = await context.params;
    return Response.json(await processNextCompanyEnrichment(runId));
  } catch (error) {
    return discoveryErrorResponse(error);
  }
}
