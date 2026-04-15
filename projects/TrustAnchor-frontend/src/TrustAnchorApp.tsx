import { useWallet } from '@txnlab/use-wallet-react'
import React, { useState, useCallback } from 'react'
import algosdk from 'algosdk'
import ConnectWallet from './components/ConnectWallet'

interface ZKProofData {
  a: string
  b: string
  c?: string
  public_hash: string
}

interface VerificationResult {
  result: boolean
  user_id: string
  mode: string
  threshold: number
  proof?: ZKProofData | null
  txid?: string
}

const APP_ID = 758807528
const ISSUER_ADDR = 'COBW4B43ZK4EJBWTFY6ZQIMBYMKMLBITGEMWMVHJ2UMWBGAKQBRTL223WI'
const PAYMENT_FEE = 50000

const TrustAnchorApp: React.FC = () => {
  const { activeAddress, transactionSigner, signTransactions } = useWallet()

  const [openWalletModal, setOpenWalletModal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState('idle')
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null)
  const [zkProof, setZkProof] = useState<ZKProofData | null>(null)
  const [error, setError] = useState('')
  const [logs, setLogs] = useState<string[]>([])

  const [userId, setUserId] = useState('')
  const [threshold, setThreshold] = useState(50000)
  const [secretValue, setSecretValue] = useState(75000)
  const [verificationMode, setVerificationMode] = useState<'boolean' | 'zkp'>('zkp')

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg])
  }, [])

  const runVerificationFlow = async () => {
    if (!activeAddress || !transactionSigner) {
      setError('Please connect wallet first')
      return
    }

    setLoading(true)
    setError('')
    setStep('init')
    setVerificationResult(null)
    setZkProof(null)
    setLogs([])

    try {
      setStep('request')
      addLog(`[REQUEST] POST /verify/income (${verificationMode})`)
      
      const payload: any = {
        user_id: userId || activeAddress.slice(0, 8),
        mode: verificationMode,
        threshold: threshold,
      }
      if (verificationMode === 'zkp') {
        payload.secret_value = secretValue
      }

      let response = await fetch('http://localhost:8000/verify/income', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      // Handle 402 Payment Required
      if (response.status === 402) {
        setStep('payment')
        const data = await response.json()
        const reqs = data.detail?.paymentRequirements?.[0] || data.detail?.[0]
        
        if (!reqs) throw new Error('Invalid 402 response: Missing payment requirements')
        const amountRequired = reqs.maximumAmountRequired || PAYMENT_FEE
        const payTo = reqs.payTo || ISSUER_ADDR

        addLog(`[PAYMENT] Payment Required: ${amountRequired / 1_000_000} ALGO`)
        
        addLog(`[TX] Fetching network params...`)
        // Initialize Algod client natively to avoid v3 .bc fetch bugs
        const algodClient = new algosdk.Algodv2('', 'https://testnet-api.algonode.cloud', '')
        const suggestedParams = await algodClient.getTransactionParams().do()
        
        addLog(`[TX] Building payment txn...`)
        // Use makePaymentTxn with BigInt cast to bypass v3 bugs while keeping correct suggestedParams mapping
        const paymentTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: activeAddress,
          receiver: payTo,
          amount: BigInt(amountRequired),
          suggestedParams: suggestedParams,
          note: new TextEncoder().encode('TrustAnchor x402 payment')
        })
        
        setStep('submit')
        addLog(`[TX] Signing with wallet...`)
        
        const encodedTxn = paymentTxn.toByte()
        const signedTxns = await signTransactions([encodedTxn])
        
        addLog(`[TX] Sending via node...`)
        const txId = paymentTxn.txID().toString()
        const sendableTxn = new Uint8Array(signedTxns[0])
        await algodClient.sendRawTransaction(sendableTxn).do()
        addLog(`[TX] Pending: ${txId}`)
        
        addLog(`[TX] Waiting for confirmation...`)
        await algosdk.waitForConfirmation(algodClient, txId, 4)
        addLog(`[TX] Confirmed!`)
        
        setStep('prove')
        addLog(`[REQUEST] Resubmitting with payment proof...`)
        response = await fetch('http://localhost:8000/verify/income', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X402-Payment-Proof': txId
          },
          body: JSON.stringify(payload)
        })
      }

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.detail?.message || errData.detail || errData.error || `Server returned ${response.status}`)
      }

      const finalData = await response.json()
      addLog(`[SERVER] Verified: ${finalData.result}`)
      
      setStep('complete')
      addLog('[SUCCESS] Verification complete!')

      setVerificationResult(finalData)
      setZkProof(finalData.proof?.proof || null)
      
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed'
      setError(msg)
      addLog(`[ERROR] ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <nav className="p-4 border-b border-slate-700 flex justify-between items-center">
        <div className="text-xl font-bold">Trust<span className="text-purple-400">Anchor</span></div>
        <button onClick={() => setOpenWalletModal(true)} className="px-4 py-2 bg-purple-600 rounded-lg">
          {activeAddress ? `${activeAddress.slice(0, 8)}...` : 'Connect Wallet'}
        </button>
      </nav>

      <main className="p-8">
        <h1 className="text-4xl font-bold mb-8 text-center">Truth-as-a-Service</h1>

        <div className="grid md:grid-cols-2 gap-8">
          <div className="space-y-4">
            <input
              type="text"
              placeholder="User ID"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="w-full p-3 bg-slate-800 rounded border border-slate-700"
            />
            <input
              type="number"
              placeholder="Threshold"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-full p-3 bg-slate-800 rounded border border-slate-700"
            />
            {verificationMode === 'zkp' && (
              <input
                type="number"
                placeholder="Your Income"
                value={secretValue}
                onChange={(e) => setSecretValue(Number(e.target.value))}
                className="w-full p-3 bg-green-900/30 rounded border border-green-700"
              />
            )}
            <div className="flex gap-2">
              <button onClick={() => setVerificationMode('boolean')} className={`flex-1 p-3 rounded ${verificationMode === 'boolean' ? 'bg-slate-600' : 'bg-slate-800'}`}>Boolean</button>
              <button onClick={() => setVerificationMode('zkp')} className={`flex-1 p-3 rounded ${verificationMode === 'zkp' ? 'bg-purple-600' : 'bg-slate-800'}`}>ZK Proof</button>
            </div>
            <button
              onClick={runVerificationFlow}
              disabled={loading || !activeAddress}
              className="w-full p-4 bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg font-bold disabled:opacity-50"
            >
              {loading ? 'Processing...' : 'Run Verification'}
            </button>
            {error && <div className="text-red-400 p-2">{error}</div>}
          </div>

          <div className="space-y-4">
            <div className="bg-slate-800 p-4 rounded">
              <div className="text-sm text-slate-400 mb-2">Verification Flow</div>
              <div className="flex flex-wrap gap-2">
                {['init', 'request', 'payment', 'prove', 'submit', 'verify', 'complete'].map((s) => (
                  <div key={s} className={`px-3 py-1 rounded ${step === s ? 'bg-purple-500' : ['init', 'complete'].includes(step) && ['init', 'request', 'payment', 'prove', 'submit', 'verify', 'complete'].indexOf(step) > ['init', 'request', 'payment', 'prove', 'submit', 'verify', 'complete'].indexOf(s) ? 'bg-green-500/30 text-green-400' : 'bg-slate-700'}`}>
                    {s}
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-black/50 p-4 rounded font-mono text-sm max-h-64 overflow-y-auto">
              {logs.map((log, i) => <div key={i} className="text-slate-300">{log}</div>)}
              {logs.length === 0 && <div className="text-slate-500">Press Run Verification</div>}
            </div>

            {verificationResult && (
              <div className="bg-green-900/30 p-4 rounded border border-green-500">
                <div className="text-green-400 font-bold">VERIFIED</div>
                <div className="text-sm mt-2">
                  Mode: {verificationResult.mode}<br/>
                  Threshold: ${verificationResult.threshold}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <ConnectWallet openModal={openWalletModal} closeModal={() => setOpenWalletModal(false)} />
    </div>
  )
}

export default TrustAnchorApp