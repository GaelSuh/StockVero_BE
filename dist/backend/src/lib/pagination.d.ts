export declare function parsePagination(pageInput: unknown, limitInput: unknown, defaultLimit?: number, maxLimit?: number): {
    page: number;
    limit: number;
    skip: number;
};
export declare function buildPaginationMeta(total: number, page: number, limit: number): {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
};
