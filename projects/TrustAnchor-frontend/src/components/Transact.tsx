import { algo, AlgorandClient } from '@algorandfoundation/algokit-utils'
import { useWallet } from '@txnlab/use-wallet-react'
import { useSnackbar } from 'notistack'
import { useState } from 'react'
import { getAlgodConfigFromViteEnvironment } from '../utils/network/getAlgoClientConfigs'

const USDC_MAINNET = 31566704
const USDC_TESTNET = 10458941
const USDC_ASSET_ID = import.meta.env.VITE_ALGOD_NETWORK === 'mainnet' ? USDC_MAINNET : USDC_TESTNET

interface TransactInterface {
  openModal: boolean
  setModalState: (value: boolean) => void
}

const Transact = ({ openModal, setModalState }: TransactInterface) => {
  const [loading, setLoading] = useState<boolean>(false)
  const [receiverAddress, setReceiverAddress] = useState<string>('')

  const algodConfig = getAlgodConfigFromViteEnvironment()
  const algorand = AlgorandClient.fromConfig({ algodConfig })

  const { enqueueSnackbar } = useSnackbar()
  const { transactionSigner, activeAddress } = useWallet()

  const handleSubmitUsdc = async () => {
    setLoading(true)
    if (!transactionSigner || !activeAddress) {
      enqueueSnackbar('Please connect wallet first', { variant: 'warning' })
      return
    }
    try {
      enqueueSnackbar('Sending $0.10 USDC...', { variant: 'info' })
      await algorand.send.assetTransfer({
        signer: transactionSigner,
        sender: activeAddress,
        receiver: receiverAddress,
        assetId: BigInt(USDC_ASSET_ID),
        amount: BigInt(100_000),
      })
      enqueueSnackbar('$0.10 USDC sent successfully', { variant: 'success' })
      setReceiverAddress('')
    } catch (e) {
      enqueueSnackbar('Failed to send USDC. Ensure receiver opted in.', { variant: 'error' })
    }
    setLoading(false)
  }

  return (
    <dialog id="transact_modal" className={`modal ${openModal ? 'modal-open' : ''} bg-slate-200`}>
      <form method="dialog" className="modal-box">
        <h3 className="font-bold text-lg">Send USDC payment</h3>
        <p className="text-sm text-slate-500 mb-4">USDC ASA: {USDC_ASSET_ID} | 1 USDC = 1,000,000 microUSDC</p>
        <input
          type="text"
          data-test-id="receiver-address"
          placeholder="Wallet address (must opt into USDC)"
          className="input input-bordered w-full"
          value={receiverAddress}
          onChange={(e) => setReceiverAddress(e.target.value)}
        />
        <div className="modal-action">
          <button className="btn" onClick={() => setModalState(!openModal)}>
            Close
          </button>
          <button
            data-test-id="send-usdc"
            className={`btn ${receiverAddress.length === 58 ? '' : 'btn-disabled'}`}
            onClick={handleSubmitUsdc}
          >
            {loading ? <span className="loading loading-spinner" /> : 'Send $0.10 USDC'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export default Transact
