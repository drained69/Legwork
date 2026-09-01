import { config } from '../config.js';

export interface PricedService {
  id: string;
  method: 'POST';
  path: string;
  description: string;
  priceUsd: string;
  priceAtomic: string;
}

const atomic = (dollars: number): string => String(Math.round(dollars * 10 ** config.payments.assetDecimals));

export const PRICED_SERVICES: PricedService[] = [
  { id: 'job-hunt', method: 'POST', path: '/api/hunt', description: 'Ranked shortlist of up to 10 jobs with full score explanations.', priceUsd: '0.01', priceAtomic: atomic(0.01) },
  { id: 'score-posting', method: 'POST', path: '/api/score', description: 'Score one job posting against your saved profile.', priceUsd: '0.01', priceAtomic: atomic(0.01) },
  { id: 'tailor-application', method: 'POST', path: '/api/tailor', description: 'Create a tailored resume, cover letter, and application email.', priceUsd: '0.01', priceAtomic: atomic(0.01) },
  // Priced above the others because a Redflag report BUYS up to four live
  // miner answers through Telegraph (~$0.04 at floor prices) on top of the
  // local scan and comp benchmark.
  { id: 'redflag-vetting', method: 'POST', path: '/api/redflag', description: 'Due diligence on one job posting or offer: live scam, news, URL and fact checks through Telegraph miners, plus a comp benchmark and verdict card.', priceUsd: '0.05', priceAtomic: atomic(0.05) },
];

export function findService(method: string | undefined, path: string): PricedService | undefined {
  return PRICED_SERVICES.find((service) => service.method === method && service.path === path);
}

export function serviceById(id: string): PricedService | undefined {
  return PRICED_SERVICES.find((service) => service.id === id);
}

export function serviceCatalog(): Record<string, unknown> {
  return {
    agent: 'Legwork',
    category: 'Resume & Career Workflows',
    chain: { name: 'Base Sepolia', chainId: config.payments.chainId, rpcUrl: config.payments.rpcUrl },
    payment: {
      type: 'direct ERC-20 transfer',
      network: config.payments.network,
      asset: config.payments.asset,
      assetSymbol: config.payments.assetSymbol,
      payTo: config.payments.payTo,
      settlementAvailable: Boolean(config.payments.asset && config.payments.payTo),
    },
    freeTier: { endpoint: 'POST /api/hunt/preview', limitPerHour: 3 },
    services: PRICED_SERVICES.map((service) => ({
      id: service.id,
      endpoint: `${service.method} ${service.path}`,
      priceUsd: service.priceUsd,
      priceAtomic: service.priceAtomic,
      description: service.description,
    })),
  };
}
