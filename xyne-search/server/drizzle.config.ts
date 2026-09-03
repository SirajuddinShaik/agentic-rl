import { defineConfig } from "drizzle-kit"

// Schema is the modular barrel under platform/db/schema. DB target comes from
// DATABASE_URL (the same connection the app uses) so drizzle-kit generate/migrate
// operate on the real database — not a stale hardcoded host/port.
export default defineConfig({
  dialect: "postgresql",
  schema: "./platform/db/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      `postgres://xyne:xyne@${process.env.DATABASE_HOST ?? "localhost"}:5432/xyne`,
  },
})
