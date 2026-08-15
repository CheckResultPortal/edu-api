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
      ADMIN_APPLICATION_ORIGIN: 'https://admin.example.com',
      ADMIN_SESSION_HMAC_KEY: '0123456789012345678901234567890123456789012',
      ADMIN_SECRET_ENCRYPTION_KEY_ID: 'test-v1',
      ADMIN_SECRET_ENCRYPTION_KEY:
        '0123456789012345678901234567890123456789012',
      VOUCHER_SECRET_ENCRYPTION_KEY_ID: 'test-v1',
      VOUCHER_SECRET_ENCRYPTION_KEY:
        '0123456789012345678901234567890123456789012',
      VOUCHER_PIN_FINGERPRINT_KEY:
        'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      RESEND_API_KEY: 're_test',
      RESEND_FROM_EMAIL: 'EduVoucher <admin@example.com>',
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
