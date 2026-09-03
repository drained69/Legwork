# Legwork Deployment Checklist

- [x] Remove the previous task-routing integration and runtime dependencies
- [x] Add Telegraph miner endpoints and a byte-stable `miner.yaml`
- [x] Add direct Base Sepolia ERC-20 payment verification
- [x] Add Telegram self-custody testnet wallet support
- [x] Add miner route and YAML tests
- [x] Set every paid service and Telegraph floor to $0.01
- [x] Set the final public origin in `miner.yaml`
- [ ] Validate `miner.yaml` at `integrate.telegraphprotocol.com`
- [x] Create a separate Railway `legwork` project and public domain
- [x] Set Railway secrets and complete the final deploy (TELEGRAPH_PRIVATE_KEY + TRUST_PROXY, 2026-09-03)
- [x] Fund a dedicated registering wallet with Base Sepolia ETH
- [x] Choose the MACHINA `FEE_ADDRESS`
- [x] Register `legwork-job-hunter` on Telegraph
- [x] Confirm activation in `https://devnode.telegraphprotocol.com/api/miners`
- [x] Monitor first-week grace-period traffic, errors and validator scores
- [x] E2E verified 2026-09-03: local suite (123 tests) + `scripts/e2e-check.ts` (live boards, Gemini, CoinGecko, real USDC engine spend) + production (miner surface, web vetting, report pages, stats)
