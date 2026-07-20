import { authorizeAdminMutation, authorizeAdminRead } from "@/lib/admin-authorization";
import {
  editDiscoveryCompany,
  getDiscoveryRun,
  pauseDiscoveryRun,
  resumeDiscoveryRun,
  reviewDiscoveryCompany,
  reviewDiscoveryFounder,
  setDiscoveryFounderIncluded,
} from "@/lib/500-global/repository";
import { DiscoveryError, discoveryErrorResponse } from "@/lib/500-global/types";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const unauthorized = await authorizeAdminRead();
    if (unauthorized) return unauthorized;
    const { runId } = await context.params;
    return Response.json(await getDiscoveryRun(runId));
  } catch (error) {
    return discoveryErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const unauthorized = await authorizeAdminMutation(request);
    if (unauthorized) return unauthorized;
    const { runId } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    const action = body.action;
    if (action === "pause_run") {
      return Response.json({ progress: await pauseDiscoveryRun(runId) });
    }
    if (action === "resume_run") {
      return Response.json({ progress: await resumeDiscoveryRun(runId) });
    }
    if (action === "edit_company") {
      const companyId = requireId(body.companyId, "company");
      return Response.json({ company: await editDiscoveryCompany(runId, companyId, body) });
    }
    if (action === "review_company") {
      const companyId = requireId(body.companyId, "company");
      const decision = requireDecision(body.decision);
      await reviewDiscoveryCompany(runId, companyId, decision);
      return Response.json({ updated: true });
    }
    if (action === "review_founder") {
      const founderId = requireId(body.founderId, "founder");
      const decision = requireDecision(body.decision);
      await reviewDiscoveryFounder(runId, founderId, decision);
      return Response.json({ updated: true });
    }
    if (action === "include_founder") {
      const founderId = requireId(body.founderId, "founder");
      if (typeof body.include !== "boolean") {
        throw new DiscoveryError("Founder inclusion must be true or false.", 400);
      }
      await setDiscoveryFounderIncluded(runId, founderId, body.include);
      return Response.json({ updated: true });
    }
    throw new DiscoveryError("Unsupported review action.", 400);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }
    return discoveryErrorResponse(error);
  }
}

function requireId(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DiscoveryError(`A ${label} id is required.`, 400);
  }
  return value;
}

function requireDecision(value: unknown) {
  if (value !== "approved" && value !== "rejected") {
    throw new DiscoveryError("Decision must be approved or rejected.", 400);
  }
  return value;
}
