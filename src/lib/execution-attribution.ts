export interface AttributionOrder {
  side: "BUY" | "SELL";
  quantity: number;
  filledQuantity: number | null;
  referencePrice: number | null;
  spreadPct: number | null;
  slippagePct: number | null;
}

const majorPrice = (price: number, currency: string) => (currency === "GBX" ? price / 100 : price);

export function priceAndFxAttribution(input: {
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  instrumentCurrency: string;
  entryFxRate: number;
  exitFxRate: number;
}) {
  const entry = majorPrice(input.entryPrice, input.instrumentCurrency);
  const exit = majorPrice(input.exitPrice, input.instrumentCurrency);
  return {
    grossPnl: input.quantity * (exit - entry) * input.entryFxRate,
    fxImpact: input.quantity * exit * (input.exitFxRate - input.entryFxRate),
  };
}

export function executionCosts(
  orders: AttributionOrder[],
  instrumentCurrency: string,
  entryFxRate: number,
  exitFxRate: number,
) {
  let estimatedSpreadCost = 0;
  let slippageCost = 0;
  let hasSpread = false;
  let hasSlippage = false;
  for (const order of orders) {
    const quantity = order.filledQuantity ?? order.quantity;
    if (!(quantity > 0) || !(order.referencePrice != null && order.referencePrice > 0)) continue;
    const fx = order.side === "BUY" ? entryFxRate : exitFxRate;
    const notional = quantity * majorPrice(order.referencePrice, instrumentCurrency) * fx;
    if (order.spreadPct != null) {
      estimatedSpreadCost += notional * order.spreadPct / 200;
      hasSpread = true;
    }
    if (order.slippagePct != null) {
      slippageCost += notional * Math.max(0, order.slippagePct) / 100;
      hasSlippage = true;
    }
  }
  return {
    estimatedSpreadCost: hasSpread ? estimatedSpreadCost : null,
    slippageCost: hasSlippage ? slippageCost : null,
  };
}
