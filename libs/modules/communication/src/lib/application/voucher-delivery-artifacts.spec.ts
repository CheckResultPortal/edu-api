import { generateVoucherDeliveryArtifacts } from './voucher-delivery-artifacts';

describe('generateVoucherDeliveryArtifacts', () => {
  it('generates bounded in-memory PDF and CSV voucher copies', async () => {
    const artifacts = await generateVoucherDeliveryArtifacts({
      deliveryPublicId: '4e310bf9-32e6-43d0-8d42-f52f7543d092',
      orderPublicReference: '2a9d1620-bb20-416a-9f60-f532220edb94',
      pin: '1234-5678-9012',
      productName: 'WAEC Result Checker',
      resultCheckerUrl: 'https://ghana.waecdirect.org/',
      serialNumber: 'WAE-000001',
      supportPhone: '+233 20 000 0000',
    });

    expect(artifacts).toHaveLength(2);
    const pdf = artifacts.find(
      (artifact) => artifact.contentType === 'application/pdf',
    );
    const csv = artifacts.find((artifact) =>
      artifact.contentType.startsWith('text/csv'),
    );
    expect(pdf?.filename).toBe(
      'eduvoucher-4e310bf9-32e6-43d0-8d42-f52f7543d092.pdf',
    );
    expect(
      Buffer.from(pdf?.contentBase64 ?? '', 'base64').subarray(0, 5),
    ).toEqual(Buffer.from('%PDF-'));
    expect(csv?.filename).toEqual(expect.stringMatching(/\.csv$/));
    expect(
      Buffer.from(csv?.contentBase64 ?? '', 'base64').toString('utf8'),
    ).toBe('serialNumber,pin\r\n"WAE-000001","1234-5678-9012"\r\n');
  });

  it('escapes CSV formula-like and quoted voucher values as data', async () => {
    const artifacts = await generateVoucherDeliveryArtifacts({
      deliveryPublicId: '4e310bf9-32e6-43d0-8d42-f52f7543d092',
      orderPublicReference: '2a9d1620-bb20-416a-9f60-f532220edb94',
      pin: '=1+1"',
      productName: 'WAEC Result Checker',
      serialNumber: '+WAE-1',
      supportPhone: '+233 20 000 0000',
    });
    const csv = artifacts.find((artifact) =>
      artifact.contentType.startsWith('text/csv'),
    );
    expect(
      Buffer.from(csv?.contentBase64 ?? '', 'base64').toString('utf8'),
    ).toBe('serialNumber,pin\r\n"\'+WAE-1","\'=1+1"""\r\n');
  });
});
