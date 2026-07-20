import "server-only";

import { hasAdminSession, isSameOrigin } from "@/lib/admin-session";

export async function authorizeAdminMutation(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  if (!(await hasAdminSession())) {
    return Response.json(
      { error: "Administrator session required." },
      { status: 401 },
    );
  }

  return null;
}

export async function authorizeAdminRead() {
  if (await hasAdminSession()) return null;
  return Response.json(
    { error: "Administrator session required." },
    { status: 401 },
  );
}
