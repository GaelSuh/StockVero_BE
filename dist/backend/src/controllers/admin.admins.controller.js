import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
const CreateAdminSchema = z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
});
const ChangePasswordSchema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
});
export const listSuperAdmins = async (req, res) => {
    try {
        const admins = await prisma.superAdmin.findMany({
            orderBy: { createdAt: 'asc' },
            select: { id: true, firstName: true, lastName: true, email: true, lastLoginAt: true, createdAt: true },
        });
        return res.status(200).json({
            success: true,
            data: admins,
        });
    }
    catch (error) {
        console.error('Error listing super admins:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to list admins',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const createSuperAdmin = async (req, res) => {
    try {
        const parsed = CreateAdminSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const { firstName, lastName, email, password } = parsed.data;
        const existing = await prisma.superAdmin.findUnique({ where: { email } });
        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'Email already registered',
            });
        }
        const passwordHash = await bcrypt.hash(password, 10);
        const admin = await prisma.superAdmin.create({
            data: {
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                email: email.toLowerCase().trim(),
                passwordHash,
            },
            select: { id: true, firstName: true, lastName: true, email: true, createdAt: true },
        });
        return res.status(201).json({
            success: true,
            message: 'Admin created',
            data: admin,
        });
    }
    catch (error) {
        console.error('Error creating super admin:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to create admin',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
export const changeSuperAdminPassword = async (req, res) => {
    try {
        if (req.admin?.id !== req.params.id) {
            return res.status(403).json({
                success: false,
                message: 'You can only change your own password',
            });
        }
        const parsed = ChangePasswordSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                success: false,
                message: parsed.error.issues[0]?.message || 'Invalid payload',
            });
        }
        const admin = await prisma.superAdmin.findUnique({ where: { id: req.params.id } });
        if (!admin) {
            return res.status(404).json({
                success: false,
                message: 'Admin not found',
            });
        }
        const isValid = await bcrypt.compare(parsed.data.currentPassword, admin.passwordHash);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid current password',
            });
        }
        const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
        await prisma.superAdmin.update({
            where: { id: admin.id },
            data: { passwordHash },
        });
        return res.status(200).json({
            success: true,
            message: 'Password updated',
        });
    }
    catch (error) {
        console.error('Error updating admin password:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update password',
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
