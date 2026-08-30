import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  /** Class applied to the cell — `num` for anything that should line up. */
  className?: string;
  render: (row: T) => ReactNode;
}

/** A plain table with a header, an empty state and horizontal scroll on small screens. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty = 'Nothing here yet.',
}: {
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  rowKey: (row: T, index: number) => string;
  caption?: string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return (
      <div className="table-wrap">
        <div className="empty">{empty}</div>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        {caption !== undefined && (
          <caption className="faint" style={{ captionSide: 'bottom', padding: '10px 16px', textAlign: 'left' }}>
            {caption}
          </caption>
        )}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)}>
              {columns.map((column) => (
                <td key={column.key} className={column.className}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
