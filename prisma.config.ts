import path from 'path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

const rootDir = process.cwd();

// Prisma config does not auto-load .env files, so we do it here.
// Load .env.example as defaults (no override), then .env/.env.local can override.
loadEnv({ path: path.join(rootDir, '.env.example') });
loadEnv({ path: path.join(rootDir, '.env'), override: true });
loadEnv({ path: path.join(rootDir, '.env.local'), override: true });

// Prisma v7 no longer supports directUrl in schema. Prefer DIRECT_URL for CLI ops.
const databaseUrl = (process.env.DIRECT_URL ?? process.env.DATABASE_URL)?.trim();
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is required. Create a .env (or .env.local) file in the project root.'
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    provider: 'postgresql',
    url: databaseUrl,
  },
});
