/** Default page size for list endpoints. */
export const DEFAULT_PAGE_SIZE = 20;

/** Upper bound for `pageSize` on every paged list endpoint. */
export const MAX_PAGE_SIZE = 100;

/** Normalized paging parameters. */
export interface Paging {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/** The uniform `{ items, total, page, pageSize, totalPages }` envelope. */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Clamp/floor `page` (≥ 1) and `pageSize` (1..MAX_PAGE_SIZE) into a Prisma-ready slice. */
export function parsePaging(page?: number, pageSize?: number): Paging {
  const p = typeof page === 'number' && page >= 1 ? Math.floor(page) : 1;
  const ps =
    typeof pageSize === 'number' && pageSize >= 1
      ? Math.min(Math.floor(pageSize), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  return { page: p, pageSize: ps, skip: (p - 1) * ps, take: ps };
}

/** Build the uniform paged envelope. */
export function toPageResult<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PageResult<T> {
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}
