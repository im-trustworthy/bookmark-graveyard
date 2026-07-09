import { cookies } from "next/headers";
import { sign, verifySignature } from "./crypto";

const COOKIE = "bb_session";

export async function setSession(userId: string) {
  const jar = await cookies();
  jar.set(COOKIE, `${userId}.${sign(userId)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function getSessionUserId(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const userId = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  return verifySignature(userId, signature) ? userId : null;
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(COOKIE);
}
