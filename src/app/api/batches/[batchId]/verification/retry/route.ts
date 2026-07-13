import { authorizeCreditSpendingRequest } from "@/lib/admin-session";
import {
  retryFailedVerification,
  VerificationStateError,
} from "@/lib/verification";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  request: Request,
  context: RouteContext<"/api/batches/[batchId]/verification/retry">,
) {
  const unauthorized = await authorizeCreditSpendingRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const { batchId } = await context.params;
    return Response.json(await retryFailedVerification(batchId));
  } catch (error) {
    if (error instanceof VerificationStateError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not retry the failed verification.",
      },
      { status: 500 },
    );
  }
}
