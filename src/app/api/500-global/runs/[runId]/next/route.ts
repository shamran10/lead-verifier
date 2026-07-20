import { authorizeAdminMutation } from "@/lib/admin-authorization";
import { processNextDiscoverySource } from "@/lib/500-global/runner";
import { discoveryErrorResponse } from "@/lib/500-global/types";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const unauthorized = await authorizeAdminMutation(request);
    if (unauthorized) return unauthorized;
    const { runId } = await context.params;
    return Response.json(await processNextDiscoverySource(runId));
  } catch (error) {
    return discoveryErrorResponse(error);
  }
}
