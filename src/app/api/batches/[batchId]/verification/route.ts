import { authorizeCreditSpendingRequest } from "@/lib/admin-session";
import {
  getVerificationProgress,
  startBatchVerification,
  VerificationStateError,
} from "@/lib/verification";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (error instanceof VerificationStateError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json(
    { error: "Internal server error." },
    { status: 500 },
  );
}

export async function GET(
  _request: Request,
  context: RouteContext<"/api/batches/[batchId]/verification">,
) {
  try {
    const { batchId } = await context.params;
    return Response.json(await getVerificationProgress(batchId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/batches/[batchId]/verification">,
) {
  try {
    const unauthorized = await authorizeCreditSpendingRequest(request);
    if (unauthorized) return unauthorized;

    const { batchId } = await context.params;
    return Response.json(await startBatchVerification(batchId));
  } catch (error) {
    return errorResponse(error);
  }
}
