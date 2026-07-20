import { authorizeAdminMutation } from "@/lib/admin-authorization";
import {
  addDiscoverySource,
  recordRejectedSource,
} from "@/lib/500-global/repository";
import { discoveryErrorResponse } from "@/lib/500-global/types";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  let authorizedRunId: string | null = null;
  try {
    const unauthorized = await authorizeAdminMutation(request);
    if (unauthorized) return unauthorized;
    const { runId } = await context.params;
    authorizedRunId = runId;
    const body = await request.json();
    const source = await addDiscoverySource(runId, body);
    return Response.json({ source }, { status: 201 });
  } catch (error) {
    if (authorizedRunId) await recordRejectedSource(authorizedRunId);
    if (error instanceof SyntaxError) {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
    return discoveryErrorResponse(error);
  }
}
