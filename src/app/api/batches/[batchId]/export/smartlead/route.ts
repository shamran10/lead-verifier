import { hasAdminSession } from "@/lib/admin-session";
import {
  createSmartleadExport,
  SmartleadExportError,
} from "@/lib/smartlead-export";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  if (!(await hasAdminSession())) {
    return Response.json(
      { error: "Administrator session required for CSV export." },
      { status: 401 },
    );
  }

  try {
    const { batchId } = await context.params;
    const result = await createSmartleadExport(batchId);

    return new Response(result.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof SmartleadExportError) {
      return Response.json(
        { error: error.message },
        {
          status: error.status,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }

    return Response.json(
      { error: "Could not create the Smartlead CSV export." },
      {
        status: 500,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
