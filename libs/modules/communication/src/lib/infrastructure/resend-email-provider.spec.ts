import { ResendEmailProvider } from './resend-email-provider';

describe('ResendEmailProvider', () => {
  const input = {
    from: 'Edu Voucher <admin@example.com>',
    html: '<p>Invite</p>',
    idempotencyKey: 'admin-invitation-delivery:1',
    subject: 'Administrator invitation',
    text: 'Invite',
    to: 'operator@example.com',
  };

  it('keeps Resend details in the adapter and passes its idempotency header', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'resend-message-id' }), {
          status: 200,
        }),
      );
    const provider = new ResendEmailProvider({
      apiKey: 're_test',
      fetch: fetcher,
    });

    await expect(provider.send(input)).resolves.toEqual({
      status: 'SENT',
      providerMessageId: 'resend-message-id',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Idempotency-Key': input.idempotencyKey,
          'User-Agent': 'eduvoucher-api/1.0',
        }),
      }),
    );
  });

  it('normalizes an ambiguous provider timeout', async () => {
    const provider = new ResendEmailProvider({
      apiKey: 're_test',
      fetch: jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockRejectedValue(new Error('timeout')),
    });

    await expect(provider.send(input)).resolves.toEqual({
      status: 'FAILED',
      category: 'UNKNOWN_OUTCOME',
    });
  });

  it('maps PDF and CSV attachments into the Resend request', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'resend-message-id' }), {
          status: 200,
        }),
      );
    const provider = new ResendEmailProvider({
      apiKey: 're_test',
      fetch: fetcher,
    });
    await provider.send({
      ...input,
      attachments: [
        {
          contentBase64: Buffer.from('%PDF-test').toString('base64'),
          contentType: 'application/pdf',
          filename: 'voucher.pdf',
        },
      ],
    });

    const request = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual(
      expect.objectContaining({
        attachments: [
          {
            content: Buffer.from('%PDF-test').toString('base64'),
            content_type: 'application/pdf',
            filename: 'voucher.pdf',
          },
        ],
      }),
    );
  });
});
