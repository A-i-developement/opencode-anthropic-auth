import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

// Must be called before index.mjs is imported so the module registry uses the mock
mock.module("@openauthjs/openauth/pkce", () => ({
  generatePKCE: async () => ({
    challenge: "mock-challenge",
    verifier: "mock-verifier",
    method: "S256",
  }),
}));

import { AnthropicAuthPlugin } from "./index.mjs";

// ─── constants ────────────────────────────────────────────────────────────────
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

// ─── helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

function makeOAuthAuth(overrides = {}) {
  return {
    type: "oauth",
    access: "valid-access-token",
    refresh: "valid-refresh-token",
    expires: Date.now() + 3_600_000,
    ...overrides,
  };
}

function makeProvider(extraModels = {}) {
  return {
    models: {
      "claude-3-5-sonnet": {
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      },
      ...extraModels,
    },
  };
}

function makeMockClient() {
  return {
    auth: {
      set: mock(async () => {}),
    },
  };
}

// Build a minimal upstream response with a readable body so the streaming
// transform path in the plugin is exercised.
function streamingResponse(text, status = 200) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    statusText: "OK",
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function readStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: !done });
  }
  return result;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("AnthropicAuthPlugin", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── plugin shape ────────────────────────────────────────────────────────────

  describe("plugin shape", () => {
    it("returns an object with the expected top-level keys", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      expect(typeof plugin["experimental.chat.system.transform"]).toBe("function");
      expect(plugin.auth).toBeDefined();
      expect(plugin.auth.provider).toBe("anthropic");
      expect(typeof plugin.auth.loader).toBe("function");
      expect(Array.isArray(plugin.auth.methods)).toBe(true);
    });
  });

  // ── experimental.chat.system.transform ─────────────────────────────────────

  describe("experimental.chat.system.transform", () => {
    const PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
    let transform;

    beforeEach(async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      transform = plugin["experimental.chat.system.transform"];
    });

    it("inserts the prefix as the first system item for anthropic models", () => {
      const output = { system: [] };
      transform({ model: { providerID: "anthropic" } }, output);
      expect(output.system[0]).toBe(PREFIX);
    });

    it("also prepends the prefix to the previous first system item", () => {
      const output = { system: ["Original instructions."] };
      transform({ model: { providerID: "anthropic" } }, output);
      expect(output.system[0]).toBe(PREFIX);
      expect(output.system[1]).toBe(`${PREFIX}\n\nOriginal instructions.`);
    });

    it("does not modify system when the model provider is not anthropic", () => {
      const output = { system: ["Keep me."] };
      transform({ model: { providerID: "openai" } }, output);
      expect(output.system).toEqual(["Keep me."]);
    });

    it("does not modify system when model is absent", () => {
      const output = { system: ["Keep me."] };
      transform({}, output);
      expect(output.system).toEqual(["Keep me."]);
    });

    it("does not modify system when model.providerID is absent", () => {
      const output = { system: ["Keep me."] };
      transform({ model: {} }, output);
      expect(output.system).toEqual(["Keep me."]);
    });

    it("handles an empty system array without errors", () => {
      const output = { system: [] };
      expect(() =>
        transform({ model: { providerID: "anthropic" } }, output),
      ).not.toThrow();
      expect(output.system[0]).toBe(PREFIX);
      expect(output.system.length).toBe(1);
    });
  });

  // ── auth.methods structure ──────────────────────────────────────────────────

  describe("auth.methods", () => {
    it("exposes exactly three methods", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      expect(plugin.auth.methods.length).toBe(3);
    });

    it("first method is OAuth for Claude Pro/Max", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const m = plugin.auth.methods[0];
      expect(m.label).toBe("Claude Pro/Max");
      expect(m.type).toBe("oauth");
      expect(typeof m.authorize).toBe("function");
    });

    it("second method is OAuth for API Key creation", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const m = plugin.auth.methods[1];
      expect(m.label).toBe("Create an API Key");
      expect(m.type).toBe("oauth");
      expect(typeof m.authorize).toBe("function");
    });

    it("third method is manual API key entry", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const m = plugin.auth.methods[2];
      expect(m.label).toBe("Manually enter API Key");
      expect(m.type).toBe("api");
      expect(m.provider).toBe("anthropic");
    });
  });

  // ── authorize (max mode) ────────────────────────────────────────────────────

  describe("authorize — max mode (Claude Pro/Max)", () => {
    let authorizeResult;

    beforeEach(async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      authorizeResult = await plugin.auth.methods[0].authorize();
    });

    it("returns an authorization URL, instructions, method and callback", () => {
      expect(typeof authorizeResult.url).toBe("string");
      expect(typeof authorizeResult.instructions).toBe("string");
      expect(authorizeResult.method).toBe("code");
      expect(typeof authorizeResult.callback).toBe("function");
    });

    it("uses claude.ai as the authorization host", () => {
      const url = new URL(authorizeResult.url);
      expect(url.hostname).toBe("claude.ai");
      expect(url.pathname).toBe("/oauth/authorize");
    });

    it("includes required OAuth query parameters", () => {
      const url = new URL(authorizeResult.url);
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(url.searchParams.get("scope")).toBe(
        "org:create_api_key user:profile user:inference",
      );
      expect(url.searchParams.get("code")).toBe("true");
    });

    it("includes PKCE challenge parameters", () => {
      const url = new URL(authorizeResult.url);
      expect(url.searchParams.get("code_challenge")).toBe("mock-challenge");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("uses the PKCE verifier as the state parameter", () => {
      const url = new URL(authorizeResult.url);
      expect(url.searchParams.get("state")).toBe("mock-verifier");
    });
  });

  // ── authorize (console mode) ────────────────────────────────────────────────

  describe("authorize — console mode (Create API Key)", () => {
    it("uses console.anthropic.com as the authorization host", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const result = await plugin.auth.methods[1].authorize();
      const url = new URL(result.url);
      expect(url.hostname).toBe("console.anthropic.com");
      expect(url.pathname).toBe("/oauth/authorize");
    });
  });

  // ── exchange (via callback) ─────────────────────────────────────────────────

  describe("exchange — token exchange", () => {
    async function getCallback(plugin, methodIndex = 0) {
      const result = await plugin.auth.methods[methodIndex].authorize();
      return result.callback;
    }

    it("returns success credentials on a successful token exchange", async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
      );
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const callback = await getCallback(plugin);
      const credentials = await callback("auth-code");
      expect(credentials.type).toBe("success");
      expect(credentials.access).toBe("new-access");
      expect(credentials.refresh).toBe("new-refresh");
      expect(credentials.expires).toBeGreaterThan(Date.now());
    });

    it("returns failed credentials when the token endpoint responds with an error", async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({ error: "invalid_grant" }, 400),
      );
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const callback = await getCallback(plugin);
      const credentials = await callback("bad-code");
      expect(credentials.type).toBe("failed");
    });

    it("splits the authorization code on '#' and sends the correct parts", async () => {
      let capturedBody;
      globalThis.fetch = mock(async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return jsonResponse({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
        });
      });
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const callback = await getCallback(plugin);
      await callback("auth-code#state-part");
      expect(capturedBody.code).toBe("auth-code");
      expect(capturedBody.state).toBe("state-part");
    });

    it("sends the verifier in the token exchange request body", async () => {
      let capturedBody;
      globalThis.fetch = mock(async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return jsonResponse({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
        });
      });
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const callback = await getCallback(plugin);
      await callback("code");
      expect(capturedBody.code_verifier).toBe("mock-verifier");
      expect(capturedBody.client_id).toBe(CLIENT_ID);
      expect(capturedBody.grant_type).toBe("authorization_code");
    });
  });

  // ── Create API Key method (second fetch) ────────────────────────────────────

  describe("Create API Key method — additional key-creation fetch", () => {
    it("returns success with a raw_key on successful exchange and key creation", async () => {
      let callCount = 0;
      globalThis.fetch = mock(async () => {
        callCount++;
        if (callCount === 1) {
          // token exchange
          return jsonResponse({
            access_token: "oauth-access",
            refresh_token: "oauth-refresh",
            expires_in: 3600,
          });
        }
        // key creation
        return jsonResponse({ raw_key: "sk-ant-api03-test" });
      });

      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const result = await plugin.auth.methods[1].authorize();
      const credentials = await result.callback("auth-code");

      expect(callCount).toBe(2);
      expect(credentials.type).toBe("success");
      expect(credentials.key).toBe("sk-ant-api03-test");
    });

    it("returns failed credentials immediately when token exchange fails", async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({ error: "invalid_grant" }, 400),
      );

      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const result = await plugin.auth.methods[1].authorize();
      const credentials = await result.callback("auth-code");

      expect(credentials.type).toBe("failed");
    });
  });

  // ── auth.loader ─────────────────────────────────────────────────────────────

  describe("auth.loader", () => {
    it("returns an empty object when auth type is not oauth", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const getAuth = async () => ({ type: "api_key", key: "test-key" });
      const result = await plugin.auth.loader(getAuth, makeProvider());
      expect(result).toEqual({});
    });

    it("returns an empty string apiKey when auth type is oauth", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const getAuth = async () => makeOAuthAuth();
      const result = await plugin.auth.loader(getAuth, makeProvider());
      expect(result.apiKey).toBe("");
    });

    it("zeroes out all model costs when auth is oauth", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const provider = makeProvider({
        "extra-model": {
          cost: { input: 10, output: 20, cache: { read: 1, write: 2 } },
        },
      });
      const getAuth = async () => makeOAuthAuth();
      await plugin.auth.loader(getAuth, provider);

      for (const model of Object.values(provider.models)) {
        expect(model.cost).toEqual({
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
        });
      }
    });

    it("exposes a fetch function on the returned object when oauth", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const getAuth = async () => makeOAuthAuth();
      const result = await plugin.auth.loader(getAuth, makeProvider());
      expect(typeof result.fetch).toBe("function");
    });
  });

  // ── auth.loader → fetch handler ─────────────────────────────────────────────

  describe("auth.loader — fetch handler", () => {
    async function makeAuthFetch(authOverrides = {}, clientOverrides = {}) {
      const mockClient = makeMockClient();
      Object.assign(mockClient.auth, clientOverrides);
      const plugin = await AnthropicAuthPlugin({ client: mockClient });
      const getAuth = mock(async () => makeOAuthAuth(authOverrides));
      const provider = makeProvider();
      const { fetch: authFetch } = await plugin.auth.loader(getAuth, provider);
      return { authFetch, mockClient, getAuth };
    }

    // ── non-oauth inner auth fallthrough ──────────────────────────────────────

    it("passes through to native fetch when inner getAuth returns non-oauth", async () => {
      const mockClient = makeMockClient();
      const plugin = await AnthropicAuthPlugin({ client: mockClient });
      let callCount = 0;
      const getAuth = mock(async () => {
        callCount++;
        return callCount === 1
          ? makeOAuthAuth()            // first call from loader
          : { type: "api_key" };       // second call inside fetch handler
      });
      const { fetch: authFetch } = await plugin.auth.loader(
        getAuth,
        makeProvider(),
      );
      globalThis.fetch = mock(async () =>
        jsonResponse({ id: "msg_123" }),
      );
      const resp = await authFetch("https://api.anthropic.com/v1/messages", {});
      expect(resp.ok).toBe(true);
    });

    // ── token refresh ─────────────────────────────────────────────────────────

    it("refreshes the token when access is null", async () => {
      const mockClient = makeMockClient();
      const plugin = await AnthropicAuthPlugin({ client: mockClient });
      const authState = makeOAuthAuth({ access: null, expires: 0 });
      const getAuth = async () => ({ ...authState });

      const { fetch: authFetch } = await plugin.auth.loader(
        getAuth,
        makeProvider(),
      );

      let refreshCalled = false;
      globalThis.fetch = mock(async (url, init) => {
        if (typeof url === "string" && url.includes("oauth/token")) {
          const body = JSON.parse(init.body);
          expect(body.grant_type).toBe("refresh_token");
          expect(body.refresh_token).toBe("valid-refresh-token");
          refreshCalled = true;
          return jsonResponse({
            access_token: "refreshed-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
          });
        }
        return jsonResponse({ id: "msg_123" });
      });

      await authFetch("https://api.anthropic.com/v1/messages", {});
      expect(refreshCalled).toBe(true);
      expect(mockClient.auth.set).toHaveBeenCalledTimes(1);
    });

    it("refreshes the token when the access token has expired", async () => {
      const mockClient = makeMockClient();
      const plugin = await AnthropicAuthPlugin({ client: mockClient });
      const getAuth = async () =>
        makeOAuthAuth({ access: "expired-token", expires: Date.now() - 1000 });

      const { fetch: authFetch } = await plugin.auth.loader(
        getAuth,
        makeProvider(),
      );

      let refreshCalled = false;
      globalThis.fetch = mock(async (url) => {
        if (typeof url === "string" && url.includes("oauth/token")) {
          refreshCalled = true;
          return jsonResponse({
            access_token: "fresh-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
          });
        }
        return jsonResponse({ id: "msg_123" });
      });

      await authFetch("https://api.anthropic.com/v1/messages", {});
      expect(refreshCalled).toBe(true);
    });

    it("throws when the token refresh request fails", async () => {
      const plugin = await AnthropicAuthPlugin({ client: makeMockClient() });
      const getAuth = async () =>
        makeOAuthAuth({ access: null, expires: 0 });
      const { fetch: authFetch } = await plugin.auth.loader(
        getAuth,
        makeProvider(),
      );

      globalThis.fetch = mock(async () =>
        new Response("Unauthorized", { status: 401 }),
      );

      await expect(
        authFetch("https://api.anthropic.com/v1/messages", {}),
      ).rejects.toThrow("Token refresh failed: 401");
    });

    it("does not refresh when the access token is valid", async () => {
      const { authFetch } = await makeAuthFetch();
      let refreshCalled = false;
      globalThis.fetch = mock(async (url) => {
        if (typeof url === "string" && url.includes("oauth/token")) {
          refreshCalled = true;
        }
        return jsonResponse({ id: "msg_123" });
      });

      await authFetch("https://api.anthropic.com/v1/messages", {});
      expect(refreshCalled).toBe(false);
    });

    // ── fixed headers ─────────────────────────────────────────────────────────

    it("sets the authorization header using the access token", async () => {
      const { authFetch } = await makeAuthFetch({
        access: "my-access-token",
        expires: Date.now() + 3_600_000,
      });

      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {});
      expect(sentHeaders.get("authorization")).toBe("Bearer my-access-token");
    });

    it("sets the user-agent header", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {});
      expect(sentHeaders.get("user-agent")).toBe("claude-cli/2.1.2 (external, cli)");
    });

    it("removes the x-api-key header", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        headers: { "x-api-key": "should-be-removed" },
      });
      expect(sentHeaders.get("x-api-key")).toBeNull();
    });

    // ── header merging — all three formats ────────────────────────────────────

    it("merges headers passed as a Headers instance", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      const headers = new Headers({ "x-custom": "headers-object" });
      await authFetch("https://api.anthropic.com/v1/messages", { headers });
      expect(sentHeaders.get("x-custom")).toBe("headers-object");
    });

    it("merges headers passed as an array of [key, value] pairs", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        headers: [["x-custom", "array-header"]],
      });
      expect(sentHeaders.get("x-custom")).toBe("array-header");
    });

    it("merges headers passed as a plain object", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        headers: { "x-custom": "plain-object-header" },
      });
      expect(sentHeaders.get("x-custom")).toBe("plain-object-header");
    });

    it("merges headers from an input Request object", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      const req = new Request("https://api.anthropic.com/v1/messages", {
        headers: { "x-from-request": "yes" },
      });
      await authFetch(req, {});
      expect(sentHeaders.get("x-from-request")).toBe("yes");
    });

    it("skips undefined values in array-style headers", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        headers: [["x-defined", "yes"], ["x-undef", undefined]],
      });
      expect(sentHeaders.get("x-defined")).toBe("yes");
      expect(sentHeaders.get("x-undef")).toBeNull();
    });

    // ── anthropic-beta header ─────────────────────────────────────────────────

    it("always includes required beta flags", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {});
      const betas = sentHeaders.get("anthropic-beta").split(",").map((b) => b.trim());
      expect(betas).toContain("oauth-2025-04-20");
      expect(betas).toContain("interleaved-thinking-2025-05-14");
    });

    it("preserves incoming beta flags alongside required ones", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        headers: { "anthropic-beta": "my-custom-beta-2025-01-01" },
      });
      const betas = sentHeaders.get("anthropic-beta").split(",").map((b) => b.trim());
      expect(betas).toContain("my-custom-beta-2025-01-01");
      expect(betas).toContain("oauth-2025-04-20");
    });

    it("deduplicates beta flags", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentHeaders;
      globalThis.fetch = mock(async (_url, init) => {
        sentHeaders = init.headers;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        headers: { "anthropic-beta": "oauth-2025-04-20" },
      });
      const betas = sentHeaders.get("anthropic-beta").split(",").map((b) => b.trim());
      const oauthBetaCount = betas.filter((b) => b === "oauth-2025-04-20").length;
      expect(oauthBetaCount).toBe(1);
    });

    // ── URL modification ──────────────────────────────────────────────────────

    it("appends beta=true to /v1/messages URLs", async () => {
      const { authFetch } = await makeAuthFetch();
      let calledUrl;
      globalThis.fetch = mock(async (url) => {
        calledUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {});
      expect(calledUrl).toContain("beta=true");
    });

    it("does not add beta=true to non-/v1/messages paths", async () => {
      const { authFetch } = await makeAuthFetch();
      let calledUrl;
      globalThis.fetch = mock(async (url) => {
        calledUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/models", {});
      expect(calledUrl).not.toContain("beta=true");
    });

    it("does not add beta=true when the beta param is already present", async () => {
      const { authFetch } = await makeAuthFetch();
      let calledUrl;
      globalThis.fetch = mock(async (url) => {
        calledUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages?beta=false", {});
      const parsed = new URL(calledUrl);
      const betaValues = parsed.searchParams.getAll("beta");
      expect(betaValues.length).toBe(1);
      expect(betaValues[0]).toBe("false");
    });

    it("applies URL modification when input is a Request object for /v1/messages", async () => {
      const { authFetch } = await makeAuthFetch();
      let calledUrl;
      globalThis.fetch = mock(async (url) => {
        calledUrl = url instanceof Request ? url.url : url.toString();
        return streamingResponse("");
      });

      const req = new Request("https://api.anthropic.com/v1/messages");
      await authFetch(req, {});
      expect(calledUrl).toContain("beta=true");
    });

    // ── body transformation ───────────────────────────────────────────────────

    it("sanitises 'OpenCode' strings in system prompts", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentBody;
      globalThis.fetch = mock(async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        body: JSON.stringify({
          system: [{ type: "text", text: "OpenCode is great. Use opencode." }],
        }),
      });

      expect(sentBody.system[0].text).toBe("Claude Code is great. Use Claude.");
    });

    it("preserves non-text system blocks unchanged", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentBody;
      globalThis.fetch = mock(async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return streamingResponse("");
      });

      const nonTextBlock = { type: "image", source: { type: "url", url: "http://x" } };
      await authFetch("https://api.anthropic.com/v1/messages", {
        body: JSON.stringify({ system: [nonTextBlock] }),
      });

      expect(sentBody.system[0]).toEqual(nonTextBlock);
    });

    it("prefixes tool names with 'mcp_'", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentBody;
      globalThis.fetch = mock(async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        body: JSON.stringify({
          tools: [
            { name: "bash", description: "run bash" },
            { name: "read_file", description: "read a file" },
          ],
        }),
      });

      expect(sentBody.tools[0].name).toBe("mcp_bash");
      expect(sentBody.tools[1].name).toBe("mcp_read_file");
    });

    it("prefixes tool_use block names in messages with 'mcp_'", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentBody;
      globalThis.fetch = mock(async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        body: JSON.stringify({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "tu_01", name: "bash", input: {} },
                { type: "text", text: "hello" },
              ],
            },
          ],
        }),
      });

      expect(sentBody.messages[0].content[0].name).toBe("mcp_bash");
      expect(sentBody.messages[0].content[1].text).toBe("hello");
    });

    it("preserves tool description and other fields when prefixing", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentBody;
      globalThis.fetch = mock(async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return streamingResponse("");
      });

      await authFetch("https://api.anthropic.com/v1/messages", {
        body: JSON.stringify({
          tools: [{ name: "bash", description: "run bash", input_schema: {} }],
        }),
      });

      expect(sentBody.tools[0].description).toBe("run bash");
      expect(sentBody.tools[0].input_schema).toEqual({});
    });

    it("passes through invalid JSON body without modification", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentBody;
      globalThis.fetch = mock(async (_url, init) => {
        sentBody = init.body;
        return streamingResponse("");
      });

      const badJson = "not-json";
      await authFetch("https://api.anthropic.com/v1/messages", {
        body: badJson,
      });

      expect(sentBody).toBe(badJson);
    });

    it("passes through non-string body without modification", async () => {
      const { authFetch } = await makeAuthFetch();
      let sentInit;
      globalThis.fetch = mock(async (_url, init) => {
        sentInit = init;
        return streamingResponse("");
      });

      const bodyBuffer = new Uint8Array([1, 2, 3]);
      await authFetch("https://api.anthropic.com/v1/messages", {
        body: bodyBuffer,
      });

      expect(sentInit.body).toBe(bodyBuffer);
    });

    // ── streaming response transformation ────────────────────────────────────

    it("strips the 'mcp_' prefix from tool names in the streaming response", async () => {
      const { authFetch } = await makeAuthFetch();
      globalThis.fetch = mock(async () =>
        streamingResponse(
          'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tu_01","name":"mcp_bash"}}\n',
        ),
      );

      const response = await authFetch("https://api.anthropic.com/v1/messages", {});
      const text = await readStream(response);
      expect(text).toContain('"name": "bash"');
      expect(text).not.toContain("mcp_bash");
    });

    it("strips 'mcp_' from multiple tool names in a single chunk", async () => {
      const { authFetch } = await makeAuthFetch();
      const chunk =
        '{"name":"mcp_bash"} {"name":"mcp_read_file"} {"name":"other"}';
      globalThis.fetch = mock(async () => streamingResponse(chunk));

      const response = await authFetch("https://api.anthropic.com/v1/messages", {});
      const text = await readStream(response);
      // mcp_-prefixed names get the prefix stripped (regex emits a space after the colon)
      expect(text).toContain('"name": "bash"');
      expect(text).toContain('"name": "read_file"');
      // non-prefixed names are untouched by the regex (no added space)
      expect(text).toContain('"name":"other"');
    });

    it("preserves the original response status and headers", async () => {
      const { authFetch } = await makeAuthFetch();
      globalThis.fetch = mock(async () =>
        new Response(
          new ReadableStream({
            start(c) { c.close(); },
          }),
          {
            status: 206,
            statusText: "Partial Content",
            headers: { "x-request-id": "req_abc" },
          },
        ),
      );

      const response = await authFetch("https://api.anthropic.com/v1/messages", {});
      expect(response.status).toBe(206);
      expect(response.headers.get("x-request-id")).toBe("req_abc");
    });

    it("returns the response directly when the body is null", async () => {
      const { authFetch } = await makeAuthFetch();
      const noBodyResponse = new Response(null, { status: 204 });
      globalThis.fetch = mock(async () => noBodyResponse);

      const response = await authFetch("https://api.anthropic.com/v1/messages", {});
      expect(response.status).toBe(204);
    });
  });
});
