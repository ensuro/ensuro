#!/bin/bash

source `dirname $0`/utils.sh

export DEPLOY_AMOUNT_DECIMALS=6

resetAddresses

if [ -z $ALCHEMY_URL ]; then
    echo "Must set environment variable $ALCHEMY_URL"
    exit 1
fi

startHHNode --fork $ALCHEMY_URL

USDC=0x2791bca1f2de4661ed88a30c99a7a9449aa84174
AAVE_ADDR_PROV=0xd05e3E715d945B59290df0ae8eF85c1BdB684744  # Polygon Aave
SWAP_ROUTER=0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506  # Polygon SushiSwap
PRICE_ORACLE=0x0229f777b0fab107f9591a41d5f02e4e98db6f2d  # Polygon Price Oracle of AAVE
ENSURO_TREASURY=0xFDa400f51aD6490542Bc6336Ea14b2D8bf7b0c34

npx hardhat --network $NETWORK deploy $VERIFY --currency-address $USDC \
    --treasury-address $ENSURO_TREASURY || die "Error deploying pool"

POOL=`readAddress POOL`
ACCESSMANAGER=`readAddress ACCESSMANAGER`
echo "PolicyPool = $POOL / AccessManager = $ACCESSMANAGER"

for ROLE in LEVEL1 LEVEL2; do
  npx hardhat --network $NETWORK ens:grantRole --contract-address $ACCESSMANAGER \
      --role ${ROLE}_ROLE || die "Error granting ${ROLE}_ROLE"
done

npx hardhat --network $NETWORK deploy:eToken  \
    --etk-name "Junior ETK" --etk-symbol "eUSDJr" --save-addr JRETK \
    --pool-address $POOL $VERIFY || die "Error deploying eToken"

npx hardhat --network $NETWORK deploy:eToken  \
    --etk-name "Senior ETK" --etk-symbol "eUSDSr" --save-addr SRETK \
    --pool-address $POOL $VERIFY || die "Error deploying eToken"

JRETK=`readAddress JRETK`
SRETK=`readAddress SRETK`

npx hardhat --network $NETWORK deploy:premiumsAccount $VERIFY \
    --junior-etk $JRETK --senior-etk $SRETK \
    --pool-address $POOL || die "Error deploying PremiumsAccount"

PREMIUMS_ACCOUNT=`readAddress PA`

echo "PremiumsAccount = $PREMIUMS_ACCOUNT"

killPID $HHNODE_PID
