/** Build only immediately before sending; never log the returned credentials. */
export function renderVoucherSms(input: {
  productName: string;
  orderReference: string;
  serialNumber: string;
  pin: string;
  resultCheckerUrl?: string;
}): string {
  return [
    input.productName,
    `Order: ${input.orderReference}`,
    `Serial: ${input.serialNumber}`,
    `PIN: ${input.pin}`,
    input.resultCheckerUrl,
  ]
    .filter(Boolean)
    .join('\n');
}
