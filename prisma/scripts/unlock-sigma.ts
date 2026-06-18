import 'dotenv/config';
import { prisma } from '../../src/db.js';
async function main() {
  // Unlock Sigma project, set one milestone back to ACTIVE so materials can be added
  const proj = await prisma.project.findFirst({ where: { name: 'Sigma Industries — Solar Water Pumping' } });
  if (!proj) { console.log('not found'); return; }
  await prisma.project.update({ where: { id: proj.id }, data: { isLocked: false, status: 'IN_PROGRESS', progress: 90 } });
  const ms = await prisma.projectMilestone.findFirst({ where: { projectId: proj.id, name: 'Installation & Handover' } });
  if (ms) await prisma.projectMilestone.update({ where: { id: ms.id }, data: { status: 'ACTIVE', progress: 90 } });
  console.log('unlocked', proj.id);
}
main().finally(() => prisma.$disconnect());
