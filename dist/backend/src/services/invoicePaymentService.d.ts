export declare function approveProjectInvoiceInstalment({ invoiceId, tenantId, approvedBy, transactionId, percentageApproved, amountApproved, notes, }: {
    invoiceId: string;
    tenantId: string;
    approvedBy: string;
    transactionId: string;
    percentageApproved: number;
    amountApproved: number;
    notes?: string;
}): Promise<any>;
export declare function rejectProjectInvoice(invoiceId: string, reviewerId: string, reason: string, tenantId: string): Promise<any>;
