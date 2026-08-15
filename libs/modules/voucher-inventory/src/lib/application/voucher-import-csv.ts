import { StringDecoder } from 'node:string_decoder';

import { VoucherImportValidationError } from './voucher-inventory-errors';

export interface VoucherImportCsvRow {
  readonly pin: string;
  readonly rowNumber: number;
  readonly serialNumber: string;
}

const requiredHeader = ['serialNumber', 'pin'] as const;
const maximumFieldLength = 4_096;

/**
 * Parses only the two-column voucher CSV format. Chunks retain at most the
 * configured number of rows and are intentionally not logged or persisted.
 */
export async function* readVoucherImportCsv(
  source: AsyncIterable<Uint8Array>,
  chunkSize: number,
  maximumBytes: number,
): AsyncGenerator<readonly VoucherImportCsvRow[]> {
  const decoder = new StringDecoder('utf8');
  const parser = new CsvParser();
  let bytesRead = 0;
  let headerRead = false;
  let rowNumber = 0;
  let chunk: VoucherImportCsvRow[] = [];

  const processRows = (rows: readonly string[][]): VoucherImportCsvRow[][] => {
    const chunks: VoucherImportCsvRow[][] = [];
    for (const row of rows) {
      rowNumber += 1;
      if (!headerRead) {
        assertHeader(row, rowNumber);
        headerRead = true;
        continue;
      }
      chunk.push(toVoucherImportRow(row, rowNumber));
      if (chunk.length === chunkSize) {
        chunks.push(chunk);
        chunk = [];
      }
    }
    return chunks;
  };

  for await (const part of source) {
    bytesRead += part.byteLength;
    if (bytesRead > maximumBytes) {
      throw new VoucherImportValidationError(
        'The voucher import file exceeds the permitted size.',
      );
    }
    for (const emitted of processRows(parser.write(decoder.write(part)))) {
      yield emitted;
    }
  }

  for (const emitted of processRows(parser.finish(decoder.end()))) {
    yield emitted;
  }
  if (!headerRead) {
    throw new VoucherImportValidationError(
      'The voucher import file must include the serialNumber,pin header.',
    );
  }
  if (chunk.length !== 0) {
    yield chunk;
  }
}

function assertHeader(row: readonly string[], rowNumber: number): void {
  if (
    rowNumber !== 1 ||
    row.length !== requiredHeader.length ||
    row.some((value, index) => value !== requiredHeader[index])
  ) {
    throw new VoucherImportValidationError(
      'The first CSV row must be exactly serialNumber,pin.',
    );
  }
}

function toVoucherImportRow(
  row: readonly string[],
  rowNumber: number,
): VoucherImportCsvRow {
  if (row.length !== 2) {
    throw rowError(rowNumber, 'must contain exactly two columns');
  }
  const serialNumber = row[0].trim();
  const pin = row[1];
  if (
    serialNumber.length === 0 ||
    serialNumber.length > 256 ||
    containsControlCharacter(serialNumber)
  ) {
    throw rowError(rowNumber, 'has an invalid serial number');
  }
  if (
    pin.trim().length === 0 ||
    pin.length > 1_024 ||
    containsControlCharacter(pin)
  ) {
    throw rowError(rowNumber, 'has an invalid PIN');
  }
  return { pin, rowNumber, serialNumber };
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function rowError(
  rowNumber: number,
  detail: string,
): VoucherImportValidationError {
  return new VoucherImportValidationError(
    `Voucher import row ${rowNumber} ${detail}.`,
  );
}

class CsvParser {
  private field = '';
  private fields: string[] = [];
  private readonly rows: string[][] = [];
  private state: 'after-quote' | 'quoted' | 'unquoted' = 'unquoted';
  private skipNextLineFeed = false;

  write(input: string): readonly string[][] {
    this.rows.length = 0;
    for (const character of input) this.consume(character);
    return [...this.rows];
  }

  finish(input: string): readonly string[][] {
    this.rows.length = 0;
    for (const character of input) this.consume(character);
    if (this.state === 'quoted') {
      throw new VoucherImportValidationError(
        'The voucher import CSV contains an unterminated quoted field.',
      );
    }
    if (this.field.length !== 0 || this.fields.length !== 0) {
      this.endRow();
    }
    return [...this.rows];
  }

  private consume(character: string): void {
    if (this.skipNextLineFeed) {
      this.skipNextLineFeed = false;
      if (character === '\n') return;
    }
    if (this.state === 'quoted') {
      if (character === '"') this.state = 'after-quote';
      else this.append(character);
      return;
    }
    if (this.state === 'after-quote') {
      if (character === '"') {
        this.append(character);
        this.state = 'quoted';
      } else if (character === ',') {
        this.endField();
        this.state = 'unquoted';
      } else if (character === '\n' || character === '\r') {
        this.endRow();
        this.state = 'unquoted';
        this.skipNextLineFeed = character === '\r';
      } else {
        throw new VoucherImportValidationError(
          'The voucher import CSV contains invalid quoted-field syntax.',
        );
      }
      return;
    }
    if (character === '"') {
      if (this.field.length !== 0) {
        throw new VoucherImportValidationError(
          'The voucher import CSV contains invalid quoted-field syntax.',
        );
      }
      this.state = 'quoted';
    } else if (character === ',') {
      this.endField();
    } else if (character === '\n' || character === '\r') {
      this.endRow();
      this.skipNextLineFeed = character === '\r';
    } else {
      this.append(character);
    }
  }

  private append(character: string): void {
    this.field += character;
    if (this.field.length > maximumFieldLength) {
      throw new VoucherImportValidationError(
        'The voucher import CSV contains a field that is too long.',
      );
    }
  }

  private endField(): void {
    this.fields.push(this.field);
    this.field = '';
  }

  private endRow(): void {
    this.endField();
    if (this.rows.length === 0 && this.fields.length === 2) {
      this.fields[0] = this.fields[0].replace(/^\uFEFF/, '');
    }
    this.rows.push(this.fields);
    this.fields = [];
    this.field = '';
  }
}
