/**
 * The x402 payment layer.
 *
 * The chain facts live in `chains.ts`. This module turns a chain into the
 * money terms the facilitator verifies against: the asset, its base units, and
 * the EIP-712 domain, which must match the token contract exactly.
 */
import type { AssetAmount, MoneyParser, Network } from "@x402/core/types";
import { toBaseUnits } from "./units.js";
import type { SettlementChain } from "./chains.js";

export const FACILITATOR_URL = "https://facilitator.pieverse.io/v2";

/**
 * Prices are written as dollars and converted to the asset's base units with
 * integer maths, so no float ever reaches a settlement amount.
 */
export function parsePrice(
  price: string,
  chain: SettlementChain,
): AssetAmount {
  const units = toBaseUnits(price, chain.assetDecimals);
  if (BigInt(units) <= 0n) {
    throw new Error(`price ${price} is below one unit of ${chain.assetSymbol}`);
  }
  return {
    asset: chain.assetAddress,
    amount: units,
    extra: { name: chain.eip712Name, version: chain.eip712Version },
  };
}

/**
 * Lets routes be priced as "$0.001" on any chain in the registry.
 *
 * The x402 SDK only knows default stablecoins for a fixed set of chains; this
 * pins the EIP-712 domain the facilitator expects for the ones we support.
 */
export function chainMoneyParser(
  chain: SettlementChain,
): MoneyParser {
  return async (
    amount: string | number,
    network: Network,
  ): Promise<AssetAmount | null> => {
    if (network !== chain.network) return null;
    const text =
      typeof amount === "number"
        ? amount.toFixed(chain.assetDecimals)
        : amount.trim().replace(/^\$/, "");
    if (!/^\d+(\.\d+)?$/.test(text)) {
      throw new Error(`price must be a positive decimal, got ${amount}`);
    }
    if (BigInt(toBaseUnits(text, chain.assetDecimals)) <= 0n) {
      throw new Error(`price must be above zero, got ${amount}`);
    }
    return parsePrice(text, chain);
  };
}
