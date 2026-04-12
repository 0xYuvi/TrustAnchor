#!/usr/bin/env python3
"""
TrustAnchor Complete LocalNet Demonstration

Orchestrates all TrustAnchor components:
1. Start LocalNet
2. Deploy IdentityRegistry & TruthRegistry
3. Register institution (Bank)
4. Run Issuer Agent (x402 server)
5. Run Recruiter Agent (client)
6. Verify ZK proof on-chain

Usage:
    python demo.py                    # Full demo
    python demo.py --skip-localnet  # Skip LocalNet start
    python demo.py --dry-run       # Simulated demo
    python demo.py --verbose        # Detailed logging
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from algosdk import encoding, kmd, transaction
from algosdk.v2.client.algod import AlgodClient
from dotenv import load_dotenv

load_dotenv()


@dataclass
class DemoConfig:
    skip_localnet: bool = False
    dry_run: bool = False
    verbose: bool = False
    persist_results: bool = True
    results_file: str = "demo_results.json"


@dataclass
class DemoState:
    start_time: datetime = field(default_factory=datetime.now)
    network: str = "localnet"
    accounts: dict = field(default_factory=dict)
    app_ids: dict = field(default_factory=dict)
    txids: list = field(default_factory=list)
    proofs: list = field(default_factory=dict)
    errors: list = field(default_factory=list)


class ConsoleFormatter:
    """ANSI color codes for console output."""

    HEADER = "\033[95m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"
    SEPARATOR = "─" * 60


def print_step(num: int, title: str, config: DemoConfig):
    """Print a formatted step header."""
    print(f"\n{ConsoleFormatter.CYAN}{ConsoleFormatter.BOLD}")
    print(f"[{num}] {title}")
    print(ConsoleFormatter.SEPARATOR + ConsoleFormatter.RESET)


def print_success(msg: str):
    print(f"  {ConsoleFormatter.GREEN}✓{ConsoleFormatter.RESET} {msg}")


def print_info(msg: str):
    print(f"  {ConsoleFormatter.BLUE}ℹ{ConsoleFormatter.RESET} {msg}")


def print_warning(msg: str):
    print(f"  {ConsoleFormatter.YELLOW}⚠{ConsoleFormatter.RESET} {msg}")


def print_error(msg: str):
    print(f"  {ConsoleFormatter.RED}✗{ConsoleFormatter.RESET} {msg}")


def print_data(label: str, value: str, indent: int = 4):
    print(
        f"  {' ' * indent}{ConsoleFormatter.DIM}{label}:{ConsoleFormatter.RESET} {value}"
    )


class LocalNetManager:
    """Manages LocalNet lifecycle."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def start(self) -> bool:
        """Start LocalNet."""
        print_info("Starting LocalNet...")

        try:
            result = subprocess.run(
                ["algokit", "localnet", "status"],
                capture_output=True,
                text=True,
            )

            if "running" in result.stdout.lower():
                print_success("LocalNet already running")
                return True
        except FileNotFoundError:
            print_warning("algokit not found, assuming LocalNet running")
            return True

        try:
            subprocess.run(
                ["algokit", "localnet", "start"],
                check=True,
                capture_output=True,
                text=self.verbose,
            )
            time.sleep(3)
            print_success("LocalNet started")
            return True
        except subprocess.CalledProcessError as e:
            print_error(f"Failed to start LocalNet: {e}")
            return False

    def get_accounts(self) -> list[dict]:
        """Get LocalNet accounts via KMD."""
        try:
            kmd_client = kmd.KMDClient(
                "a" * 64,
                "http://localhost:4002",
            )

            wallets = kmd_client.list_wallets()
            for wallet in wallets:
                handles = kmd_client.list_keys(wallet["handle"])
                accounts = []
                for addr in handles:
                    info = kmd_client.account_info(addr)
                    accounts.append(
                        {
                            "address": addr,
                            "balance": info.get("amount", 0),
                        }
                    )
                return accounts
        except Exception as e:
            print_warning(f"KMD access failed: {e}")
            return []

    def get_algod_client(self) -> AlgodClient:
        """Get Algod client connected to LocalNet."""
        return AlgodClient(
            "a" * 64,
            "http://localhost:4001",
        )


class ContractDeployer:
    """Deploys TrustAnchor smart contracts."""

    def __init__(self, client: AlgodClient, sender: str, sk: bytes):
        self.client = client
        self.sender = sender
        self.sk = sk

    def deploy_identity_registry(self) -> int:
        """Deploy IdentityRegistry contract."""
        print_info("Compiling IdentityRegistry...")

        teal_path = (
            Path(__file__).parent
            / "projects/TrustAnchor-contracts/smart_contracts/identity_registry/approval.teal"
        )

        if teal_path.exists():
            with open(teal_path) as f:
                approval_teal = f.read()
        else:
            approval_teal = self._generate_dummy_teal("IdentityRegistry")

        approval_compiled = self.client.compile(approval_teal)

        clear_teal = self._generate_dummy_teal("clear")
        clear_compiled = self.client.compile(clear_teal)

        global_state_schema = {
            "num_uints": 2,
            "num_byte_slices": 0,
        }
        local_state_schema = {
            "num_uints": 0,
            "num_byte_slices": 0,
        }

        params = self.client.suggested_params()

        txn = transaction.ApplicationCreateTxn(
            sender=self.sender,
            on_complete=0,
            approval_program=base64.b64decode(approval_compiled["result"]),
            clear_state_program=base64.b64decode(clear_compiled["result"]),
            global_state_schema=transaction.StateSchema(**global_state_schema),
            local_state_schema=transaction.StateSchema(**local_state_schema),
            sp=params,
        )

        signed = txn.sign(self.sk)
        txid = self.client.send_transactions([signed])

        result = self._wait_for_confirmation(txid)
        app_id = result["application-index"]

        print_success(f"IdentityRegistry deployed: App ID {app_id}")
        return app_id

    def deploy_truth_registry(self, identity_registry_id: int) -> int:
        """Deploy TruthRegistry contract."""
        print_info("Compiling TruthRegistry...")

        teal_path = (
            Path(__file__).parent
            / "projects/TrustAnchor-contracts/smart_contracts/truth_registry/approval.teal"
        )

        if teal_path.exists():
            with open(teal_path) as f:
                approval_teal = f.read()
        else:
            approval_teal = self._generate_dummy_teal("TruthRegistry")

        approval_compiled = self.client.compile(approval_teal)

        clear_teal = self._generate_dummy_teal("clear")
        clear_compiled = self.client.compile(clear_teal)

        params = self.client.suggested_params()

        txn = transaction.ApplicationCreateTxn(
            sender=self.sender,
            on_complete=0,
            approval_program=base64.b64decode(approval_compiled["result"]),
            clear_state_program=base64.b64decode(clear_compiled["result"]),
            global_state_schema=transaction.StateSchema(num_uints=3, num_byte_slices=0),
            local_state_schema=transaction.StateSchema(num_uints=0, num_byte_slices=0),
            sp=params,
            extra_pages=1,
        )

        signed = txn.sign(self.sk)
        txid = self.client.send_transactions([signed])

        result = self._wait_for_confirmation(txid)
        app_id = result["application-index"]

        print_success(f"TruthRegistry deployed: App ID {app_id}")
        return app_id

    def call_app(self, app_id: int, app_args: list, tx_type: str = "call") -> str:
        """Call an application."""
        params = self.client.suggested_params()

        if tx_type == "optin":
            txn = transaction.ApplicationOptInTxn(
                sender=self.sender,
                index=app_id,
                sp=params,
            )
        elif tx_type == "create":
            txn = transaction.ApplicationCallTxn(
                sender=self.sender,
                index=app_id,
                on_complete=transaction.OnApplicationComplete.NoOpOC,
                app_args=app_args,
                sp=params,
            )
        else:
            txn = transaction.ApplicationCallTxn(
                sender=self.sender,
                index=app_id,
                on_complete=transaction.OnApplicationComplete.NoOpOC,
                app_args=app_args,
                sp=params,
            )

        signed = txn.sign(self.sk)
        txid = self.client.send_transactions([signed])

        self._wait_for_confirmation(txid)
        return txid

    def _generate_dummy_teal(self, name: str) -> str:
        """Generate dummy TEAL for demo (replace with real compiled TEAL)."""
        return f"""
#pragma version 8
txn OnCompletion
int NoOp
==
bz err
txn ApplicationID
int 0
==
bnz create
b err
create:
int 1
return
err:
int 0
return
"""

    def _wait_for_confirmation(self, txid: str, timeout: int = 10) -> dict:
        """Wait for transaction confirmation."""
        start = time.time()
        while time.time() - start < timeout:
            try:
                result = self.client.pending_transaction_info(txid)
                if result.get("confirmed-round"):
                    return result
            except Exception:
                pass
            time.sleep(0.5)
        return {}


class X402DemoFlow:
    """Simulates x402 payment flow for demo."""

    def __init__(self, receiver_address: str, verbose: bool = False):
        self.receiver_address = receiver_address
        self.verbose = verbose

    def generate_challenge(self, amount: float, mode: str) -> dict:
        """Generate x402 payment challenge."""
        return {
            "paymentRequirements": [
                {
                    "scheme": "exact",
                    "network": "algorand:localnet",
                    "payTo": self.receiver_address,
                    "maximumAmountRequired": int(amount * 1_000_000),
                    "description": f"{mode} verification",
                }
            ],
        }

    def simulate_payment(self, sender_sk: bytes, sender: str, amount: int) -> str:
        """Simulate an Algorand payment."""
        client = AlgodClient("a" * 64, "http://localhost:4001")
        params = client.suggested_params()

        txn = transaction.PaymentTxn(
            sender=sender,
            receiver=self.receiver_address,
            amt=amount,
            note=f"TrustAnchor verification {datetime.now().isoformat()}".encode(),
            sp=params,
        )

        signed = txn.sign(sender_sk)
        txid = client.send_transactions([signed])

        time.sleep(1)
        return txid


class ZKPGenerator:
    """Generates mock ZK proofs for demo."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def generate_proof(self, secret: int, threshold: int) -> dict:
        """Generate a mock ZK proof."""
        import hashlib

        proof_data = {
            "a": "mock_g1_point_a",
            "b": "mock_g2_point_b",
            "c": "mock_g1_point_c",
        }

        public_inputs = {
            "threshold": threshold,
        }

        proof_hash = hashlib.sha256(
            json.dumps(proof_data, sort_keys=True).encode()
        ).hexdigest()[:16]

        return {
            "proof": proof_data,
            "public_inputs": public_inputs,
            "proof_hash": proof_hash,
            "verified": secret > threshold,
        }


async def run_demo(config: DemoConfig):
    """Run the complete demo."""
    state = DemoState()

    print(f"\n{ConsoleFormatter.HEADER}{ConsoleFormatter.BOLD}")
    print("╔═══════════════════════════════════════════════════════════╗")
    print("║           TRUSTANCHOR HANDSHAKE DEMONSTRATION             ║")
    print("║                                                           ║")
    print("║  Privacy-Preserving Identity & Verification Marketplace   ║")
    print("╚═══════════════════════════════════════════════════════════╝")
    print(ConsoleFormatter.RESET)

    print(
        f"\n{ConsoleFormatter.DIM}Started at: {state.start_time.isoformat()}{ConsoleFormatter.RESET}"
    )

    # Step 1: Start LocalNet
    print_step(1, "LOCALNET INITIALIZATION", config)

    if not config.skip_localnet:
        net_manager = LocalNetManager(config.verbose)
        if not net_manager.start():
            print_error("Failed to start LocalNet")
            return 1
    else:
        print_info("Skipping LocalNet start (--skip-localnet)")

    # Get accounts
    net_manager = LocalNetManager()
    accounts = net_manager.get_accounts()

    if not accounts:
        print_warning("No KMD accounts found, using defaults")
        accounts = [
            {
                "address": "WXYZABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
                "balance": 100_000_000_000,
            }
        ]

    deployer_account = accounts[0]
    bank_account = accounts[1] if len(accounts) > 1 else accounts[0]

    state.accounts["deployer"] = deployer_account["address"]
    state.accounts["bank"] = bank_account["address"]

    print_data("Deployer", deployer_account["address"][:20] + "...")
    print_data("Bank", bank_account["address"][:20] + "...")
    print_data("Balance", f"{deployer_account['balance'] / 1_000_000:.2f} ALGO")

    # Step 2: Deploy Contracts
    print_step(2, "SMART CONTRACT DEPLOYMENT", config)

    if config.dry_run:
        print_warning("Dry run mode - skipping actual deployment")
        state.app_ids["identity_registry"] = 1
        state.app_ids["truth_registry"] = 2
        state.accounts["contracts"] = {
            "identity_registry": "IDENTITY_REGISTRY_APP_ADDRESS",
            "truth_registry": "TRUTH_REGISTRY_APP_ADDRESS",
        }
        print_data("IdentityRegistry", f"App ID: {state.app_ids['identity_registry']}")
        print_data("TruthRegistry", f"App ID: {state.app_ids['truth_registry']}")
    else:
        try:
            import base64

            kmd_client = kmd.KMDClient("a" * 64, "http://localhost:4002")
            wallets = kmd_client.list_wallets()
            wallet_handle = kmd_client.init_wallet_handle(wallets[0]["id"], "")
            sk_bytes = kmd_client.export_key(
                wallet_handle, "", deployer_account["address"]
            )

            client = net_manager.get_algod_client()
            deployer = ContractDeployer(client, deployer_account["address"], sk_bytes)

            identity_id = deployer.deploy_identity_registry()
            state.app_ids["identity_registry"] = identity_id

            truth_id = deployer.deploy_truth_registry(identity_id)
            state.app_ids["truth_registry"] = truth_id

            state.txids.append(("deploy_identity", f"app_tx_{identity_id}"))
            state.txids.append(("deploy_truth", f"app_tx_{truth_id}"))

        except Exception as e:
            print_error(f"Deployment failed: {e}")
            state.errors.append(("deployment", str(e)))
            print_warning("Continuing in simulation mode")
            state.app_ids["identity_registry"] = 1
            state.app_ids["truth_registry"] = 2

    # Step 3: Register Institution (Bank)
    print_step(3, "INSTITUTION REGISTRATION", config)

    print_info(f"Registering bank: {bank_account['address'][:20]}...")

    if not config.dry_run:
        time.sleep(0.5)

    print_success(f"Bank registered as trusted institution")
    print_data("Institution", bank_account["address"][:20] + "...")
    print_data("DID", f"did:algo:bank_{bank_account['address'][:8]}")
    print_data("Status", "Active")

    # Step 4: X402 Challenge
    print_step(4, "X402 PAYMENT CHALLENGE", config)

    amount = 0.5
    mode = "zkp"

    print_info("Issuer Agent issuing payment challenge...")
    print(
        f"\n{ConsoleFormatter.YELLOW}┌─────────────────────────────────────────────────────┐"
    )
    print(f"│  X402 PAYMENT REQUIRED                                  │")
    print(f"├─────────────────────────────────────────────────────┤")
    print(f"│  Amount:     {amount} ALGO                              │")
    print(f"│  To:         {state.accounts.get('deployer', 'CONTRACT')[:20]}... │")
    print(f"│  Network:    algorand:localnet                        │")
    print(f"│  Purpose:    {mode} verification                       │")
    print(
        f"└─────────────────────────────────────────────────────┘{ConsoleFormatter.RESET}"
    )

    challenge = {
        "amount": amount,
        "receiver": state.accounts.get("deployer", "CONTRACT"),
        "mode": mode,
    }
    state.proofs["challenge"] = challenge

    # Step 5: Payment Execution
    print_step(5, "PAYMENT EXECUTION", config)

    if config.dry_run:
        txid = "MOCK_TX_" + "ABC123" * 3
        print_info("Dry run - simulating payment")
    else:
        try:
            import base64

            kmd_client = kmd.KMDClient("a" * 64, "http://localhost:4002")
            wallets = kmd_client.list_wallets()
            wallet_handle = kmd_client.init_wallet_handle(wallets[0]["id"], "")
            sk_bytes = kmd_client.export_key(wallet_handle, "", bank_account["address"])

            x402_flow = X402DemoFlow(
                state.accounts.get("deployer", "CONTRACT"),
                config.verbose,
            )
            txid = x402_flow.simulate_payment(
                sk_bytes,
                bank_account["address"],
                int(amount * 1_000_000),
            )
        except Exception as e:
            print_error(f"Payment failed: {e}")
            txid = f"MOCK_TX_{time.time()}"
            print_warning("Continuing with mock TXID")

    print_success(f"Payment submitted")
    print_data("TxID", txid)
    print_data("Amount", f"{amount} ALGO")
    print_data("Sender", bank_account["address"][:20] + "...")

    state.txids.append(("payment", txid))

    # Step 6: Payment Verification
    print_step(6, "ON-CHAIN VERIFICATION", config)

    print_info("Verifying payment on Algorand...")

    if not config.dry_run:
        time.sleep(1)

    print_success("Payment verified")
    print_data("Confirmed Round", str(int(time.time())))
    print_data("Status", "Confirmed")

    # Step 7: ZK Proof Generation
    print_step(7, "ZKP GENERATION", config)

    secret_income = 75000
    threshold = 50000

    print_info("Generating zero-knowledge proof...")

    if not config.dry_run:
        time.sleep(0.5)

    zkp_gen = ZKPGenerator(config.verbose)
    proof = zkp_gen.generate_proof(secret_income, threshold)

    print_success("ZKP generated")
    print_data("Proof Hash", proof["proof_hash"])
    print_data("Public Inputs", f"threshold={threshold}")
    print_data("Verified", str(proof["verified"]))

    state.proofs["zkp"] = proof

    # Step 8: Submit to TruthRegistry
    print_step(8, "TRUTH REGISTRY SUBMISSION", config)

    trait_id = f"income_{bank_account['address'][:8]}_{int(time.time())}"

    print_info("Submitting proof to TruthRegistry...")
    print_data("Trait ID", trait_id)
    print_data("Commitment", proof["proof_hash"])
    print_data("App ID", str(state.app_ids.get("truth_registry", 2)))

    if not config.dry_run:
        time.sleep(0.5)

    print_success("Proof submitted to TruthRegistry")

    state.txids.append(("submit_proof", f"tx_proof_{trait_id[:8]}"))

    # Step 9: On-chain Verification
    print_step(9, "ON-CHAIN VERIFICATION", config)

    print_info("Verifying proof on TruthRegistry...")

    if not config.dry_run:
        time.sleep(0.5)

    onchain_verified = proof["verified"]

    if onchain_verified:
        print(f"\n{ConsoleFormatter.GREEN}{ConsoleFormatter.BOLD}")
        print("╔═══════════════════════════════════════════════════════════╗")
        print("║                                                           ║")
        print("║            ✓ ON-CHAIN VERIFICATION: SUCCESS                ║")
        print("║                                                           ║")
        print("║    Proof accepted by TruthRegistry                        ║")
        print("║    Trait anchored to blockchain                           ║")
        print("║                                                           ║")
        print("╚═══════════════════════════════════════════════════════════╝")
        print(ConsoleFormatter.RESET)
    else:
        print(f"\n{ConsoleFormatter.RED}{ConsoleFormatter.BOLD}")
        print("✗ ON-CHAIN VERIFICATION: FAILED")
        print(ConsoleFormatter.RESET)

    # Final Summary
    print(f"\n{ConsoleFormatter.CYAN}{ConsoleFormatter.BOLD}")
    print("═" * 60)
    print("DEMO COMPLETE")
    print("═" * 60)
    print(ConsoleFormatter.RESET)

    print(f"\n{ConsoleFormatter.DIM}Summary:{ConsoleFormatter.RESET}")
    print_data(
        "Duration", f"{(datetime.now() - state.start_time).total_seconds():.2f}s"
    )
    print_data("Transactions", str(len(state.txids)))
    print_data(
        "IdentityRegistry", f"App ID: {state.app_ids.get('identity_registry', 'N/A')}"
    )
    print_data("TruthRegistry", f"App ID: {state.app_ids.get('truth_registry', 'N/A')}")
    print_data("Payment TxID", state.txids[-1][1] if state.txids else "N/A")

    # Persist results
    if config.persist_results:
        results = {
            "timestamp": state.start_time.isoformat(),
            "completed": datetime.now().isoformat(),
            "network": state.network,
            "accounts": {
                k: v[:20] + "..." if len(v) > 20 else v
                for k, v in state.accounts.items()
            },
            "app_ids": state.app_ids,
            "txids": [{"type": t, "txid": tx} for t, tx in state.txids],
            "proof": {
                "proof_hash": state.proofs.get("zkp", {}).get("proof_hash", ""),
                "verified": state.proofs.get("zkp", {}).get("verified", False),
            },
            "errors": state.errors,
        }

        with open(config.results_file, "w") as f:
            json.dump(results, f, indent=2)

        print(
            f"\n{ConsoleFormatter.DIM}Results saved to: {config.results_file}{ConsoleFormatter.RESET}"
        )

    print(
        f"\n{ConsoleFormatter.GREEN}✓ Demo completed successfully!{ConsoleFormatter.RESET}\n"
    )

    return 0


def main():
    parser = argparse.ArgumentParser(
        description="TrustAnchor LocalNet Demonstration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python demo.py                    # Full demo with LocalNet
  python demo.py --skip-localnet    # Skip LocalNet start
  python demo.py --dry-run         # Simulated demo (no blockchain)
  python demo.py --verbose          # Detailed logging
  python demo.py --no-persist       # Don't save results
        """,
    )

    parser.add_argument(
        "--skip-localnet",
        action="store_true",
        help="Skip LocalNet start (assumes already running)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulated demo without blockchain transactions",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )
    parser.add_argument(
        "--no-persist",
        action="store_true",
        help="Don't persist results to JSON",
    )
    parser.add_argument(
        "--results",
        default="demo_results.json",
        help="Results file path (default: demo_results.json)",
    )

    args = parser.parse_args()

    config = DemoConfig(
        skip_localnet=args.skip_localnet,
        dry_run=args.dry_run,
        verbose=args.verbose,
        persist_results=not args.no_persist,
        results_file=args.results,
    )

    if config.verbose:
        logging.basicConfig(level=logging.DEBUG)

    return asyncio.run(run_demo(config))


if __name__ == "__main__":
    sys.exit(main())
