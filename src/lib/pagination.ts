export function parsePagination(
  pageInput: unknown,
  limitInput: unknown,
  defaultLimit = 20,
  maxLimit = 100,
) {
  const page = Math.max(1, parseInt(String(pageInput || ''), 10) || 1);
  const limit = Math.min(
    maxLimit,
    Math.max(1, parseInt(String(limitInput || ''), 10) || defaultLimit),
  );
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

export function buildPaginationMeta(total: number, page: number, limit: number) {
  return {
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

