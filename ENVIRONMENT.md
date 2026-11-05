# StockVero environment variables

Every setting that changes between a developer's machine and a deployed server is read from the environment, never written into the code. This page lists them for the three apps, says what each does, and shows what the development `.env` files held on 5 November 2026.

- **API** (`StockVero_BE`): read when the server starts. With `NODE_ENV=production` the server **refuses to start** while a required variable is missing, and prints the missing names. In development it only warns. The check lives in `src/config/env.ts`.
- **Customer app** (`StockVero_FE`) and **admin console** (`StockVero_Admin`): read when the app is **built**. Changing a value needs a new build and deploy. These values end up in the browser, so they must never hold a secret.

Each app has a `.env.example` to copy from. Real `.env` files are git-ignored.

---

## API (`StockVero_BE`)

### Runtime

| Variable | Required | What it does | Example | Dev `.env` |
|---|---|---|---|---|
| `NODE_ENV` | Yes, in production | `production` on the deployed server. Also switches off the developer-only `/api/v1/dev` routes, so a server without it exposes them. | `production` | `development` |
| `PORT` | No (default 4000) | Port the API listens on. Most hosts (Railway) set it themselves. | `4000` | `4000` |

### Database

| Variable | Required | What it does | Example | Dev `.env` |
|---|---|---|---|---|
| `DATABASE_URL` | Yes | Connection to the PostgreSQL database (Neon), used by the running API. | `postgresql://user:pass@host/db?sslmode=require` | Set (Neon development database) |
| `DIRECT_URL` | For migrations | Direct, non-pooled connection used only by Prisma migrations (`npm run db:deploy`). Falls back to `DATABASE_URL`. | same form | Set |
| `DB_POOL_MAX` | No (default 10) | How many database connections the API keeps open. | `10` | Not set (default used) |

### Sign-in tokens

| Variable | Required | What it does | Example | Dev `.env` |
|---|---|---|---|---|
| `JWT_SECRET` | Yes | Signs the sign-in tokens of owners and staff. Changing it signs everybody out. | long random string | Set |
| `JWT_EXPIRES_IN` | No (default `7d`) | How long a sign-in lasts. | `24h` | `24h` |
| `ADMIN_JWT_SECRET` | Yes | Signs the sign-in tokens of the admin console. Must differ from `JWT_SECRET`. | long random string | Set |
| `ADMIN_JWT_EXPIRES_IN` | No (default `8h`) | How long an admin sign-in lasts. | `8h` | `8h` |
| `DEVICE_KEY_SECRET` | Recommended | Creates the key that encrypts data a phone keeps for offline work (queued sales, customer contacts). Falls back to `JWT_SECRET`. **Never change it once in use**: sales still waiting on phones could no longer be read. To add it to a server already in use, give it the same value `JWT_SECRET` has there. | long random string | **Not set** (uses `JWT_SECRET`) |

### File storage (Supabase)

| Variable | Required | What it does | Example | Dev `.env` |
|---|---|---|---|---|
| `SUPABASE_URL` | Yes | Address of the Supabase project that stores files. | `https://xxxx.supabase.co` | Set |
| `SUPABASE_KEY` | Yes | Supabase **service role** key, which lets the API upload and read files. Secret. | | Set |
| `SUPABASE_STORAGE_BUCKET` | Yes | The **public** bucket. | `solarflow-files` | `solarflow-files` |
| `SUPABASE_PRIVATE_BUCKET` | Yes | The **private** bucket. | `stockvero-private` | `stockvero-private` |

**Why two buckets.** Anyone who has a file's link can open a file in a public bucket, with no sign-in. That is right for product photos, documents attached to products, profile pictures and business logos, which appear on screens and receipts. It is wrong for identity documents. The tax certificates and national ID cards that businesses attach at signup go into the private bucket, which nobody can open by link. When an administrator views one, the API creates a link that works for a few minutes only.

Both buckets exist in the development Supabase project: `solarflow-files` is public and `stockvero-private` is private. The private bucket holds one signup document today.

**Why the public bucket is still called `solarflow-files`.** The bucket's name is part of every file link already saved in the database. Changing the variable alone would break every existing image. Renaming it properly means four steps: create the new bucket, copy the files across, rewrite the saved links, then change the variable.

### Addresses

| Variable | Required | What it does | Example | Dev `.env` |
|---|---|---|---|---|
| `CORS_ORIGINS` | Yes | The websites allowed to call the API, separated by commas: the customer app and the admin console. A browser on any other site is refused. | `https://stockvero.com,https://admin.stockvero.com` | Local addresses (`http://localhost:9000`, `:5175`, …) |
| `FRONTEND_URL` | Yes | The customer app's address. Used to build the links in emails (the **Log In Now** buttons). | `https://stockvero.com` | `http://localhost:9000` (added 5 Nov) |

### Email

The API needs one complete email provider. It tries Resend first, then SMTP.

| Variable | Required | What it does | Example | Dev `.env` |
|---|---|---|---|---|
| `RESEND_API_KEY` | Resend | Key for the Resend email service. Secret. | `re_…` | Not set |
| `RESEND_FROM` | Resend | Sender shown on emails sent through Resend. Must be on a domain verified in Resend. | `StockVero <no-reply@stockvero.com>` | Not set |
| `EMAIL_HOST` | SMTP | SMTP server. | `smtp.gmail.com` | `smtp.gmail.com` |
| `EMAIL_PORT` | No (default 587) | SMTP port. | `587` | `587` |
| `EMAIL_USER` | SMTP | SMTP account. | | Set |
| `EMAIL_PASS` | SMTP | SMTP password (for Gmail, an app password). Secret. | | Set |
| `EMAIL_FROM` | SMTP | Sender shown on emails sent through SMTP. | `StockVero <support@stockvero.com>` | **`SolarFlow Pro <ntiwa112@gmail.com>`**: emails from development go out under the old name and a personal address |

---

## Customer app (`StockVero_FE`)

| Variable | Required | What it does | Example | Dev `.env` |
|---|---|---|---|---|
| `VITE_API_URL` | Yes | The API's address, without a trailing slash. All data, sign-in and live notifications go through it. | `https://api.stockvero.com` | `http://localhost:4000` |
| `VITE_SUPPORT_EMAIL` | No (default `tiwa.ndika@digisolgroup.net`) | Support email in the sidebar's **Need help?** card. Unset or empty: the default is used. | `support@stockvero.com` | `tiwa.ndika@digisolgroup.net` (added 5 Nov) |
| `VITE_SUPPORT_WHATSAPP` | No (default `+237 652 076 871`) | Support WhatsApp number in the same card, written as it should appear. Unset or empty: the default is used. | `+237 652 076 871` | `+237 652 076 871` (added 5 Nov) |

## Admin console (`StockVero_Admin`)

| Variable | Required | What it does | Example | Dev `.env` |
|---|---|---|---|---|
| `VITE_ADMIN_API_URL` | When deployed apart from the API | The admin API's address. Unset, requests go to `/api/admin/v1` on the same site, which suits local development (the Vite proxy forwards them). | `https://api.stockvero.com/api/admin/v1` | Not set (proxy) |
| `ADMIN_API_PROXY_TARGET` | No, local development only | Where the development proxy forwards `/api` requests. Default `http://localhost:4000`. | `http://localhost:4000` | Not set |

---

## Deployment checklist

On the API server:
1. `NODE_ENV=production`.
2. `DATABASE_URL` and `DIRECT_URL` for the **production** database (not the Neon development one).
3. `JWT_SECRET`, `ADMIN_JWT_SECRET`: long, random and different from development.
4. `DEVICE_KEY_SECRET`: if the server already runs, the same value as its `JWT_SECRET`.
5. The four `SUPABASE_*` values. Both buckets must exist, and the private one must have Public switched off.
6. `CORS_ORIGINS` with the live customer app and admin console addresses.
7. `FRONTEND_URL=https://stockvero.com`.
8. One email provider, with a StockVero sender name and address.
9. Start the server. If a variable is missing, the deploy log names it.

When building the customer app: `VITE_API_URL`, `VITE_SUPPORT_EMAIL`, `VITE_SUPPORT_WHATSAPP`.

When building the admin console: `VITE_ADMIN_API_URL`.

The production server's own settings (Railway) could not be checked from here. Compare them with this list before the next deploy.
