export type StockLevel = 'NORMAL' | 'LOW' | 'EMPTY';

export type StockAlertEventType = 'StockLow' | 'StockEmpty' | 'StockRecovered';

export interface StockMonitoringStateSnapshot {
  readonly depletionCycle: number;
  readonly emptyAlertedCycle: number | null;
  readonly lowAlertedCycle: number | null;
  readonly state: StockLevel;
}

export interface StockMonitoringTransition {
  readonly depletionCycle: number;
  readonly emptyAlertedCycle: number | null;
  readonly eventType: StockAlertEventType | null;
  readonly lowAlertedCycle: number | null;
  readonly state: StockLevel;
}

export function stockLevelFor(
  availableStock: number,
  lowStockThreshold: number,
): StockLevel {
  if (!Number.isSafeInteger(availableStock) || availableStock < 0) {
    throw new Error('availableStock must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(lowStockThreshold) || lowStockThreshold < 0) {
    throw new Error('lowStockThreshold must be a non-negative safe integer.');
  }
  if (availableStock === 0) return 'EMPTY';
  return availableStock <= lowStockThreshold ? 'LOW' : 'NORMAL';
}

export function transitionStockMonitoringState(
  current: StockMonitoringStateSnapshot,
  nextState: StockLevel,
): StockMonitoringTransition {
  assertState(current);
  if (current.state === nextState) {
    return {
      depletionCycle: current.depletionCycle,
      emptyAlertedCycle: current.emptyAlertedCycle,
      eventType: null,
      lowAlertedCycle: current.lowAlertedCycle,
      state: nextState,
    };
  }

  const depletionCycle =
    current.state === 'NORMAL' && nextState !== 'NORMAL'
      ? current.depletionCycle + 1
      : current.depletionCycle;
  let lowAlertedCycle = current.lowAlertedCycle;
  let emptyAlertedCycle = current.emptyAlertedCycle;
  let eventType: StockAlertEventType | null = null;

  if (nextState === 'LOW' && current.state === 'NORMAL') {
    lowAlertedCycle = depletionCycle;
    eventType = 'StockLow';
  } else if (
    nextState === 'EMPTY' &&
    current.state !== 'EMPTY' &&
    emptyAlertedCycle !== depletionCycle
  ) {
    emptyAlertedCycle = depletionCycle;
    eventType = 'StockEmpty';
  } else if (nextState === 'NORMAL' && current.state !== 'NORMAL') {
    eventType = 'StockRecovered';
  }

  return {
    depletionCycle,
    emptyAlertedCycle,
    eventType,
    lowAlertedCycle,
    state: nextState,
  };
}

function assertState(state: StockMonitoringStateSnapshot): void {
  if (!Number.isSafeInteger(state.depletionCycle) || state.depletionCycle < 0) {
    throw new Error('depletionCycle must be a non-negative safe integer.');
  }
  for (const cycle of [state.lowAlertedCycle, state.emptyAlertedCycle]) {
    if (
      cycle !== null &&
      (!Number.isSafeInteger(cycle) ||
        cycle < 1 ||
        cycle > state.depletionCycle)
    ) {
      throw new Error('alerted cycles must refer to a depletion cycle.');
    }
  }
}
