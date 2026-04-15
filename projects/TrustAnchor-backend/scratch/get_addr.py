import algosdk
from algosdk import mnemonic

mn = "junior cement remind blind leisure project spoon bundle novel comfort include labor achieve gallery peasant ginger kind tape explain unveil magnet uniform spider abandon butter"
pk = mnemonic.to_private_key(mn)
addr = algosdk.account.address_from_private_key(pk)
print(f"YOUR_ALGORAND_ADDRESS: {addr}")
