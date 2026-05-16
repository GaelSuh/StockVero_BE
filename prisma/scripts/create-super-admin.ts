/**
 * Script: Create Super Admin
 *
 * Interactively creates a new super-admin record in the database.
 * Hashes the password with bcrypt (cost 12) before storing.
 *
 * Usage:
 *   npm run create-super-admin
 *
 * The password field will echo characters to the terminal (this is an
 * internal setup tool — never run it on a shared screen in production).
 * Alternatively, set SUPER_ADMIN_PASSWORD in your environment to skip
 * the password prompt.
 */

import 'dotenv/config';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import bcrypt from 'bcrypt';
import { prisma } from '../../src/db.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hr() {
  console.log('─'.repeat(50));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔐  SolarFlow Pro — Create Super Admin\n');
  hr();

  const rl = readline.createInterface({ input, output });

  let email: string;
  let firstName: string;
  let lastName: string;
  let password: string;

  try {
    email = (await rl.question('  Email address : ')).trim().toLowerCase();
    firstName = (await rl.question('  First name    : ')).trim();
    lastName = (await rl.question('  Last name     : ')).trim();

    // Allow pre-supplying via env var to avoid visible terminal output
    if (process.env.SUPER_ADMIN_PASSWORD) {
      password = process.env.SUPER_ADMIN_PASSWORD;
      console.log('  Password      : [read from SUPER_ADMIN_PASSWORD env var]');
    } else {
      password = (await rl.question('  Password      : ')).trim();
    }
  } finally {
    rl.close();
  }

  // ── validation ──────────────────────────────────────────────────────────────

  const errors: string[] = [];

  if (!email) errors.push('Email is required.');
  else if (!validateEmail(email)) errors.push(`"${email}" is not a valid email address.`);

  if (!firstName) errors.push('First name is required.');
  if (!lastName) errors.push('Last name is required.');

  if (!password) errors.push('Password is required.');
  else if (password.length < 8) errors.push('Password must be at least 8 characters.');

  if (errors.length > 0) {
    console.error('\n❌  Validation failed:');
    errors.forEach((e) => console.error(`   • ${e}`));
    process.exit(1);
  }

  // ── duplicate check ─────────────────────────────────────────────────────────

  const existing = await prisma.superAdmin.findUnique({ where: { email } });
  if (existing) {
    console.error(`\n❌  A super admin with email "${email}" already exists.\n`);
    process.exit(1);
  }

  // ── create ──────────────────────────────────────────────────────────────────

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.superAdmin.create({
    data: { email, firstName, lastName, passwordHash },
    select: { id: true, email: true, firstName: true, lastName: true, createdAt: true },
  });

  hr();
  console.log('\n✅  Super admin created successfully!\n');
  console.log(`   ID      :  ${admin.id}`);
  console.log(`   Name    :  ${admin.firstName} ${admin.lastName}`);
  console.log(`   Email   :  ${admin.email}`);
  console.log(`   Created :  ${admin.createdAt.toISOString()}`);
  console.log('\n');
}

main()
  .catch((err) => {
    console.error('\n❌  Script failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
