import { authorizeCreditSpendingRequest } from "@/lib/admin-session";
import {
  processNextCandidate,
  VerificationStateError,
} from "@/lib/verification";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  request: Request,
  context: RouteContext<"/api/batches/[batchId]/verification/next">,
) {
  const unauthorized = await authorizeCreditSpendingRequest(request);
  if (unauthorized) return unauthorized;

  try {
    const { batchId } = await context.params;
    return Response.json(await processNextCandidate(batchId));
  } catch (error) {
    if (error instanceof VerificationStateError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not process the next verification candidate.",
      },
      { status: 500 },
    );
  }
}
