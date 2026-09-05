import {
  GuestVoucherRetrievalService,
  GuestVoucherRetrievalUnavailableError,
} from './guest-voucher-retrieval-service';

describe('GuestVoucherRetrievalService', () => {
  const reference = '6b0f6e55-0f5e-4c3a-9d3e-2a7c1a111111';
  function setup() {
    const query = {
      findByPhoneAndEmail: jest.fn(),
      findByPhoneAndReference: jest.fn().mockResolvedValue(null),
      findVoucherRetrievalAccess: jest.fn().mockResolvedValue({
        orderId: BigInt(7),
        destinationEmail: 'stored@example.test',
      }),
    };
    const limiter = { consume: jest.fn().mockResolvedValue(undefined) };
    const deliveries = {
      request: jest
        .fn()
        .mockResolvedValue({ deliveryPublicId: 'delivery-ref' }),
    };
    return {
      query,
      limiter,
      deliveries,
      service: new GuestVoucherRetrievalService(query, limiter, deliveries),
    };
  }
  const request = {
    orderReference: reference,
    contact: { phoneNumber: '0244123456' },
    idempotencyKey: 'retrieval-test-request-123',
  };

  it('requires phone verification for short-code retrieval', async () => {
    const { service, query } = setup();
    await expect(
      service.request({
        ...request,
        orderReference: '123456',
        contact: { email: 'stored@example.test' },
      }),
    ).rejects.toBeInstanceOf(GuestVoucherRetrievalUnavailableError);
    expect(query.findVoucherRetrievalAccess).not.toHaveBeenCalled();
    await service.request({ ...request, orderReference: '123456' });
    expect(query.findVoucherRetrievalAccess).toHaveBeenCalledWith({
      orderReference: '123456',
      phoneNumber: '+233244123456',
    });
  });

  it('normalizes contacts and uses only the authorized stored destination', async () => {
    const { service, query, deliveries, limiter } = setup();
    await service.request(request);
    expect(query.findVoucherRetrievalAccess).toHaveBeenCalledWith({
      phoneNumber: '+233244123456',
      orderReference: reference,
    });
    expect(deliveries.request).toHaveBeenCalledWith({
      orderId: BigInt(7),
      destinationEmail: 'stored@example.test',
      idempotencyKey: request.idempotencyKey,
    });
    expect(limiter.consume).toHaveBeenCalledWith({
      phoneNumber: '+233244123456',
      clientIp: undefined,
    });
  });

  it.each([
    {},
    { destinationEmail: 'attacker@example.test' },
    { phoneNumber: 'invalid' },
  ])('rejects invalid authorization before querying (%j)', async (contact) => {
    const { service, query, deliveries } = setup();
    await expect(service.request({ ...request, contact })).rejects.toThrow();
    expect(query.findVoucherRetrievalAccess).not.toHaveBeenCalled();
    expect(deliveries.request).not.toHaveBeenCalled();
  });

  it('cannot bypass rate limits or failed eligibility', async () => {
    const { service, query, deliveries, limiter } = setup();
    limiter.consume.mockRejectedValueOnce(new Error('rate limit'));
    await expect(service.request(request)).rejects.toThrow('rate limit');
    expect(query.findVoucherRetrievalAccess).not.toHaveBeenCalled();
    query.findVoucherRetrievalAccess.mockResolvedValueOnce(null);
    await expect(service.request(request)).rejects.toBeInstanceOf(
      GuestVoucherRetrievalUnavailableError,
    );
    expect(deliveries.request).not.toHaveBeenCalled();
  });

  it('rechecks authorization on retries and retains the request key', async () => {
    const { service, query, deliveries } = setup();
    await service.request(request);
    await service.request(request);
    expect(query.findVoucherRetrievalAccess).toHaveBeenCalledTimes(2);
    expect(deliveries.request.mock.calls[0]).toEqual(
      deliveries.request.mock.calls[1],
    );
  });

  it('uses contact rate limits for gateway status lookup without aggregating callers by gateway IP', async () => {
    const { service, query, limiter } = setup();
    await service.lookup({
      phoneNumber: '0244123456',
      orderReference: reference,
    });
    expect(limiter.consume).toHaveBeenCalledWith({
      phoneNumber: '+233244123456',
    });
    expect(query.findByPhoneAndReference).toHaveBeenCalledWith(
      '+233244123456',
      reference,
    );
  });
});
