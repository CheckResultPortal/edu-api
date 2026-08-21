export const STOCK_MONITORING_SERVICE = Symbol('STOCK_MONITORING_SERVICE');

export interface StockMonitoringRunResult {
  readonly evaluatedProducts: number;
  readonly passCompleted: boolean;
  readonly raisedAlerts: number;
}

export interface StockMonitoringService {
  processAvailable(maximumProducts: number): Promise<StockMonitoringRunResult>;
}
