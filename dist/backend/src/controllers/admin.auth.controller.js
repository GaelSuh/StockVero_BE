import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
import { generateAdminToken } from '../lib/adminJwt.js';
import { blockAdminToken } from '../lib/adminTokenBlocklist.js';
const AdminLoginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});
export const adminLogin = async (req, res) => {
    try {
        const parsed = AdminLoginSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const { email, password } = parsed.data;
        const admin = await prisma.superAdmin.findUnique({ where: { email } });
        if (!admin) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
            });
        }
        const isValid = await bcrypt.compare(password, admin.passwordHash);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
            });
        }
        const token = generateAdminToken({
            adminId: admin.id,
            role: 'SUPER_ADMIN',
        });
        await prisma.superAdmin.update({
            where: { id: admin.id },
            data: { lastLoginAt: new Date() },
        });
        return res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                token,
                admin: {
                    id: admin.id,
                    email: admin.email,
                    firstName: admin.firstName,
                    lastName: admin.lastName,
                    lastLoginAt: admin.lastLoginAt,
                },
            },
        });
    }
    catch (error) {
        console.error('Error during admin login:', error);
        return res.status(500).json({
            success: false,
            message: 'Login failed',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const adminMe = async (req, res) => {
    try {
        if (!req.admin) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized',
            });
        }
        const admin = await prisma.superAdmin.findUnique({
            where: { id: req.admin.id },
            select: { id: true, email: true, firstName: true, lastName: true, lastLoginAt: true },
        });
        if (!admin) {
            return res.status(404).json({
                success: false,
                message: 'Admin not found',
            });
        }
        return res.status(200).json({
            success: true,
            message: 'Admin retrieved',
            data: admin,
        });
    }
    catch (error) {
        console.error('Error fetching admin profile:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to retrieve admin',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const adminLogout = async (req, res) => {
    try {
        if (!req.adminToken) {
            return res.status(400).json({
                success: false,
                message: 'Missing token',
            });
        }
        await blockAdminToken(req.adminToken);
        return res.status(200).json({
            success: true,
            message: 'Logged out',
        });
    }
    catch (error) {
        console.error('Error during admin logout:', error);
        return res.status(500).json({
            success: false,
            message: 'Logout failed',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
