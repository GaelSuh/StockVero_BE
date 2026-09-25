import { prisma } from '../db.js';
export async function getNextSaleNumber(tenantId, tx = prisma) {
    const sequence = await tx.saleSequence.upsert({
        where: { tenantId },
        update: { lastSeq: { increment: 1 } },
        create: { tenantId, lastSeq: 1 },
    });
    return `SL-${String(sequence.lastSeq).padStart(4, '0')}`;
}
export async function getNextReturnNumber(tenantId, tx = prisma) {
    const count = await tx.saleReturn.count({ where: { tenantId } });
    return `RT-${String(count + 1).padStart(4, '0')}`;
}
export async function getNextDeliveryNoteNumber(tenantId, tx = prisma) {
    const count = await tx.deliveryNote.count({ where: { tenantId } });
    return `DN-${String(count + 1).padStart(4, '0')}`;
}
