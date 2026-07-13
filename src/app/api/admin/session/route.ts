import {
  clearAdminSession,
  createAdminSession,
  isAdminPasswordConfigured,
  isSameOrigin,
  verifyAdminPassword,
} from "@/lib/admin-session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  if (!isAdminPasswordConfigured()) {
    return Response.json(
      { error: "FEV_ADMIN_PASSWORD is not configured on the server." },
      { status: 503 },
    );
  }

  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!verifyAdminPassword(password)) {
    return Response.json({ error: "Incorrect administrator password." }, { status: 401 });
  }

  await createAdminSession(request);
  return Response.json({ authenticated: true });
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  await clearAdminSession();
  return new Response(null, { status: 204 });
}
