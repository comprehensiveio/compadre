export interface RowCursor<Row> {
  read(maxRows: number): Promise<Row[]>;
}

export interface BoundedQueryOptions {
  batchSize: number;
  rowLimit: number;
  serializedByteLimit: number;
}

export async function readBoundedJsonRows<Row extends Record<string, unknown>>(
  cursor: RowCursor<Row>,
  options: BoundedQueryOptions,
): Promise<{ json: string; rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  let serializedBytes = 2;
  let truncated = false;

  while (rows.length < options.rowLimit) {
    const requestedRows = Math.min(
      options.batchSize,
      options.rowLimit - rows.length,
    );
    const batch = await cursor.read(requestedRows);
    if (batch.length === 0) break;

    for (const row of batch) {
      const rowBytes =
        Buffer.byteLength(JSON.stringify(row), "utf8") +
        (rows.length === 0 ? 0 : 1);
      if (serializedBytes + rowBytes > options.serializedByteLimit) {
        truncated = true;
        break;
      }
      rows.push(row);
      serializedBytes += rowBytes;
    }
    if (truncated) break;
    if (batch.length < requestedRows) break;
  }

  if (!truncated && rows.length === options.rowLimit) {
    truncated = (await cursor.read(1)).length > 0;
  }

  return { json: JSON.stringify(rows), rows, truncated };
}
