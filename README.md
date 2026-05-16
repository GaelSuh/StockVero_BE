# SolarFlow Pro Backend API

Node.js + Express + PostgreSQL + TypeScript backend for the SolarFlow Pro multi-tenant SaaS platform.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Up Environment
Copy `.env.example` to `.env` and fill in your values:
```bash
cp .env.example .env
```

Required variables:
- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: Secret key for signing JWTs
- `SUPABASE_URL` & `SUPABASE_KEY`: For file uploads

### 3. Run Migrations
```bash
npx prisma migrate deploy
```

### 4. Start Development Server
```bash
npm run dev
```

Server will run on http://localhost:3000 by default.

### 5. Check Health
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2024-03-10T12:00:00.000Z"
}
```

## Scripts

- `npm run dev` — Start dev server with hot reload (tsx watch)
- `npm run build` — Compile TypeScript to dist/
- `npm start` — Run compiled server (production)
- `npx prisma migrate dev` — Create and run migration interactively
- `npx prisma migrate deploy` — Apply pending migrations (CI/CD)
- `npx prisma studio` — Open Prisma Studio to browse/edit data

## API Routes

All endpoints prefixed with `/api/v1`.

### Authentication (No Auth Required)
- `POST /auth/signup` — Register new tenant & user
- `POST /auth/login` — Login and get JWT

### Protected Routes (Bearer Token Required)

#### Inventory
- `POST /inventory/categories` — Create category
- `GET /inventory/categories` — List categories
- `POST /inventory/products` — Create product
- `GET /inventory/products` — List products (paginated)
- `GET /inventory/products/low-stock` — Low-stock alerts

#### Customers (CRM)
- `POST /customers` — Create customer
- `GET /customers` — List (with filters)
- `GET /customers/:id` — Get details

#### Projects
- `POST /projects` — Create project (with phases & materials)
- `GET /projects` — List projects
- `POST /projects/:id/materials` — Add material
- `PATCH /projects/:id/status` — Update status (triggers transaction)

#### Finance
- `POST /finance/transactions` — Log transaction
- `GET /finance/transactions` — List ledger
- `GET /finance/summary` — Get income/expense summary
- `GET /finance/monthly/:year` — 12-month breakdown

#### Files
- `POST /files/upload` — Upload file to Supabase Storage

#### Dashboard
- `GET /dashboard/stats` — Aggregated stats (customers, projects, inventory value, revenue)

## Example Requests

### Signup
```bash
curl -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@example.com",
    "password": "SecurePass123",
    "firstName": "Jane",
    "lastName": "Smith",
    "organizationName": "Solar Power Inc.",
    "theme": {
      "primary": "#F0A500",
      "background": "#F0F9FF"
    }
  }'
```

### Login
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@example.com",
    "password": "SecurePass123"
  }'
```

Response includes `token` — use this in Authorization header:
```bash
curl -X GET http://localhost:3000/api/v1/customers \
  -H "Authorization: Bearer <token>"
```

### Create Customer
```bash
curl -X POST http://localhost:3000/api/v1/customers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "name": "City Solar",
    "email": "contact@citysolar.com",
    "phone": "+1-555-0100",
    "location": "Denver, CO",
    "status": "ACTIVE"
  }'
```

## Database Schema

See `prisma/schema.prisma` for full schema definition.

Key tables:
- **tenants** — Tenant organizations
- **users** — Application users (belong to tenant)
- **modules** — Global list of available features
- **tenant_modules** — Which modules each tenant has enabled
- **inventory_products**, **inventory_categories** — Product inventory
- **customers** — CRM contacts
- **projects**, **project_phases**, **project_materials** — Project tracking
- **transactions** — Financial ledger (single source of truth)

## Architecture

- **Middleware:** tenantGuard (auth + tenant context), moduleGuard (feature access)
- **Routes:** Validation + delegation to services
- **Services:** Business logic + Prisma queries
- **Database:** PostgreSQL with Prisma ORM

Every query includes a tenantId check — multi-tenant isolation is enforced at the API layer, not database level.

## Error Handling

All errors return JSON with `error` and `code` fields:

```json
{
  "error": "Category not found",
  "code": "NOT_FOUND"
}
```

HTTP status codes follow REST standards:
- 200 — Success (GET, PATCH, DELETE return data)
- 201 — Resource created (POST)
- 204 — No content (DELETE)
- 400 — Validation error
- 401 — Unauthorized (invalid token)
- 403 — Forbidden (module disabled)
- 404 — Not found
- 409 — Conflict (duplicate)
- 500 — Server error

## Deployment

### Build
```bash
npm run build
```

Output is in `dist/` — ready to deploy.

### Run
```bash
NODE_ENV=production npm start
```

Ensure all environment variables are set before starting.

### Docker (Optional)
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production
COPY dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

## Development

### Prisma Studio (Browse Database)
```bash
npx prisma studio
```

Opens web UI at http://localhost:5555 to view/edit records.

### Debugging
Add `LOG=*` to `.env` to see SQL queries:
```env
LOG=query,error
```

## Security Notes

- JWT Secret should be a random, strong string (min 32 chars)
- Always use HTTPS in production
- CORS is enabled — restrict domain in production
- Passwords hashed with bcrypt (10 rounds)
- All database queries parameterized by Prisma
- Module access enforced by JWT claims (active_modules array)

## Support

See `BACKEND_IMPLEMENTATION.md` for full architecture documentation.

---

Built with ❤️ for the SolarFlow Pro platform.
