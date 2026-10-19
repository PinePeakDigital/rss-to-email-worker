import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          MAILGUN_API_KEY: "test-key",
          TURNSTILE_SECRET: "test-secret",
          // wrangler.jsonc holds the real deployment's values, so the vars the assertions depend on
          // are pinned here instead: editing the deployment's config shouldn't fail the suite.
          BATCH_SIZE: 1, // one message per recipient, so a call count is a recipient count
          SITE_URL: "https://example.com", // the host Turnstile tokens are accepted from
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
}));
