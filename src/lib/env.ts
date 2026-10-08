import "server-only";

/** Variables the app can't boot without; named here so editors can complete them in env(). */
type RequiredEnv =
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "X_CLIENT_ID"
  | "X_CLIENT_SECRET"
  | "APP_ENCRYPTION_KEY"
  | "SESSION_SECRET";

export function env(name: RequiredEnv | string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name} — fill it in .env.local (see SETUP.md)`
    );
  }
  return value;
}

export function appUrl(): string {
  return process.env.APP_URL ?? "http://localhost:3000";
}
