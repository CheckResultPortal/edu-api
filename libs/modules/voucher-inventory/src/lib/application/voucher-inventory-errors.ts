export class VoucherImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoucherImportValidationError';
  }
}

export class VoucherImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoucherImportConflictError';
  }
}

export class VoucherBatchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoucherBatchNotFoundError';
  }
}

export class VoucherBatchStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoucherBatchStateError';
  }
}
