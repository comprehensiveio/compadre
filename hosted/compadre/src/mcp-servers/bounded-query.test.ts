import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedJsonRows, type RowCursor } from "./bounded-query.js";

function cursorFor<Row>(source: Row[]): RowCursor<Row> {
  let offset = 0;
  return {
    async read(maxRows) {
      const rows = source.slice(offset, offset + maxRows);
      offset += rows.length;
      return rows;
    },
  };
}

const options = {
  batchSize: 2,
  rowLimit: 3,
  serializedByteLimit: 1_000,
};

test("marks truncation only when a row exists beyond the row limit", async () => {
  const exact = await readBoundedJsonRows(
    cursorFor([{ id: 1 }, { id: 2 }, { id: 3 }]),
    options,
  );
  const overflow = await readBoundedJsonRows(
    cursorFor([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]),
    options,
  );

  assert.equal(exact.truncated, false);
  assert.equal(overflow.truncated, true);
  assert.deepEqual(overflow.rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("bounds the exact compact JSON representation returned to the caller", async () => {
  const result = await readBoundedJsonRows(
    cursorFor([
      { nested: { values: ["first", "second"] } },
      { nested: { values: ["third", "fourth"] } },
    ]),
    { ...options, serializedByteLimit: 50 },
  );

  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.json, "utf8") <= 50, true);
  assert.equal(result.json, JSON.stringify(result.rows));
});
