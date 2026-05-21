import 'dotenv/config';
import bcrypt from 'bcrypt';
import { prisma } from '../../src/db.js';

async function main() {
  const email = 'admin@digisol.com';
  const existing = await prisma.superAdmin.findUnique({ where: { email } });
  if (existing) {
    console.log('Super admin already exists with that email.');
    return;
  }
  const passwordHash = await bcrypt.hash('admin1234', 12);
  const admin = await prisma.superAdmin.create({
    data: { email, firstName: 'Admin', lastName: 'User', passwordHash },
    select: { id: true, email: true, firstName: true, lastName: true, createdAt: true },
  });
  console.log('✅ Super admin created:', JSON.stringify(admin, null, 2));
}

main().catch((err) => {
  console.error('❌ Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
