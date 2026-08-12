import { StructuredLogger } from './structured-logger';

describe('StructuredLogger', () => {
  it('writes safe structured request fields', () => {
    const output = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const logger = new StructuredLogger({
      environment: 'test',
      level: 'log',
      service: 'public-api',
    });

    logger.request({
      correlationId: 'request-1',
      durationMs: 12,
      method: 'GET',
      route: '/api/v1/health',
      statusCode: 200,
    });

    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('"correlationId":"request-1"'),
    );
    output.mockRestore();
  });
});
