#!/bin/bash

source $(dirname $0)/utils.sh

export DEPLOY_AMOUNT_DECIMALS=6

resetAddresses

startHHNode

ENSURO_TREASURY=0xFDa400f51aD6490542Bc6336Ea14b2D8bf7b0c34

npx hardhat --network $NETWORK deploy $VERIFY \
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

npx hardhat --network $NETWORK deploy:premiumsAccount $VERIFY --pool-address $POOL \
    --ac-mgr $ACCESSMANAGER \
    --junior-etk $JRETK --senior-etk $SRETK || die "Error deploying Premiums Account"

PREMIUMS_ACCOUNT=$(readAddress PA)

echo "PremiumsAccount = $PREMIUMS_ACCOUNT"

npx hardhat --network $NETWORK deploy:riskModule $VERIFY --pool-address $POOL \
    --pa-address $PREMIUMS_ACCOUNT \
    --ac-mgr $ACCESSMANAGER \
    --wallet 0x951B9B8a7b0e3701E757c015F43df9F2F867B824 || die "Error deploying riskModule"

# Whitelist
npx hardhat --network $NETWORK deploy:whitelist $VERIFY \
    --ac-mgr $ACCESSMANAGER \
    --pool-address $POOL --e-token $SRETK || die "Error deploying Whitelist"

killPID $HHNODE_PID
