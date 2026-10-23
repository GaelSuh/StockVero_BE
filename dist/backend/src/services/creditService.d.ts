export declare function getCreditCustomers(tenantId: string): Promise<{
    customerId: string;
    customerName: string;
    totalOwed: number;
    salesCount: number;
    lastPurchaseDate: Date;
}[]>;
/**
 * Every line item this customer has ever actually bought, across both retail
 * and wholesale, any payment status — a purchase history, not a debt list
 * (see getCustomerCreditSales for that). Read at the SaleItem level rather
 * than the sale level, since "what did they buy" means individual products,
 * not just sale totals.
 */
export declare function getCustomerPurchaseHistory(tenantId: string, customerId: string): Promise<{
    id: string;
    saleId: string;
    saleNumber: string;
    mode: import("@prisma/client").$Enums.SaleMode;
    date: Date;
    productName: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
}[]>;
export declare function getCustomerCreditSales(tenantId: string, customerId: string): Promise<{
    id: string;
    createdAt: Date;
    saleNumber: string;
    mode: import("@prisma/client").$Enums.SaleMode;
    totalAmount: import("@prisma/client-runtime-utils").Decimal;
    paymentStatus: import("@prisma/client").$Enums.SalePaymentStatus;
    amountPaid: import("@prisma/client-runtime-utils").Decimal;
    amountOwed: import("@prisma/client-runtime-utils").Decimal;
    creditDueDate: Date | null;
}[]>;
