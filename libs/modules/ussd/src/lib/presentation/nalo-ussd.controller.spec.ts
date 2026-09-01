import { NotFoundException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { StructuredLogger } from '@edu-api/observability';

import type { UssdFlowService } from '../application/ussd-flow-service';
import type { UssdProvider } from '../application/ussd-provider';
import { NaloGatewayAccessPolicy } from '../infrastructure/nalo-gateway-access-policy';
import { NaloUssdController } from './nalo-ussd.controller';

describe('NaloUssdController', () => {
  it('rejects an untrusted source before parsing attacker-controlled USSD data', async () => {
    const provider = providerMock();
    const controller = new NaloUssdController(
      provider,
      flowMock(),
      new NaloGatewayAccessPolicy({
        enabled: true,
        trustedSourceIps: '203.0.113.10',
      }),
      loggerMock(),
    );

    await expect(
      controller.handleSession(
        Buffer.from(JSON.stringify({ USERID: 'NALOTest' })),
        request('198.51.100.10'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(provider.parseRequest).not.toHaveBeenCalled();
  });

  it('continues to serve a configured Nalo gateway source', async () => {
    const provider = providerMock();
    const controller = new NaloUssdController(
      provider,
      flowMock(),
      new NaloGatewayAccessPolicy({
        enabled: true,
        trustedSourceIps: '203.0.113.10',
      }),
      loggerMock(),
    );

    await expect(
      controller.handleSession(
        Buffer.from(JSON.stringify({ USERID: 'NALOTest' })),
        request('203.0.113.10'),
      ),
    ).resolves.toEqual({ MSG: 'Hello' });
  });

  it('accepts a trusted USERID request without an optional IP allowlist', async () => {
    const provider = providerMock();
    const controller = new NaloUssdController(
      provider,
      flowMock(),
      new NaloGatewayAccessPolicy({ enabled: true }),
      loggerMock(),
    );

    await expect(
      controller.handleSession(
        Buffer.from(JSON.stringify({ USERID: 'NALOTest' })),
        request('198.51.100.10'),
      ),
    ).resolves.toEqual({ MSG: 'Hello' });
  });
});

function providerMock(): jest.Mocked<UssdProvider> {
  return {
    buildResponse: jest.fn().mockReturnValue({ MSG: 'Hello' }),
    parseRequest: jest.fn().mockReturnValue({
      input: '714*5#',
      isNewSession: true,
      msisdn: '233244123456',
    }),
  };
}

function flowMock(): jest.Mocked<UssdFlowService> {
  return {
    handle: jest.fn().mockResolvedValue({
      continueSession: false,
      message: 'Hello',
    }),
  } as unknown as jest.Mocked<UssdFlowService>;
}

function loggerMock(): StructuredLogger {
  return { error: jest.fn() } as unknown as StructuredLogger;
}

function request(ip: string): FastifyRequest {
  return { ip } as FastifyRequest;
}
