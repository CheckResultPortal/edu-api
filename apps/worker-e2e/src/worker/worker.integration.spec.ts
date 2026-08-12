import { validateWorkerEnvironment } from '@edu-api/config';

describe('Worker integration', () => {
  it('accepts its required worker environment', () => {
    expect(
      validateWorkerEnvironment({
        LOG_LEVEL: 'error',
        NODE_ENV: 'test',
        SERVICE_NAME: 'worker',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toMatchObject({
      NODE_ENV: 'test',
      SERVICE_NAME: 'worker',
    });
  });
});
