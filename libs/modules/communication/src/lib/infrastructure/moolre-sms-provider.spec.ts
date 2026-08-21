import { MoolreSmsProvider } from './moolre-sms-provider';

describe('MoolreSmsProvider', () => {
  it('uses the VAS-key SMS contract and a durable reference', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 1, code: 'SMS01', data: null }), {
          status: 200,
        }),
      );
    const provider = new MoolreSmsProvider({
      vasKey: 'vas-key',
      senderId: 'EduVoucher',
      fetch: fetcher,
    });

    await expect(
      provider.send({
        to: '+233241235993',
        message: 'secret is only in this local test',
        reference: 'delivery-1',
      }),
    ).resolves.toEqual({ status: 'SENT', providerMessageId: 'delivery-1' });
    const [, request] = fetcher.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-VASKEY': 'vas-key',
      },
    });
    expect(JSON.parse((request as RequestInit).body as string)).toEqual({
      type: 1,
      senderid: 'EduVoucher',
      messages: [
        {
          recipient: '233241235993',
          message: 'secret is only in this local test',
          ref: 'delivery-1',
        },
      ],
    });
  });

  it('reconciles a known message reference without exposing message content', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 1,
            code: 'ASMQ10',
            data: [{ ref: 'delivery-1', status: 3 }],
          }),
          { status: 200 },
        ),
      );
    const provider = new MoolreSmsProvider({
      vasKey: 'vas-key',
      senderId: 'EduVoucher',
      fetch: fetcher,
    });

    await expect(provider.lookup('delivery-1')).resolves.toBe('ACCEPTED');
    const [, request] = fetcher.mock.calls[0] ?? [];
    expect(request).toMatchObject({ method: 'POST' });
    expect(JSON.parse((request as RequestInit).body as string)).toEqual({
      type: 5,
      ref: ['delivery-1'],
    });
  });

  it('normalizes an uncertain transport failure without leaking provider details', async () => {
    const provider = new MoolreSmsProvider({
      vasKey: 'vas-key',
      senderId: 'EduVoucher',
      fetch: jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockRejectedValue(new Error('timeout')),
    });

    await expect(
      provider.send({
        to: '+233241235993',
        message: 'not logged',
        reference: 'delivery-1',
      }),
    ).resolves.toEqual({ status: 'FAILED', category: 'UNKNOWN_OUTCOME' });
  });
});
