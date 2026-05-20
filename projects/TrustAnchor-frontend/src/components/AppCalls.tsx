import { useWallet } from '@txnlab/use-wallet-react'
import { useSnackbar } from 'notistack'
import { useState } from 'react'

const USDC_MAINNET = 31566704
const USDC_TESTNET = 10458941
const USDC_ASSET_ID = import.meta.env.VITE_ALGOD_NETWORK === 'mainnet' ? USDC_MAINNET : USDC_TESTNET

interface AppCallsInterface {
  openModal: boolean
  setModalState: (value: boolean) => void
}

const AppCalls = ({ openModal, setModalState }: AppCallsInterface) => {
  const [loading, setLoading] = useState<boolean>(false)
  const { enqueueSnackbar } = useSnackbar()
  const { activeAddress, signTransactions } = useWallet()

  const sendUsdc = async () => {
    if (!activeAddress || !signTransactions) {
      enqueueSnackbar('Please connect wallet first', { variant: 'warning' })
      return
    }
    setLoading(true)
    try {
      enqueueSnackbar('Sending $0.10 USDC...', { variant: 'info' })
      const algosdk = await import('algosdk')
      const algodClient = new algosdk.Algodv2(
        '',
        import.meta.env.VITE_ALGOD_SERVER || 'https://testnet-api.algonode.cloud',
        import.meta.env.VITE_ALGOD_PORT || '',
      )
      const params = await algodClient.getTransactionParams().do()
      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: activeAddress,
        receiver: activeAddress,
        amount: BigInt(100_000),
        assetIndex: USDC_ASSET_ID,
        suggestedParams: params,
      })
      const signedTxsRaw = await signTransactions([txn.toByte()])
      const signedTxs = signedTxsRaw.filter((tx): tx is Uint8Array => tx !== null)
      const result = (await algodClient.sendRawTransaction(signedTxs).do()) as any
      const txId = result.txId || result.txID || result.txid
      enqueueSnackbar(`USDC sent: ${(txId || '').slice(0, 16)}...`, { variant: 'success' })
    } catch (e) {
      enqueueSnackbar('USDC transfer requires opted-in account. Use simulation mode in the main dashboard.', { variant: 'error' })
    }
    setLoading(false)
  }

  return (
    <dialog id="appcalls_modal" className={`modal ${openModal ? 'modal-open' : ''} bg-slate-200`}>
      <form method="dialog" className="modal-box">
        <h3 className="font-bold text-lg">TrustAnchor Contract — USDC</h3>
        <p className="py-4">USDC ASA: {USDC_ASSET_ID}</p>
        <p className="py-2 text-sm text-slate-600">
          Methods: request_verification, fulfill_request, get_request
        </p>
        <p className="py-2 text-sm text-slate-600">
          Pricing: ${(0.01).toFixed(2)} boolean, ${(0.10).toFixed(2)} ZKP
        </p>
        <div className="modal-action">
          <button className="btn" onClick={() => setModalState(!openModal)}>
            Close
          </button>
          <button className="btn btn-primary" onClick={sendUsdc} disabled={loading}>
            {loading ? 'Processing...' : 'Send $0.10 USDC'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export default AppCalls
