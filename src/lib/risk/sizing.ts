/** Price per share in account currency. GBX quotes are pence; fxToAccount converts the major currency (1 if same). */
export function unitCostInAccountCcy(price: number, instrumentCurrency: string, fxToAccount: number): number {
  const major = instrumentCurrency === "GBX" ? price / 100 : price;
  return major * fxToAccount;
}

/** Fractional quantity rounded DOWN to `step` so we never exceed the allowed value. 0 if it doesn't fit. */
export function quantityFor(investValue: number, unitCost: number, step = 0.01): number {
  if (!(investValue > 0) || !(unitCost > 0)) return 0;
  const q = Math.floor(investValue / unitCost / step + 1e-9) * step;
  return Number(q.toFixed(4));
}
