import "server-only";

import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "fev_admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function getSessionSigningSecret() {
  const secret =
    process.env.FEV_SESSION_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret || secret.length < 32) {
    throw new Error(
      "Configure FEV_SESSION_SECRET with at least 32 characters.",
    );
  }

  return secret;
}

function sign(value: string) {
  return createHmac("sha256", getSessionSigningSecret())
    .update(value)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function makeSessionToken() {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ expiresAt })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token: string | undefined) {
  if (!token) return false;

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) {
    return false;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { expiresAt?: unknown };
    return (
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}

export function isAdminPasswordConfigured() {
  return Boolean(process.env.FEV_ADMIN_PASSWORD);
}

export function verifyAdminPassword(password: string) {
  const expected = process.env.FEV_ADMIN_PASSWORD;
  return Boolean(expected && safeEqual(password, expected));
}

export async function hasAdminSession() {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(COOKIE_NAME)?.value);
}

export async function createAdminSession(request: Request) {
  const cookieStore = await cookies();
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  const isSecure =
    forwardedProtocol === "https" || new URL(request.url).protocol === "https:";

  cookieStore.set(COOKIE_NAME, makeSessionToken(), {
    httpOnly: true,
    sameSite: "strict",
    secure: isSecure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    priority: "high",
  });
}

export async function clearAdminSession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function authorizeCreditSpendingRequest(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  if (!(await hasAdminSession())) {
    return Response.json(
      { error: "Administrator verification session required." },
      { status: 401 },
    );
  }

  return null;
}
