import { SupportedWallet, WalletId, WalletManager, WalletProvider } from '@txnlab/use-wallet-react'
import { SnackbarProvider } from 'notistack'
import TrustAnchorApp from './TrustAnchorApp'
import { getAlgodConfigFromViteEnvironment, getKmdConfigFromViteEnvironment } from './utils/network/getAlgoClientConfigs'

let supportedWallets: SupportedWallet[]
if (import.meta.env.VITE_ALGOD_NETWORK === 'localnet') {
  const kmdConfig = getKmdConfigFromViteEnvironment()
  supportedWallets = [
    {
      id: WalletId.KMD,
      options: {
        baseServer: kmdConfig.server,
        token: String(kmdConfig.token),
        port: String(kmdConfig.port),
      },
    },
  ]
} else {
  supportedWallets = [{ id: WalletId.DEFLY }, { id: WalletId.PERA }, { id: WalletId.EXODUS }]
}

export default function App() {
  let algodConfig;
  try {
    algodConfig = getAlgodConfigFromViteEnvironment()
  } catch (e) {
    console.warn("Environment variables missing, defaulting to Testnet")
    algodConfig = {
      server: 'https://testnet-api.algonode.cloud',
      port: '',
      token: '',
      network: 'testnet'
    }
  }

  const walletManager = new WalletManager({
    wallets: supportedWallets,
    defaultNetwork: algodConfig.network || 'testnet',
    networks: {
      [algodConfig.network || 'testnet']: {
        algod: {
          baseServer: algodConfig.server,
          port: algodConfig.port,
          token: String(algodConfig.token),
        },
      },
    },
    options: {
      resetNetwork: true,
    },
  })

  return (
    <SnackbarProvider maxSnack={3}>
      <WalletProvider manager={walletManager}>
        <TrustAnchorApp />
      </WalletProvider>
    </SnackbarProvider>
  )
}
