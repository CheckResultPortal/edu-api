import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

describe('WorkerModule', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
      LOG_LEVEL: 'error',
      NODE_ENV: 'test',
      REDIS_URL: 'redis://localhost:6379',
      SERVICE_NAME: 'worker',
    };
  });

  afterEach(() => {
    process.env = originalEnvironment;
  });

  it('boots as a Nest application context with validated configuration', async () => {
    const { WorkerModule } = await import('./worker.module');
    const worker = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });

    try {
      const config = worker.get(ConfigService);

      expect(config.getOrThrow('SERVICE_NAME')).toBe('worker');
      expect(config.getOrThrow('NODE_ENV')).toBe('test');
    } finally {
      await worker.close();
    }
  });
});
