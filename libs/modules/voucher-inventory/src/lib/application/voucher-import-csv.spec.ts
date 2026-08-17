import { Readable } from 'node:stream';

import { VoucherImportValidationError } from './voucher-inventory-errors';
import { readVoucherImportCsv } from './voucher-import-csv';

async function rowsFrom(input: readonly string[]) {
  const chunks: unknown[] = [];
  for await (const chunk of readVoucherImportCsv(
    Readable.from(input.map((part) => Buffer.from(part))),
    2,
    10_000,
  )) {
    chunks.push(...chunk);
  }
  return chunks;
}

describe('readVoucherImportCsv', () => {
  it('streams 100,000 rows while retaining only configured-size output chunks', async () => {
    const chunkSize = 1_000;
    const totalRows = 100_000;
    let parsedRows = 0;
    let emittedChunks = 0;
    let largestChunk = 0;
    let lastSerialNumber: string | undefined;

    for await (const chunk of readVoucherImportCsv(
      largeCsvSource(totalRows, 250),
      chunkSize,
      64 * 1_024 * 1_024,
    )) {
      parsedRows += chunk.length;
      emittedChunks += 1;
      largestChunk = Math.max(largestChunk, chunk.length);
      lastSerialNumber = chunk.at(-1)?.serialNumber;
    }

    expect(parsedRows).toBe(totalRows);
    expect(emittedChunks).toBe(totalRows / chunkSize);
    expect(largestChunk).toBe(chunkSize);
    expect(lastSerialNumber).toBe(`SERIAL-${totalRows}`);
  });

  it('streams the exact two-column format in bounded chunks', async () => {
    await expect(
      rowsFrom([
        '\uFEFFserialNumber,pin\r\nSERIAL-1,"PIN,ONE"\r\n',
        'SERIAL-2,"PIN ""TWO"""\r\nSERIAL-3,PIN-THREE\r\n',
      ]),
    ).resolves.toEqual([
      { pin: 'PIN,ONE', rowNumber: 2, serialNumber: 'SERIAL-1' },
      { pin: 'PIN "TWO"', rowNumber: 3, serialNumber: 'SERIAL-2' },
      { pin: 'PIN-THREE', rowNumber: 4, serialNumber: 'SERIAL-3' },
    ]);
  });

  it('reports row diagnostics without echoing a supplied PIN', async () => {
    const secret = 'PIN-MUST-NOT-APPEAR-IN-ERRORS';
    await expect(
      rowsFrom([`serialNumber,pin\nSERIAL-1,${secret}\nSERIAL-2,\n`]),
    ).rejects.toMatchObject({
      name: VoucherImportValidationError.name,
      message: expect.not.stringContaining(secret),
    });
  });

  it('rejects a CSV whose header does not match the import contract', async () => {
    await expect(rowsFrom(['serial,pin\nSERIAL-1,PIN-1\n'])).rejects.toThrow(
      'serialNumber,pin',
    );
  });
});

async function* largeCsvSource(
  totalRows: number,
  sourceRowsPerChunk: number,
): AsyncGenerator<Buffer> {
  yield Buffer.from('serialNumber,pin\n');
  for (let firstRow = 1; firstRow <= totalRows; ) {
    const lines: string[] = [];
    const lastRow = Math.min(firstRow + sourceRowsPerChunk - 1, totalRows);
    for (; firstRow <= lastRow; firstRow += 1) {
      lines.push(`SERIAL-${firstRow},PIN-${firstRow}\n`);
    }
    yield Buffer.from(lines.join(''));
  }
}
