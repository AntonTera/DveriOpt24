import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/routing/update-responsibles/route";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/routing/repository", () => ({
  enqueueRoutingJobs: mocks.enqueue,
  getManualShiftRequest: mocks.get
}));

const url = "https://example.test/routing/update-responsibles";
const secret = "a".repeat(64);
const expires = String(Math.floor(Date.now() / 1000) + 3600);
const code = `${expires}.${createHmac("sha256", secret).update(`dveriopt24-manual-shift-enrollment:${expires}`).digest("hex")}`;
const navigation = { "sec-fetch-user": "?1", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

function post(action: string, headers: Record<string, string> = {}) {
  return POST(new Request(url, {
    method: "POST",
    headers: { "x-dveri-shift-action": action, "sec-fetch-site": "same-origin", ...headers }
  }));
}

async function enroll() {
  const response = await post("enroll", { "x-dveri-shift-code": code });
  const cookie = response.headers.get("set-cookie")!;
  return { response, cookie, header: cookie.split(";")[0] };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRM_ROUTING_ENABLED", "true");
  vi.stubEnv("CRM_SHIFT_ROTATION_ENABLED", "true");
  vi.stubEnv("CRM_SHIFT_LINK_SECRET", secret);
});
afterEach(() => vi.unstubAllEnvs());

describe("manual shift link", () => {
  it("never queues on GET or enrollment and identifies an authenticated click for the browser", async () => {
    const { response, cookie, header } = await enroll();
    expect(response.status).toBe(200);
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(cookie).not.toContain(code);
    const click = await GET(new Request(url, { headers: { ...navigation, cookie: header } }));
    expect(await click.text()).toContain('data-authorized="true" data-auto-run="true"');
    const preview = await GET(new Request(url, { headers: { cookie: header } }));
    expect(await preview.text()).toContain('data-authorized="true" data-auto-run="false"');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("rejects anonymous, cross-site and disabled starts", async () => {
    expect((await post("enroll", { "x-dveri-shift-code": "bad" })).status).toBe(401);
    expect((await post("enroll", { "x-dveri-shift-code": secret })).status).toBe(401);
    expect((await post("start")).status).toBe(401);
    const { header } = await enroll();
    expect((await post("start", { cookie: header, "sec-fetch-site": "cross-site" })).status).toBe(403);
    vi.stubEnv("CRM_SHIFT_ROTATION_ENABLED", "false");
    expect((await post("start", { cookie: header })).status).toBe(404);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("queues an authenticated schedule check and reports no rotation if the owner matches", async () => {
    const { header } = await enroll();
    const response = await post("start", { cookie: header });
    expect(response.status).toBe(202);
    const { id } = await response.json();
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
      dedupe_key: `shift-request:${id}`,
      payload: expect.objectContaining({ kind: "shift-request", source: "manual" })
    })]);
    mocks.get.mockResolvedValue({ status: "skipped", result: { reason: "shift_owner_unchanged" } });
    expect((await GET(new Request(`${url}?run=${id}`))).status).toBe(401);
    expect(await (await GET(new Request(`${url}?run=${id}`, { headers: { cookie: header } }))).json())
      .toEqual({ status: "unchanged" });
  });
});
