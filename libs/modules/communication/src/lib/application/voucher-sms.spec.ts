import { renderVoucherSms } from './voucher-sms';

describe('compact voucher SMS', () => {
  it('preserves credentials and includes the configured checker link', () => {
    expect(
      renderVoucherSms({
        productName: 'WASSCE',
        orderReference: 'EDUPAY-123456',
        serialNumber: '001234',
        pin: '00001234',
        resultCheckerUrl: 'https://ghana.waecdirect.org/',
      }),
    ).toBe(
      'WASSCE\nOrder: EDUPAY-123456\nSerial: 001234\nPIN: 00001234\nhttps://ghana.waecdirect.org/',
    );
  });
  it('omits absent links without inventing a category', () => {
    expect(
      renderVoucherSms({
        productName: 'BECE',
        orderReference: '6bd6fc2f-ba04-4aec-9c1a-1c3fce45941f',
        serialNumber: '001',
        pin: '002',
      }),
    ).toBe(
      'BECE\nOrder: 6bd6fc2f-ba04-4aec-9c1a-1c3fce45941f\nSerial: 001\nPIN: 002',
    );
  });
});
