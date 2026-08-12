import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { SERVICE_DEPENDENCIES } from './service-dependencies';
import { HealthService } from './health.module';

describe('HealthService', () => {
  it('reports the configured service name and closes dependencies on shutdown', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn().mockReturnValue('public-api') },
        },
        {
          provide: SERVICE_DEPENDENCIES,
          useValue: { close, database: {}, redis: {} },
        },
      ],
    }).compile();
    const service = module.get(HealthService);

    expect(service.getHealth()).toEqual({
      status: 'ok',
      service: 'public-api',
    });

    await service.onApplicationShutdown();

    expect(close).toHaveBeenCalledTimes(1);
  });
});
