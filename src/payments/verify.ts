import { Contract, Interface, JsonRpcProvider, getAddress } from 'ethers';
import { config } from '../config.js';
import { audit, consumeNonce, now, savePayment, uid } from '../db.js';
import type { PricedService } from './services.js';

const transferInterface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

export async function verifyServicePayment(
  transactionHash: string,
  payer: string,
  service: PricedService,
): Promise<{ ok: boolean; error?: string }> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) return { ok: false, error: 'Invalid transaction hash' };
  if (!config.payments.asset || !config.payments.payTo) return { ok: false, error: 'Service payments are not configured' };

  const provider = new JsonRpcProvider(config.payments.rpcUrl, config.payments.chainId, { staticNetwork: true });
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (!receipt || receipt.status !== 1) return { ok: false, error: 'Payment is not confirmed' };
  if ((await receipt.confirmations()) < config.payments.confirmations) return { ok: false, error: 'Payment needs more confirmations' };

  const asset = getAddress(config.payments.asset);
  const payTo = getAddress(config.payments.payTo);
  const from = getAddress(payer);
  let paid = 0n;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== asset) continue;
    try {
      const parsed = transferInterface.parseLog(log);
      if (parsed && getAddress(String(parsed.args.from)) === from && getAddress(String(parsed.args.to)) === payTo) {
        paid += BigInt(parsed.args.value);
      }
    } catch {
      // Ignore unrelated logs emitted by the token contract.
    }
  }
  if (paid < BigInt(service.priceAtomic)) return { ok: false, error: `Payment is below the ${service.priceUsd} ${config.payments.assetSymbol} price` };
  if (!consumeNonce(`base-sepolia:${transactionHash.toLowerCase()}`)) return { ok: false, error: 'Payment transaction has already been used' };

  savePayment({ id: uid(), kind: 'service_charge', amount: service.priceAtomic, currency: config.payments.assetSymbol, raw: JSON.stringify({ service: service.id, payer: from, transactionHash }), at: now() });
  audit('payments', 'VERIFIED', `service=${service.id} payer=${from} tx=${transactionHash}`);
  return { ok: true };
}
