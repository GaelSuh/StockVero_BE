import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import inventoryRoutes from './routes/inventory.js';
import crmRoutes from './routes/crm.js';
import projectsRoutes from './routes/projects.js';
import financeRoutes from './routes/finance.js';
import filesRoutes from './routes/files.js';
import dashboardRoutes from './routes/dashboard.js';
import tenantsRoutes from './routes/tenants.js';
import rolesRoutes from './routes/roles.js';
import employeesRoutes from './routes/employees.js';
import { swaggerSpec } from './config/swagger.js';
import adminRoutes from './routes/admin/index.js';
import analyticsRoutes from './routes/analytics.js';
import notificationsRoutes from './routes/notifications.js';
import documentsRoutes from './routes/documents.js';
import invoicesRoutes from './routes/invoices.js';
import auditRoutes from './routes/audit.js';
import devRoutes from './routes/dev.js';
import { startCronJobs } from './services/scheduler.js';
const app = express();
const port = process.env.PORT || 4000;
// Trust the first hop from Railway/Render's reverse proxy so that
// express-rate-limit reads the real client IP from X-Forwarded-For
// instead of treating every user as the same proxy IP.
app.set('trust proxy', 1);
// ── Security Headers ──────────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false, // CSP managed by frontend hosts
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false, // Allow cross-origin image/file loading
}));
// ── Compression ───────────────────────────────────────────────────────────────
app.use(compression());
// ── Rate Limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 attempts per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.' },
});
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 200, // 200 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
});
// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:5175'];
app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/inventory', apiLimiter, inventoryRoutes);
app.use('/api/v1/crm', apiLimiter, crmRoutes);
app.use('/api/v1/projects', apiLimiter, projectsRoutes);
app.use('/api/v1/finance', apiLimiter, financeRoutes);
app.use('/api/v1/files', apiLimiter, filesRoutes);
app.use('/api/v1/dashboard', apiLimiter, dashboardRoutes);
app.use('/api/v1/tenants', apiLimiter, tenantsRoutes);
app.use('/api/v1/roles', apiLimiter, rolesRoutes);
app.use('/api/v1/employees', apiLimiter, employeesRoutes);
app.use('/api/v1/analytics', apiLimiter, analyticsRoutes);
// [PAYMENT_DISABLED] - Restore when payment integration is ready
// app.use('/api/v1/billing', apiLimiter, billingRoutes);
app.use('/api/v1/notifications', apiLimiter, notificationsRoutes);
app.use('/api/v1/documents', apiLimiter, documentsRoutes);
app.use('/api/v1/invoices', apiLimiter, invoicesRoutes);
app.use('/api/v1/audit', apiLimiter, auditRoutes);
app.use('/api/admin/v1', authLimiter, adminRoutes);
if (process.env.NODE_ENV !== 'production') {
    app.use('/api/v1/dev', devRoutes);
}
app.get('/health', async (req, res) => {
    try {
        const { prisma } = await import('./db.js');
        await prisma.$queryRaw `SELECT 1`;
        res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
    }
    catch {
        res.status(503).json({ status: 'degraded', db: 'disconnected', timestamp: new Date().toISOString() });
    }
});
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});
app.use(errorHandler);
const server = app.listen(port, () => {
    console.log(`[server] running on http://localhost:${port}`);
    startCronJobs();
});
// ── Graceful shutdown ─────────────────────────────────────────────────────────
const gracefulShutdown = (signal) => {
    console.log(`[server] ${signal} received — shutting down gracefully`);
    server.close(async () => {
        console.log('[server] HTTP server closed');
        try {
            const { prisma, pool } = await import('./db.js');
            await prisma.$disconnect();
            await pool.end();
        }
        catch { /* already disconnected */ }
        process.exit(0);
    });
    // Force exit after 10s if connections hang
    setTimeout(() => process.exit(1), 10000);
};
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
