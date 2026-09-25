export interface DependencyItem {
    module: string;
    description: string;
    count: number;
    action: string;
    isWarning?: boolean;
    links?: {
        id: string;
        label: string;
        route: string;
    }[];
}
export interface DependencyReport {
    canDelete: boolean;
    dependencies: DependencyItem[];
}
export declare function checkInventoryCategoryDependencies(categoryId: string, tenantId: string): Promise<DependencyReport>;
/**
 * Runs the same check over many products at once, for the bulk-delete preview.
 * Kept sequential-per-id on purpose: each report is a handful of small counts and
 * a selection is capped well below the point where this matters.
 */
export declare function checkInventoryCategoriesDependencies(categoryIds: string[], tenantId: string): Promise<Map<string, DependencyReport>>;
export declare function checkProductItemDependencies(itemId: string, tenantId: string): Promise<DependencyReport>;
export declare function checkProjectDependencies(projectId: string, tenantId: string): Promise<DependencyReport>;
export declare function checkCustomerDependencies(customerId: string, tenantId: string): Promise<DependencyReport>;
export declare function checkTransactionDependencies(transactionId: string, tenantId: string): Promise<DependencyReport>;
export declare function checkInvoiceDependencies(invoiceId: string, tenantId: string): Promise<DependencyReport>;
export declare function checkDocumentDependencies(_documentId: string, _tenantId: string): Promise<DependencyReport>;
export declare function checkEmployeeDependencies(employeeId: string, tenantId: string): Promise<DependencyReport>;
export declare function checkRoleDependencies(roleId: string, tenantId: string): Promise<DependencyReport>;
/**
 * Five tables can reference a variant, and only two of them (ProductItem via
 * onDelete: Restrict, PriceRule) would be stopped by Postgres on its own.
 * SaleItem and SaleReturnItem are SetNull and CategoryStockLog is Cascade —
 * a raw DELETE would silently blank a historical sale's variant or erase its
 * stock history. Every one is checked here so the answer does not depend on
 * which table happened to be strictest.
 */
export declare function checkProductVariantDependencies(variantId: string, tenantId: string): Promise<DependencyReport>;
/**
 * Nothing blocks deleting a price list — the rows cascade and no sale depends
 * on one. But customers assigned to it silently fall back to default pricing,
 * which is a real pricing change nobody is told about. So this always allows
 * the delete and reports the fallout as a warning instead.
 */
export declare function checkPriceListDependencies(tenantId: string, priceListId: string): Promise<DependencyReport>;
