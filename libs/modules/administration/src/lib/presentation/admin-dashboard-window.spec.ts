import { AdminOperationsController } from './admin-operations.controller';

describe('dashboard reporting window', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());
  function setup() {
    const getDashboard = jest.fn().mockResolvedValue({});
    return {
      getDashboard,
      controller: new AdminOperationsController(
        { getDashboard } as never,
        {} as never,
      ),
    };
  }
  it('defaults to all recorded sales rather than a moving 24-hour period', async () => {
    const { controller, getDashboard } = setup();
    await controller.dashboard(undefined, undefined);
    expect(getDashboard).toHaveBeenCalledWith({
      from: new Date(0),
      to: new Date('2026-09-06T12:00:00Z'),
    });
  });
  it('supports custom multi-year dates without shifting the requested boundaries', async () => {
    const { controller, getDashboard } = setup();
    await controller.dashboard('2024-01-01T00:00:00Z', '2026-09-07T00:00:00Z');
    expect(getDashboard).toHaveBeenCalledWith({
      from: new Date('2024-01-01T00:00:00Z'),
      to: new Date('2026-09-07T00:00:00Z'),
    });
  });
  it.each([
    ['2026-09-07', '2026-09-06', undefined],
    ['bad', '2026-09-06', undefined],
    ['2026-09-06', '2026-09-06', undefined],
    ['2026-09-01', undefined, 'all'],
    [undefined, undefined, 'unknown'],
  ])(
    'rejects invalid or conflicting reporting boundaries',
    async (from, to, range) => {
      const { controller, getDashboard } = setup();
      await expect(controller.dashboard(from, to, range)).rejects.toThrow();
      expect(getDashboard).not.toHaveBeenCalled();
    },
  );
});
