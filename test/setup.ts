import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/send";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
