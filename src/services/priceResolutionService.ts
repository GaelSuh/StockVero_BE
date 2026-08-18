import { prisma } from '../db.js';

export async function resolvePrice(
  tenantId: string,
  categoryId: string,
  customerId: string | null,
  quantity: number,
): Promise<number> {
  if (!customerId) {
    const category = await prisma.inventoryCategory.findUnique({
      where: { id: categoryId },
      select: { sellingPrice: true, costPrice: true },
    });
    return Number(category?.sellingPrice ?? category?.costPrice ?? 0);
  }

  const customerPriceList = await prisma.customerPriceList.findFirst({
    where: { customerId },
    include: {
      priceList: {
        include: {
          rules: {
            where: { categoryId },
            orderBy: { minQuantity: 'desc' },
          },
        },
      },
    },
  });

  if (customerPriceList?.priceList?.rules?.length) {
    const applicableRule = customerPriceList.priceList.rules.find(
      (rule) => quantity >= rule.minQuantity,
    );
    if (applicableRule) {
      return Number(applicableRule.unitPrice);
    }
  }

  const category = await prisma.inventoryCategory.findUnique({
    where: { id: categoryId },
    select: { sellingPrice: true, costPrice: true },
  });
  return Number(category?.sellingPrice ?? category?.costPrice ?? 0);
}
