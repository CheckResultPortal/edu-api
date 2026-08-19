export class AllocationProcessingUnavailableError extends Error {
  constructor(
    message = 'Voucher allocation is temporarily unavailable. Please retry.',
  ) {
    super(message);
    this.name = 'AllocationProcessingUnavailableError';
  }
}
