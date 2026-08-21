import {
  stockLevelFor,
  transitionStockMonitoringState,
} from './stock-monitoring-transition';

describe('stock monitoring transitions', () => {
  it('raises LOW exactly once when a healthy product crosses its threshold', () => {
    const low = transitionStockMonitoringState(
      {
        depletionCycle: 0,
        emptyAlertedCycle: null,
        lowAlertedCycle: null,
        state: 'NORMAL',
      },
      stockLevelFor(2, 2),
    );
    const repeated = transitionStockMonitoringState(low, 'LOW');

    expect(low).toEqual({
      depletionCycle: 1,
      emptyAlertedCycle: null,
      eventType: 'StockLow',
      lowAlertedCycle: 1,
      state: 'LOW',
    });
    expect(repeated.eventType).toBeNull();
  });

  it('does not repeat EMPTY after a partial restock within one depletion cycle', () => {
    const empty = transitionStockMonitoringState(
      {
        depletionCycle: 1,
        emptyAlertedCycle: null,
        lowAlertedCycle: 1,
        state: 'LOW',
      },
      'EMPTY',
    );
    const partialRestock = transitionStockMonitoringState(empty, 'LOW');
    const emptyAgain = transitionStockMonitoringState(partialRestock, 'EMPTY');

    expect(empty.eventType).toBe('StockEmpty');
    expect(partialRestock.eventType).toBeNull();
    expect(emptyAgain.eventType).toBeNull();
    expect(emptyAgain.emptyAlertedCycle).toBe(1);
  });

  it('emits recovery and starts a new depletion cycle after healthy restock', () => {
    const recovered = transitionStockMonitoringState(
      {
        depletionCycle: 1,
        emptyAlertedCycle: 1,
        lowAlertedCycle: 1,
        state: 'EMPTY',
      },
      'NORMAL',
    );
    const nextLow = transitionStockMonitoringState(recovered, 'LOW');

    expect(recovered.eventType).toBe('StockRecovered');
    expect(nextLow).toMatchObject({
      depletionCycle: 2,
      eventType: 'StockLow',
      lowAlertedCycle: 2,
      state: 'LOW',
    });
  });

  it('raises EMPTY directly when stock reaches zero before low is observed', () => {
    expect(
      transitionStockMonitoringState(
        {
          depletionCycle: 0,
          emptyAlertedCycle: null,
          lowAlertedCycle: null,
          state: 'NORMAL',
        },
        stockLevelFor(0, 5),
      ),
    ).toMatchObject({ depletionCycle: 1, eventType: 'StockEmpty' });
  });
});
