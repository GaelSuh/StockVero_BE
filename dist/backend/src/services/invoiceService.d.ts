export declare function generateInvoiceNumber(tenantId: string): Promise<string>;
export declare function createPurchaseInvoice({ tenantId, categoryId, submittedBy, }: {
    tenantId: string;
    categoryId: string;
    submittedBy: string;
}): Promise<any>;
export declare function createProjectInvoice({ tenantId, projectId, budget, submittedBy, }: {
    tenantId: string;
    projectId: string;
    budget: number;
    submittedBy: string;
}): Promise<any>;
export declare function createClientInvoice({ tenantId, projectId, lineItems, submittedBy, notes, }: {
    tenantId: string;
    projectId: string;
    lineItems?: Array<{
        description: string;
        type?: string;
        quantity: number;
        unitPrice: number;
        categoryId?: string;
        notes?: string;
    }>;
    submittedBy: string;
    notes?: string;
}): Promise<any>;
export declare function createPaymentInvoice({ tenantId, customerId, amount, submittedBy, }: {
    tenantId: string;
    customerId: string;
    amount: number;
    submittedBy: string;
}): Promise<any>;
export declare function approveInvoice(invoiceId: string, reviewerId: string): Promise<any>;
export declare function rejectInvoice(invoiceId: string, reviewerId: string, reason: string): Promise<any>;
export declare function deductUnitCost(productItemId: string, categoryId: string, tenantId: string): Promise<void>;
