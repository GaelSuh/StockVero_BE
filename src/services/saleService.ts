import { prisma, prismaUnscoped } from '../db.js';

type PrismaWriteClient =
  | typeof prisma
  | Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$use' | '$extends'>
  | any;

export async function getNextSaleNumber(tenantId: string, tx: PrismaWriteClient = prisma): Promise<string> {
  const sequence = await (tx as any).saleSequence.upsert({
    where: { tenantId },
    update: { lastSeq: { increment: 1 } },
    create: { tenantId, lastSeq: 1 },
  });
  return `SL-${String(sequence.lastSeq).padStart(4, '0')}`;
}

export async function getNextReturnNumber(tenantId: string, tx: PrismaWriteClient = prisma): Promise<string> {
  // Company-wide numbering: counted across every branch, so unscoped.
  const count = await prismaUnscoped.saleReturn.count({ where: { tenantId } });
  return `RT-${String(count + 1).padStart(4, '0')}`;
}

export async function getNextDeliveryNoteNumber(tenantId: string, tx: PrismaWriteClient = prisma): Promise<string> {
  // Company-wide numbering: counted across every branch, so unscoped.
  const count = await prismaUnscoped.deliveryNote.count({ where: { tenantId } });
  return `DN-${String(count + 1).padStart(4, '0')}`;
}
