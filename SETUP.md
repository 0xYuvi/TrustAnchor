# TrustAnchor — Teammate Setup Guide

## Prerequisites

- Git
- Python 3.13+
- Node.js 18+
- Go 1.24+
- AlgoKit CLI
- Docker (for localnet)

## Step 1 — Clone the repo

```bash
git clone https://github.com/0xYuvi/TrustAnchor.git
cd TrustAnchor
```

## Step 2 — Install vibekit (for MCP blockchain tools)

```bash
pip install vibekit
```

Verify it works:

```bash
vibekit --help
```

## Step 3 — Configure OpenCode MCP

Copy the example config to your **project root** (the folder containing `TrustAnchor/`):

```bash
cp TrustAnchor/opencode.example.json ./opencode.json
```

Then open `opencode.json` and make sure vibekit's path is correct. If `which vibekit` returns a path other than a standard location, update the command accordingly:

```json
{
  "mcp": {
    "vibekit-mcp": {
      "type": "local",
      "command": ["vibekit", "mcp"],
      "enabled": true
    }
  }
}
```

The kappa MCP server will prompt you for OAuth authentication the first time you use it — follow the browser flow.

## Step 4 — Install project dependencies

```bash
cd TrustAnchor

# Python backend
cd projects/TrustAnchor-backend
pip install -r requirements.txt
cd ../..

# Frontend
cd projects/TrustAnchor-frontend
npm install
cd ../..

# Smart contracts
algokit project bootstrap all

# ZKP circuits
cd circuits
go mod download
go build -o prover ./cmd/prover
./prover setup --dir ./keys
cd ..
```

## Step 5 — Environment variables

```bash
cd projects/TrustAnchor-backend
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description | Default |
|----------|-------------|---------|
| `TRUST_ANCHOR_ADDRESS` | Issuer payment address | Required |
| `ALGORAND_NETWORK` | Network | `testnet` |
| `USDC_ASSET_ID` | USDC ASA ID (mainnet: 31566704, testnet: 10458941) | `31566704` |
| `KYC_ORACLE_MNEMONIC` | 25-word mnemonic (optional, simulated anchors without it) | — |
| `TRUTH_REGISTRY_APP_ID` | Deployed contract ID | `758839639` |
| `INSTITUTION_API_KEYS` | Comma-separated API keys for institutions | — |

## Step 6 — Run localnet

```bash
algokit localnet start
```

## Step 7 — Run the demo

```bash
python demo.py
```

## Step 8 — Everyone's task assignments

See `TASKS.md` for your assigned files and changes.

### Quick reference

- **Member 1**: `pricing.py`, `payment_verifier.py`, `recruiter_agent.py`, `main.py` (payment parts)
- **Member 2**: `main.py` (flow endpoints), `kyc_agent.py`, `trust_anchor/contract.py`, `demo.py`
- **Member 3**: Frontend (`TrustAnchorApp.tsx`, components, utils), docs (README, PROJECT, USAGE), `opencode.example.json`, `SETUP.md`
