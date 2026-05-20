import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import os
import base64
from datetime import datetime

# Configure environment variables before importing components
os.environ["TRUST_ANCHOR_ADDRESS"] = "TRUST_ANCHOR_RECEIVER_ADDRESS_MOCK"
os.environ["USDC_ASSET_ID"] = "10419441"

from pricing import get_price, get_price_usdc, format_price, PricingTier
from payment_verifier import PaymentVerifier, PaymentVerificationResult
from recruiter_agent import AlgorandSigner


class TestUSDCPricing(unittest.TestCase):
    def test_pricing_values(self):
        # Verify microUSDC pricing values
        self.assertEqual(get_price("boolean"), 10000)
        self.assertEqual(get_price("zkp"), 100000)
        
        # Verify USDC float pricing values
        self.assertEqual(get_price_usdc("boolean"), 0.01)
        self.assertEqual(get_price_usdc("zkp"), 0.10)

        # Verify formatted strings
        self.assertEqual(format_price("boolean"), "$0.01 USDC")
        self.assertEqual(format_price("zkp"), "$0.10 USDC")


class TestUSDCPaymentVerifier(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.receiver = "TRUST_ANCHOR_RECEIVER_ADDRESS_MOCK"
        self.asset_id = 10419441
        self.verifier = PaymentVerifier(
            indexer_url="https://mock-indexer.cloud",
            receiver_address=self.receiver,
            usdc_asset_id=self.asset_id,
        )

    async def asyncTearDown(self):
        await self.verifier.close()

    @patch("httpx.AsyncClient.get")
    async def test_verify_payment_success_base64_note(self, mock_get):
        request_hash = "my-request-hash-binding-123"
        encoded_note = base64.b64encode(request_hash.encode()).decode()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "transaction": {
                "tx-type": "axfer",
                "sender": "SENDER_ADDRESS_MOCK",
                "asset-transfer-transaction": {
                    "asset-id": self.asset_id,
                    "amount": 10000,
                    "receiver": self.receiver,
                },
                "note": encoded_note,
            },
            "confirmed-round": 42000,
            "round-time": 1716216000,
        }
        mock_get.return_value = mock_response

        result = await self.verifier.verify_payment(
            txid="TXID123",
            expected_amount=10000,
            note=request_hash,
        )

        self.assertTrue(result.valid)
        self.assertIsNotNone(result.payment)
        self.assertEqual(result.payment.amount, 10000)
        self.assertEqual(result.payment.receiver, self.receiver)

    @patch("httpx.AsyncClient.get")
    async def test_verify_payment_success_hex_note(self, mock_get):
        request_hash = "my-request-hash-binding-123"
        encoded_note = request_hash.encode().hex()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "transaction": {
                "tx-type": "axfer",
                "sender": "SENDER_ADDRESS_MOCK",
                "asset-transfer-transaction": {
                    "asset-id": self.asset_id,
                    "amount": 10000,
                    "receiver": self.receiver,
                },
                "note": encoded_note,
            },
            "confirmed-round": 42000,
            "round-time": 1716216000,
        }
        mock_get.return_value = mock_response

        result = await self.verifier.verify_payment(
            txid="TXID123",
            expected_amount=10000,
            note=request_hash,
        )

        self.assertTrue(result.valid)

    @patch("httpx.AsyncClient.get")
    async def test_verify_payment_wrong_asset_id(self, mock_get):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "transaction": {
                "tx-type": "axfer",
                "sender": "SENDER_ADDRESS_MOCK",
                "asset-transfer-transaction": {
                    "asset-id": 999999,  # Wrong asset ID
                    "amount": 10000,
                    "receiver": self.receiver,
                },
                "note": "",
            },
        }
        mock_get.return_value = mock_response

        result = await self.verifier.verify_payment(
            txid="TXID123",
            expected_amount=10000,
        )

        self.assertFalse(result.valid)
        self.assertIn("Wrong asset ID", result.error)

    @patch("httpx.AsyncClient.get")
    async def test_verify_payment_wrong_type(self, mock_get):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "transaction": {
                "tx-type": "pay",  # Wrong transaction type
                "sender": "SENDER_ADDRESS_MOCK",
                "payment-transaction": {
                    "amount": 10000,
                    "receiver": self.receiver,
                },
            },
        }
        mock_get.return_value = mock_response

        result = await self.verifier.verify_payment(
            txid="TXID123",
            expected_amount=10000,
        )

        self.assertFalse(result.valid)
        self.assertIn("Wrong transaction type", result.error)

    @patch("httpx.AsyncClient.get")
    async def test_verify_payment_insufficient_amount(self, mock_get):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "transaction": {
                "tx-type": "axfer",
                "sender": "SENDER_ADDRESS_MOCK",
                "asset-transfer-transaction": {
                    "asset-id": self.asset_id,
                    "amount": 5000,  # Less than expected
                    "receiver": self.receiver,
                },
            },
        }
        mock_get.return_value = mock_response

        result = await self.verifier.verify_payment(
            txid="TXID123",
            expected_amount=10000,
        )

        self.assertFalse(result.valid)
        self.assertIn("Insufficient payment", result.error)


class TestAlgorandUSDCSigner(unittest.TestCase):
    @patch("algosdk.v2client.algod.AlgodClient.suggested_params")
    def test_signer_initialization(self, mock_suggested):
        # A mock 32-byte seed for generating account key
        seed = b"a" * 32
        private_key_b64 = base64.b64encode(seed + seed).decode()
        
        signer = AlgorandSigner(private_key_b64, usdc_asset_id=10419441)
        self.assertEqual(signer.usdc_asset_id, 10419441)
        self.assertIsNotNone(signer.address)


if __name__ == "__main__":
    unittest.main()
