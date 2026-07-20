import { authorizeAdminMutation, authorizeAdminRead } from "@/lib/admin-authorization";
import { createDiscoveryRun, listDiscoveryRuns } from "@/lib/500-global/repository";
import { discoveryErrorResponse } from "@/lib/500-global/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const unauthorized = await authorizeAdminRead();
    if (unauthorized) return unauthorized;
    return Response.json({ runs: await listDiscoveryRuns() });
  } catch (error) {
    return discoveryErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const unauthorized = await authorizeAdminMutation(request);
    if (unauthorized) return unauthorized;
    const body = await request.json();
    const run = await createDiscoveryRun(body);
    return Response.json({ run }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
    return discoveryErrorResponse(error);
  }
}
