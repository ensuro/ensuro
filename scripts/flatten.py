import os
import brownie

FLATTEN_DIR = "./flatten/"

CONTRACTS = [
    'DataTypes', 'EToken', 'FlyionRiskModule', 'Policy', 'PolicyPool', 'TrustfulRiskModule',
    'WadRayMath', 'PolicyPoolMock', 'TestCurrency', 'TestNFT',
]


def main():
    for contract_name in CONTRACTS:
        print(f"Flattening {contract_name}...")
        contract = getattr(brownie, contract_name)
        flatten = contract.get_verification_info()["flattened_source"]
        open(os.path.join(FLATTEN_DIR, f"{contract_name}.sol"), "wt").write(flatten)
