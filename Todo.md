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
- [ ] Set Railway secrets and complete the final deploy
- [ ] Fund a dedicated registering wallet with Base Sepolia ETH
- [ ] Choose the MACHINA `FEE_ADDRESS`
- [ ] Register `legwork-job-hunter` on Telegraph
- [ ] Confirm activation in `https://devnode.telegraphprotocol.com/api/miners`
- [ ] Monitor first-week grace-period traffic, errors and validator scores
