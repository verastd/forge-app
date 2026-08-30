'use client';

export function Pagination({
  page,
  pageCount,
  total,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) {
    return <p className="faint">{total.toLocaleString()} rows</p>;
  }

  return (
    <nav className="pagination" aria-label="History pages">
      <span className="faint">
        {total.toLocaleString()} rows · page {page + 1} of {pageCount}
      </span>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => {
          onPageChange(page - 1);
        }}
        disabled={page === 0}
      >
        Previous
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => {
          onPageChange(page + 1);
        }}
        disabled={page >= pageCount - 1}
      >
        Next
      </button>
    </nav>
  );
}
