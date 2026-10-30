import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { POST as gateRoute } from "@/app/api/gate/route";
import GatePage from "@/app/gate/page";
import { sign } from "@/lib/crypto";
import { formPost } from "./oauth-fixtures";

// The password wall keeps the path the proxy blocked (`next`), so a flow that
// started elsewhere (OAuth sign-in for an assistant) survives the wall. Only a
// path on this app is honored; anything else lands on /.

const APP = "http://localhost:3000"; // APP_URL in setup.ts
const PASSWORD = "correct horse";

const submit = (fields: Record<string, string>) => gateRoute(formPost(`${APP}/api/gate`, fields));
const gateCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("bb_gate="));

async function renderGate(searchParams: Record<string, string | string[]>): Promise<string> {
  return renderToStaticMarkup(await GatePage({ searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  vi.stubEnv("GATE_PASSWORD", PASSWORD);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/gate", () => {
  it("returns to a valid next after the right password, with the gate cookie", async () => {
    const next = "/api/auth/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Dabc%26state%3Dx";
    const res = await submit({ password: PASSWORD, next });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP}${next}`);
    expect(gateCookie(res)).toContain(`bb_gate=${sign("gate-ok")}`);
  });

  it("goes to / without next", async () => {
    const res = await submit({ password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${APP}/`);
    expect(gateCookie(res)).toBeDefined();
  });

  it.each(["//evil.example", "https://evil.example/x", "/a\\b", "javascript:alert(1)", "oauth/authorize"])(
    "refuses next=%j and goes to /",
    async (next) => {
      const res = await submit({ password: PASSWORD, next });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${APP}/`);
      expect(gateCookie(res)).toBeDefined();
    }
  );

  it("keeps a valid next across a wrong password, and sets no cookie", async () => {
    const next = "/oauth/authorize?x=1";
    const res = await submit({ password: "wrong", next });
    expect(res.status).toBe(303);
    const target = new URL(res.headers.get("location")!);
    expect(`${target.origin}${target.pathname}`).toBe(`${APP}/gate`);
    expect(target.searchParams.get("error")).toBe("1");
    expect(target.searchParams.get("next")).toBe(next);
    expect(gateCookie(res)).toBeUndefined();
  });

  it("drops an invalid next on a wrong password", async () => {
    const res = await submit({ password: "wrong", next: "//evil.example" });
    expect(res.headers.get("location")).toBe(`${APP}/gate?error=1`);
  });
});

describe("the /gate page", () => {
  it("carries a valid next in the form", async () => {
    const html = await renderGate({ next: "/oauth/authorize?x=1&y=2" });
    expect(html).toContain('<input type="hidden" name="next" value="/oauth/authorize?x=1&amp;y=2"/>');
  });

  const invalid: Record<string, string | string[]>[] = [
    {},
    { next: "//evil.example" },
    { next: "https://evil.example" },
    { next: ["/a", "/b"] },
  ];
  it.each(invalid)(
    "carries no next for %j",
    async (searchParams) => {
      expect(await renderGate(searchParams)).not.toContain('name="next"');
    }
  );
});
