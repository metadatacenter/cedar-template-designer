import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";
const source = await readFile(
  new URL("../app/scripts/handlers/KeycloakUserHandler.js", import.meta.url),
  "utf8",
);
function setup() {
  const calls = { errors: [] };
  const keycloak = {
    init: async (options) => {
      calls.init = options;
      return true;
    },
    logout: async (options) => {
      calls.logout = options;
    },
    updateToken: async (seconds) => {
      calls.seconds = seconds;
      return true;
    },
    token: "test-token",
    tokenParsed: { sub: "test" },
  };
  const context = {
    console: { error: (...args) => calls.errors.push(args) },
    window: {
      cedarAuthUrl: "https://auth.example/",
      location: { origin: "https://workspace.example" },
    },
    Keycloak: (options) => {
      calls.options = options;
      return keycloak;
    },
  };
  vm.runInNewContext(source, context);
  return { handler: new context.KeycloakUserHandler(), calls, keycloak };
}
test("auth URL trims the slash and silent SSO stays on the host origin", async () => {
  const { handler, calls } = setup();
  let authenticated;
  await handler.initUserHandler(
    (value) => (authenticated = value),
    () => assert.fail(),
  );
  assert.equal(authenticated, true);
  assert.equal(calls.options.url, "https://auth.example");
  assert.equal(
    calls.init.silentCheckSsoRedirectUri,
    "https://workspace.example/silent-check-sso.html",
  );
});
test("refresh failure reaches the host instead of silently continuing", async () => {
  const { handler, keycloak } = setup();
  keycloak.updateToken = async () => {
    throw new Error("expired");
  };
  let failed = false;
  await handler.refreshToken(
    30,
    () => assert.fail(),
    () => (failed = true),
  );
  assert.equal(failed, true);
});
test("initialization retains the original adapter failure in diagnostics and the callback", async () => {
  const { handler, keycloak, calls } = setup();
  const error = new Error("Timeout when waiting for 3rd party check iframe message.");
  keycloak.init = async () => { throw error; };
  let received;
  await handler.initUserHandler(() => assert.fail(), value => { received = value; });
  assert.equal(received, error);
  assert.deepEqual(calls.errors, [["CEDAR authentication initialization failed", error]]);
  assert.equal(JSON.stringify(calls.errors).includes(keycloak.token), false);
});
