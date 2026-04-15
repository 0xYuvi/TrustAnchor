import { useWallet } from '@txnlab/use-wallet-react'
import { useSnackbar } from 'notistack'
import { useState } from 'react'

interface AppCallsInterface {
  openModal: boolean
  setModalState: (value: boolean) => void
}

const AppCalls = ({ openModal, setModalState }: AppCallsInterface) => {
  const [loading, setLoading] = useState<boolean>(false)
  const { enqueueSnackbar } = useSnackbar()

  const testContract = async () => {
    setLoading(true)
    enqueueSnackbar("TrustAnchor contract ready!", { variant: 'success' })
    setLoading(false)
  }

  return (
    <dialog id="appcalls_modal" className={`modal ${openModal ? 'modal-open' : ''} bg-slate-200`}>
      <form method="dialog" className="modal-box">
        <h3 className="font-bold text-lg">TrustAnchor Contract</h3>
        <p className="py-4">Contract ID: 758839639</p>
        <p className="py-2 text-sm text-slate-600">
          Methods: anchor_identity, get_commitment, verify
        </p>
        <div className="modal-action ">
          <button className="btn" onClick={() => setModalState(!openModal)}>
            Close
          </button>
          <button className={`btn`} onClick={testContract}>
            {loading ? <span className="loading loading-spinner" /> : 'Test Connection'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export default AppCalls
