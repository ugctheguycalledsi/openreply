import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMissingInstagramOAuthEnv,
  isUnifiedLoginMode,
} from "@/lib/env";
import {
  exchangeUnifiedCodeForToken,
  getAuthorizationUrl,
} from "@/lib/meta/oauth";
import {
  getUserInfo,
  getUserMedia,
  listAssignedInstagramAccounts,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("unified login mode switch", () => {
  it("stays in Instagram Business Login when the config id is unset", () => {
    expect(isUnifiedLoginMode()).toBe(false);
    vi.stubEnv("FACEBOOK_LOGIN_CONFIG_ID", "   ");
    expect(isUnifiedLoginMode()).toBe(false);
    expect(getMissingInstagramOAuthEnv()).toEqual([
      "INSTAGRAM_APP_ID",
      "INSTAGRAM_APP_SECRET",
    ]);
  });

  it("switches to Facebook Login for Business when the config id is set", () => {
    vi.stubEnv("FACEBOOK_LOGIN_CONFIG_ID", "config-1");
    vi.stubEnv("FACEBOOK_APP_SECRET", "fb-secret");
    expect(isUnifiedLoginMode()).toBe(true);
    expect(getMissingInstagramOAuthEnv()).toEqual(["FACEBOOK_APP_ID"]);
  });
});

describe("authorization URL", () => {
  it("keeps the Instagram Login URL and scopes in legacy mode", () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "ig-app");
    const url = new URL(getAuthorizationUrl("https://app.example/api/instagram/callback", "state-1"));
    expect(url.origin).toBe("https://www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("ig-app");
    expect(url.searchParams.get("scope")).toContain("instagram_business_manage_messages");
    expect(url.searchParams.has("config_id")).toBe(false);
  });

  it("builds a Facebook dialog URL with config_id and no scope", () => {
    vi.stubEnv("FACEBOOK_LOGIN_CONFIG_ID", "config-1");
    vi.stubEnv("FACEBOOK_APP_ID", "fb-app");
    const url = new URL(getAuthorizationUrl("https://app.example/api/instagram/callback", "state-1"));
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("fb-app");
    expect(url.searchParams.get("config_id")).toBe("config-1");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("unified token exchange", () => {
  it("reads the Facebook Graph code exchange and keeps a missing expiry", async () => {
    vi.stubEnv("FACEBOOK_APP_ID", "fb-app");
    vi.stubEnv("FACEBOOK_APP_SECRET", "fb-secret");
    vi.stubEnv("FACEBOOK_LOGIN_CONFIG_ID", "config-1");
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "suat" }));
    await expect(
      exchangeUnifiedCodeForToken("code-1", "https://app.example/api/instagram/callback")
    ).resolves.toEqual({ accessToken: "suat" });
    const called = new URL(fetchMock.mock.calls[0][0]);
    expect(called.origin).toBe("https://graph.facebook.com");
    expect(called.pathname).toBe("/v25.0/oauth/access_token");
    expect(called.searchParams.get("client_id")).toBe("fb-app");
    expect(called.searchParams.get("client_secret")).toBe("fb-secret");
    expect(called.searchParams.get("code")).toBe("code-1");
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
  });

  it("returns expires_in when Meta sends one", async () => {
    vi.stubEnv("FACEBOOK_APP_ID", "fb-app");
    vi.stubEnv("FACEBOOK_APP_SECRET", "fb-secret");
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "suat", expires_in: 3600 }));
    await expect(
      exchangeUnifiedCodeForToken("code-1", "https://app.example/cb")
    ).resolves.toEqual({ accessToken: "suat", expiresIn: 3600 });
  });
});

describe("Graph calls", () => {
  it("keeps Instagram Login profile and media calls on /me", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "ig", username: "brand" }));
    await getUserInfo("token");
    expect(fetchMock.mock.calls[0][0]).toContain("https://graph.instagram.com/v25.0/me?");
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await getUserMedia("token", "ig-user", 5);
    expect(fetchMock.mock.calls[1][0]).toContain("https://graph.instagram.com/v25.0/me/media?");
  });

  it("calls graph.facebook.com/{ig-id} in unified mode and subscribes to postbacks", async () => {
    vi.stubEnv("FACEBOOK_LOGIN_CONFIG_ID", "config-1");
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "1789", username: "brand" }));
    await getUserInfo("token", "1789");
    expect(fetchMock.mock.calls[0][0]).toContain("https://graph.facebook.com/v25.0/1789?");
    expect(fetchMock.mock.calls[0][0]).not.toContain("user_id");

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: "media" }] }));
    await expect(getUserMedia("token", "1789", 3)).resolves.toEqual([{ id: "media" }]);
    expect(fetchMock.mock.calls[1][0]).toContain("https://graph.facebook.com/v25.0/1789/media?");

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await subscribeInstagramAccountToWebhooks("1789", "token");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://graph.facebook.com/v25.0/1789/subscribed_apps"
    );
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).subscribed_fields).toEqual([
      "comments",
      "messages",
      "messaging_postbacks",
    ]);
  });

  it("pages through assigned Instagram accounts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: "1", username: "one" }],
      paging: { next: "https://graph.facebook.com/v25.0/me/assigned_instagram_accounts?after=cursor" },
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: "2", username: "two" }, { id: "1", username: "one" }],
    }));
    await expect(listAssignedInstagramAccounts("token")).resolves.toEqual([
      { id: "1", username: "one" },
      { id: "2", username: "two" },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/me/assigned_instagram_accounts");
    expect(String(fetchMock.mock.calls[0][0])).toContain("fields=id%2Cusername");
  });

  it("leaves legacy webhook subscription on comments and messages", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await subscribeInstagramAccountToWebhooks("1789", "token");
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://graph.instagram.com/");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).subscribed_fields).toEqual([
      "comments",
      "messages",
    ]);
  });
});
