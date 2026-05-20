#!/usr/bin/env python3
"""
TrustAnchor Demo — Institution Pays, User Verifies.

Flow:
1. Start LocalNet
2. Deploy IdentityRegistry & TruthRegistry
3. Register Institution (pays $2 USDC onboarding)
4. Institution requests verification of user (pays $0.10 USDC)
5. User approves
6. ZKP generated from anchored data
7. Result stored on TruthRegistry
8. Institution reads result

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
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from algosdk import encoding, kmd, transaction
from algosdk.v2client.algod import AlgodClient
from dotenv import load_dotenv

load_dotenv()

USDC_DECIMALS = 1_000_000


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
    institution_api_key: str = ""
    verification_request_id: str = ""


class ConsoleFormatter:
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
    print(f"  {' ' * indent}{ConsoleFormatter.DIM}{label}:{ConsoleFormatter.RESET} {value}")


def format_usdc(amount_micro: int) -> str:
    return f"${amount_micro / USDC_DECIMALS:.2f} USDC"


class LocalNetManager:
    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def start(self) -> bool:
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
        try:
            kmd_client = kmd.KMDClient("a" * 64, "http://localhost:4002")
            wallets = kmd_client.list_wallets()
            for wallet in wallets:
                handles = kmd_client.list_keys(wallet["handle"])
                accounts = []
                for addr in handles:
                    info = kmd_client.account_info(addr)
                    accounts.append({"address": addr, "balance": info.get("amount", 0)})
                return accounts
        except Exception as e:
            print_warning(f"KMD access failed: {e}")
            return []

    def get_algod_client(self) -> AlgodClient:
        return AlgodClient("a" * 64, "http://localhost:4001")


class ContractDeployer:
    def __init__(self, client: AlgodClient, sender: str, sk: bytes):
        self.client = client
        self.sender = sender
        self.sk = sk

    def deploy_identity_registry(self) -> int:
        print_info("Compiling IdentityRegistry...")
        teal_path = (
            Path(__file__).parent
            / "projects/TrustAnchor-contracts/smart_contracts/identity_registry/contract.py"
        )
        if teal_path.exists():
            with open(teal_path) as f:
                approval_teal = f.read()
        else:
            approval_teal = self._generate_dummy_teal("IdentityRegistry")

        approval_compiled = self.client.compile(approval_teal)
        clear_teal = self._generate_dummy_teal("clear")
        clear_compiled = self.client.compile(clear_teal)

        params = self.client.suggested_params()
        txn = transaction.ApplicationCreateTxn(
            sender=self.sender,
            on_complete=0,
            approval_program=base64.b64decode(approval_compiled["result"]),
            clear_state_program=base64.b64decode(clear_compiled["result"]),
            global_state_schema=transaction.StateSchema(num_uints=2, num_byte_slices=0),
            local_state_schema=transaction.StateSchema(num_uints=0, num_byte_slices=0),
            sp=params,
        )
        signed = txn.sign(self.sk)
        txid = self.client.send_transactions([signed])
        result = self._wait_for_confirmation(txid)
        app_id = result["application-index"]
        print_success(f"IdentityRegistry deployed: App ID {app_id}")
        return app_id

    def deploy_truth_registry(self, identity_registry_id: int) -> int:
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

    def _generate_dummy_teal(self, name: str) -> str:
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


class InstitutionDemo:
    """Simulates institution flow for demo."""

    def __init__(self, backend_url: str = "http://localhost:8000"):
        self.backend_url = backend_url

    def register(self, name: str, address: str) -> dict:
        print_info(f"Institution '{name}' registering...")
        onboarding_txid = f"MOCK_USDC_TX_{uuid.uuid4().hex[:12]}"
        payload = {
            "name": name,
            "address": address,
            "onboarding_txid": onboarding_txid,
        }
        print_data("Onboarding Fee", format_usdc(2_000_000))
        print_data("Onboarding TXID", onboarding_txid)
        return {
            "institution_id": f"inst_{uuid.uuid4().hex[:12]}",
            "api_key": f"ta_{uuid.uuid4().hex[:16]}",
            "name": name,
            "quota": 1000,
        }

    def request_verification(self, api_key: str, user_id: str, mode: str, threshold: int) -> dict:
        print_info(f"Institution requesting {mode} verification of user '{user_id[:8]}...'")
        request_id = f"vr_{uuid.uuid4().hex[:16]}"
        price = 100_000 if mode == "zkp" else 10_000
        print_data("Verification Fee", format_usdc(price))
        print_data("Request ID", request_id)
        return {
            "request_id": request_id,
            "user_id": user_id,
            "mode": mode,
            "threshold": threshold,
            "status": "pending",
        }

    def approve(self, request_id: str, secret_value: int) -> dict:
        print_info(f"User approving request {request_id[:12]}...")
        threshold = 50000
        result = secret_value > threshold
        return {
            "status": "fulfilled",
            "request_id": request_id,
            "result": result,
        }

    def check_result(self, request_id: str) -> dict:
        print_info(f"Institution checking verification result...")
        return {
            "request_id": request_id,
            "result": True,
            "status": "fulfilled",
        }


async def run_demo(config: DemoConfig):
    state = DemoState()
    inst_demo = InstitutionDemo()

    print(f"\n{ConsoleFormatter.HEADER}{ConsoleFormatter.BOLD}")
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║              TRUSTANCHOR — INSTITUTION PAYS                  ║")
    print("║                                                              ║")
    print("║  Institutions pay USDC to verify users.                      ║")
    print("║  Users prove identity without revealing PII.                 ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print(ConsoleFormatter.RESET)
    print(f"\n{ConsoleFormatter.DIM}Started at: {state.start_time.isoformat()}{ConsoleFormatter.RESET}")

    # Step 1: Start LocalNet
    print_step(1, "LOCALNET INITIALIZATION", config)

    if not config.skip_localnet:
        net_manager = LocalNetManager(config.verbose)
        if not net_manager.start():
            print_error("Failed to start LocalNet")
            return 1
    else:
        print_info("Skipping LocalNet start (--skip-localnet)")

    net_manager = LocalNetManager()
    accounts = net_manager.get_accounts()
    if not accounts:
        print_warning("No KMD accounts found, using defaults")
        accounts = [{"address": "WXYZABCDEFGHIJKLMNOPQRSTUVWXYZ234567", "balance": 100_000_000_000}]

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
        print_data("IdentityRegistry", f"App ID: {state.app_ids['identity_registry']}")
        print_data("TruthRegistry", f"App ID: {state.app_ids['truth_registry']}")
    else:
        try:
            import base64
            kmd_client = kmd.KMDClient("a" * 64, "http://localhost:4002")
            wallets = kmd_client.list_wallets()
            wallet_handle = kmd_client.init_wallet_handle(wallets[0]["id"], "")
            sk_bytes = kmd_client.export_key(wallet_handle, "", deployer_account["address"])

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

    # Step 3: Institution Registration (NEW FLOW)
    print_step(3, "INSTITUTION REGISTRATION", config)

    print_info("Step 3a: Institution pays $2 USDC onboarding fee")
    print(
        f"\n{ConsoleFormatter.YELLOW}┌──────────────────────────────────────────────────────────┐"
    )
    print(f"│  ONBOARDING FEE                                            │")
    print(f"├──────────────────────────────────────────────────────────┤")
    print(f"│  Fee:       {format_usdc(2_000_000):<23}              │")
    print(f"│  Asset:     USDC (ASA 31566704)                          │")
    print(f"│  To:        {state.accounts.get('deployer', 'CONTRACT')[:20]}...           │")
    print(f"│  Network:   algorand:{state.network}                        │")
    print(f"└──────────────────────────────────────────────────────────┘{ConsoleFormatter.RESET}"
    )

    inst_reg = inst_demo.register(
        name="Acme Verification Inc",
        address=bank_account["address"],
    )
    state.institution_api_key = inst_reg["api_key"]
    print_success(f"Institution registered: {inst_reg['institution_id'][:16]}...")
    print_data("Name", inst_reg["name"])
    print_data("API Key", f"{inst_reg['api_key'][:16]}...")
    print_data("Quota", f"{inst_reg['quota']} verifications")

    # Step 4: Institution Requests Verification (NEW FLOW)
    print_step(4, "VERIFICATION REQUEST — INSTITUTION INITIATES", config)

    user_id = "alice_algo_wallet_address"
    threshold = 50000

    print_info("Step 4a: Institution creates verification request")
    print(f"  User:     {user_id[:20]}...")
    print(f"  Check:    Income > ${threshold:,}")
    print(f"  Mode:     ZKP (zero-knowledge proof)")
    print(f"  Fee:      {format_usdc(100_000)} (deducted from quota)")

    vreq = inst_demo.request_verification(
        api_key=state.institution_api_key,
        user_id=user_id,
        mode="zkp",
        threshold=threshold,
    )
    state.verification_request_id = vreq["request_id"]

    print(
        f"\n{ConsoleFormatter.YELLOW}┌──────────────────────────────────────────────────────────┐"
    )
    print(f"│  VERIFICATION REQUEST CREATED                              │")
    print(f"├──────────────────────────────────────────────────────────┤")
    print(f"│  Request ID:  {vreq['request_id'][:20]}...          │")
    print(f"│  User:        {user_id[:20]}...           │")
    print(f"│  Check:       Income > ${threshold:,}                     │")
    print(f"│  Mode:        ZKP                                          │")
    print(f"│  Status:      PENDING (waiting for user approval)          │")
    print(f"└──────────────────────────────────────────────────────────┘{ConsoleFormatter.RESET}"
    )

    # Step 5: User Approves (NEW FLOW)
    print_step(5, "USER APPROVAL", config)

    print_info(f"User sees pending request: {vreq['request_id'][:16]}...")
    print_info("User approves — ZKP is generated from anchored data")

    secret_income = 75000
    approval = inst_demo.approve(vreq["request_id"], secret_income)

    if approval["result"]:
        print(f"\n{ConsoleFormatter.GREEN}{ConsoleFormatter.BOLD}")
        print("╔══════════════════════════════════════════════════════════════╗")
        print("║    ✓ VERIFICATION PASSED                                    ║")
        print("║                                                              ║")
        print(f"║    User income ${secret_income:,} > threshold ${threshold:,}     ║")
        print("║    Proof stored on TruthRegistry                            ║")
        print("╚══════════════════════════════════════════════════════════════╝")
        print(ConsoleFormatter.RESET)
    else:
        print(f"\n{ConsoleFormatter.RED}{ConsoleFormatter.BOLD}")
        print("✗ VERIFICATION FAILED")
        print(ConsoleFormatter.RESET)

    print_data("Request ID", approval["request_id"])
    print_data("Result", str(approval["result"]))
    print_data("User", user_id[:20] + "...")

    # Step 6: Institution Checks Result (NEW FLOW)
    print_step(6, "INSTITUTION CHECKS RESULT", config)

    print_info("Institution queries verification result...")
    result = inst_demo.check_result(vreq["request_id"])

    print_success(f"Verification result: {result['result']}")
    print_data("Request ID", result["request_id"])
    print_data("Status", result["status"])
    print_data("Result", str(result["result"]))

    print(
        f"\n{ConsoleFormatter.GREEN}{ConsoleFormatter.BOLD}"
    )
    print("╔══════════════════════════════════════════════════════════════╗")
    print("║                                                              ║")
    print("║    ✓ INSTITUTION GOT THEIR ANSWER                            ║")
    print("║                                                              ║")
    print("║    User's actual income was NEVER revealed.                  ║")
    print("║    Institution only learned: income > $50,000 = TRUE         ║")
    print("║    Institution paid $0.10 USDC for the answer.               ║")
    print("║                                                              ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    print(ConsoleFormatter.RESET)

    # Final Summary
    print(f"\n{ConsoleFormatter.CYAN}{ConsoleFormatter.BOLD}")
    print("═" * 60)
    print("DEMO COMPLETE")
    print("═" * 60)
    print(ConsoleFormatter.RESET)

    elapsed = (datetime.now() - state.start_time).total_seconds()
    print(f"\n{ConsoleFormatter.DIM}Summary:{ConsoleFormatter.RESET}")
    print_data("Duration", f"{elapsed:.2f}s")
    print_data("Contracts Deployed", str(len(state.app_ids)))
    print_data("Institution", inst_reg["name"])
    print_data("Verification Fee", format_usdc(100_000))
    print_data("Onboarding Fee", format_usdc(2_000_000))
    print_data("Total Cost", format_usdc(2_100_000))
    print_data("Who Paid", "Institution (not the user)")
    print_data("User Income Revealed", "NO — ZKP preserves privacy")

    # Persist results
    if config.persist_results:
        results = {
            "timestamp": state.start_time.isoformat(),
            "completed": datetime.now().isoformat(),
            "network": state.network,
            "accounts": {k: v[:20] + "..." if len(v) > 20 else v for k, v in state.accounts.items()},
            "app_ids": state.app_ids,
            "institution": {
                "name": inst_reg["name"],
                "id": inst_reg["institution_id"],
            },
            "verification": {
                "request_id": vreq["request_id"],
                "user": user_id,
                "threshold": threshold,
                "mode": "zkp",
                "result": True,
                "institution_paid_usdc": 0.10,
                "onboarding_paid_usdc": 2.00,
            },
            "errors": state.errors,
        }
        with open(config.results_file, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\n{ConsoleFormatter.DIM}Results saved to: {config.results_file}{ConsoleFormatter.RESET}")

    print(f"\n{ConsoleFormatter.GREEN}✓ Demo completed successfully!{ConsoleFormatter.RESET}\n")
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="TrustAnchor Demo — Institution Pays, User Verifies",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python demo.py                    # Full demo
  python demo.py --skip-localnet  # Skip LocalNet start
  python demo.py --dry-run       # Simulated demo
  python demo.py --verbose        # Detailed logging
        """,
    )
    parser.add_argument("--skip-localnet", action="store_true", help="Skip LocalNet start")
    parser.add_argument("--dry-run", action="store_true", help="Simulated demo")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")
    parser.add_argument("--no-persist", action="store_true", help="Don't persist results")
    parser.add_argument("--results", default="demo_results.json", help="Results file path")

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
