#!/usr/bin/env bash
# Register Legwork as a Telegraph miner on Base Sepolia.
#
# Prereqs:
#   - foundry (cast)   → https://getfoundry.sh
#   - the deployment is live and serving the YAML at PUBLIC_URL/miner.yaml
#   - MINER_PRIVATE_KEY holds a wallet with a little Base Sepolia ETH for gas
#   - FEE_ADDRESS receives MACHINA payouts (defaults to the registering wallet)
#
# Usage:
#   scripts/register-miner.sh --dry-run   # show the tx that would be sent
#   scripts/register-miner.sh             # register for real
#   scripts/register-miner.sh --update <registrationId>   # updateMiner after a YAML change
#
# Docs: https://docs.telegraphprotocol.com/docs/miners/miner-registration
set -euo pipefail

DIAMOND="${DIAMOND:-0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8}"
RPC="${RPC:-https://sepolia.base.org}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
YAML_FILE="${YAML_FILE:-$ROOT/miner.yaml}"
PUBLIC_URL="${PUBLIC_URL:-https://legwork-production-88e5.up.railway.app}"
MIN_PRICE="${MIN_PRICE:-10000}" # 0.01 USDC in 6-decimal units
INTENTS='["WEB_SEARCH","RESEARCH_SYNTHESIS","TEXT_GENERATION"]'

DRY_RUN=0
UPDATE_ID=""
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  --update) UPDATE_ID="${2:?--update needs a registrationId}" ;;
esac

: "${MINER_PRIVATE_KEY:?MINER_PRIVATE_KEY must be set (Base Sepolia wallet with gas ETH)}"
FEE_ADDRESS="${FEE_ADDRESS:-$(cast wallet address "$MINER_PRIVATE_KEY")}"

# SHA-256 of the raw YAML bytes — must match what the deployment serves.
YAML_URL="$PUBLIC_URL/miner.yaml"
YAML_HASH="0x$(shasum -a 256 "$YAML_FILE" | awk '{print $1}')"

echo "slug:        legwork-job-hunter"
echo "yaml url:    $YAML_URL"
echo "yaml hash:   $YAML_HASH"
echo "fee address: $FEE_ADDRESS"
echo "min price:   $MIN_PRICE (6-dec USDC)"
echo "intents:     $INTENTS"

# The served bytes must match the hashed bytes, or activation fails on hash
# mismatch. Fetch and compare.
if command -v curl >/dev/null 2>&1; then
  SERVED_HASH="0x$(curl -fsSL "$YAML_URL" | shasum -a 256 | awk '{print $1}')"
  if [ "$SERVED_HASH" = "$YAML_HASH" ]; then
    echo "served yaml: matches local hash ✓"
  else
    echo "ERROR: $YAML_URL serves hash $SERVED_HASH — deploy before registering." >&2
    exit 1
  fi
fi

# Every intent must be canonical or the transaction reverts.
for intent in WEB_SEARCH RESEARCH_SYNTHESIS TEXT_GENERATION; do
  ok=$(cast call "$DIAMOND" "isCanonicalIntent(string)(bool)" "$intent" --rpc-url "$RPC")
  [ "$ok" = "true" ] || { echo "ERROR: $intent is not a canonical intent" >&2; exit 1; }
done
echo "intents canonical ✓"

if [ "$DRY_RUN" = 1 ]; then
  echo "dry run — no transaction sent"
  exit 0
fi

if [ -n "$UPDATE_ID" ]; then
  cast send "$DIAMOND" \
    "updateMiner(uint256,string,bytes32,address,uint256,string[])" \
    "$UPDATE_ID" "$YAML_URL" "$YAML_HASH" "$FEE_ADDRESS" "$MIN_PRICE" "$INTENTS" \
    --rpc-url "$RPC" --private-key "$MINER_PRIVATE_KEY"
else
  cast send "$DIAMOND" \
    "registerMiner(string,bytes32,address,uint256,string[])" \
    "$YAML_URL" "$YAML_HASH" "$FEE_ADDRESS" "$MIN_PRICE" "$INTENTS" \
    --rpc-url "$RPC" --private-key "$MINER_PRIVATE_KEY"
fi

echo ""
echo "Registration sent. Nodes activate on the event (usually <1 min)."
echo "Verify activation:"
echo "  curl -s https://devnode.telegraphprotocol.com/api/miners | jq '.[] | select(.slug==\"legwork-job-hunter\") | {id, activation_status, rejection_reason}'"
