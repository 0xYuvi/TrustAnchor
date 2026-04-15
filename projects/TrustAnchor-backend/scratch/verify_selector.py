from algosdk import abi

method = abi.Method.from_signature("register_anchor(byte[],byte[])")
print(f"Signature: {method.get_signature()}")
print(f"Selector: {method.get_selector().hex()}")
