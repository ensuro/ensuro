#!/bin/bash

source `dirname $0`/utils.sh

export DEPLOY_AMOUNT_DECIMALS=6

resetAddresses

startHHNode

npx hardhat --network $NETWORK deploy $VERIFY

POOL=`readAddress POOL`
dieOnError "Error reading PolicyPool address"

echo "PolicyPool = $POOL"

npx hardhat --network $NETWORK deploy:eToken  \
    --etk-name "Junior ETK" --save-addr JRETK \
    --pool-address $POOL $VERIFY || die "Error deploying eToken"

npx hardhat --network $NETWORK deploy:eToken  \
    --etk-name "Senior ETK" --save-addr SRETK \
    --pool-address $POOL $VERIFY || die "Error deploying eToken"

JRETK=`readAddress JRETK`
SRETK=`readAddress SRETK`

npx hardhat --network $NETWORK deploy:premiumsAccount $VERIFY --pool-address $POOL \
    --junior-etk $JRETK --senior-etk $SRETK

PREMIUMS_ACCOUNT=`readAddress PA`
dieOnError "Error deploying Premiums Account"

echo "PremiumsAccount = $PREMIUMS_ACCOUNT"

npx hardhat --network $NETWORK deploy:riskModule $VERIFY --pool-address $POOL \
    --pa-address $PREMIUMS_ACCOUNT \
    --wallet 0x951B9B8a7b0e3701E757c015F43df9F2F867B824 || die "Error deploying riskModule"

# Whitelist
npx hardhat --network $NETWORK deploy:whitelist $VERIFY \
    --pool-address $POOL --e-token $SRETK
dieOnError "Error deploying Whitelist"

killPID $HHNODE_PID
