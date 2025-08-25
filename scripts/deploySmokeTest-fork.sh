#!/bin/bash

source $(dirname $0)/utils.sh

export DEPLOY_AMOUNT_DECIMALS=6

resetAddresses

if [ -z $ALCHEMY_URL ]; then
    echo "Must set environment variable $ALCHEMY_URL"
    exit 1
fi

startHHNode --fork $ALCHEMY_URL

USDC=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
ENSURO_TREASURY=0xFDa400f51aD6490542Bc6336Ea14b2D8bf7b0c34

npx hardhat --network $NETWORK deploy $VERIFY --currency-address $USDC \
    --treasury-address $ENSURO_TREASURY || die "Error deploying pool"

POOL=$(readAddress POOL)
ACCESSMANAGER=$(readAddress ACCESSMANAGER)
echo "PolicyPool = $POOL / AccessManager = $ACCESSMANAGER"

npx hardhat --network $NETWORK deploy:eToken \
    --etk-name "Junior ETK" --etk-symbol "eUSDJr" --save-addr JRETK \
    --ac-mgr $ACCESSMANAGER \
    --pool-address $POOL $VERIFY || die "Error deploying eToken"

npx hardhat --network $NETWORK deploy:eToken \
    --etk-name "Senior ETK" --etk-symbol "eUSDSr" --save-addr SRETK \
    --ac-mgr $ACCESSMANAGER \
    --pool-address $POOL $VERIFY || die "Error deploying eToken"

JRETK=$(readAddress JRETK)
SRETK=$(readAddress SRETK)

npx hardhat --network $NETWORK deploy:premiumsAccount $VERIFY \
    --junior-etk $JRETK --senior-etk $SRETK \
    --ac-mgr $ACCESSMANAGER \
    --pool-address $POOL || die "Error deploying PremiumsAccount"

PREMIUMS_ACCOUNT=$(readAddress PA)

echo "PremiumsAccount = $PREMIUMS_ACCOUNT"

killPID $HHNODE_PID
