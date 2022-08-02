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

# FlightDelayRiskModule
npx hardhat --network $NETWORK deploy:fdRiskModule $VERIFY --pool-address $POOL \
    --pa-address $PREMIUMS_ACCOUNT \
    --rm-name "Flight Delay Insurance" --max-payout-per-policy 10000 --exposure-limit 240000 \
    --wallet 0xc62c56f50FcE8881Ec5D7271Af5Bea6f18c88183 \
    --link-token 0x326c977e6efc84e512bb9c30f76e30c160ed06fb \
    --oracle 0x0a908660e9319413a16978fa48df641b4bf37c54 \
    --data-job-id 0x2fb0c3a36f924e4ab43040291e14e0b7 \
    --sleep-job-id 0x4241bd0288324bf8a2c683833d0b824f  || die "Error deploying FlightDelayRiskModule"

# Whitelist
npx hardhat --network $NETWORK deploy:whitelist $VERIFY \
    --pool-address $POOL
dieOnError "Error deploying Whitelist"

# Exchange
npx hardhat --network $NETWORK deploy:exchange $VERIFY \
    --pool-address $POOL
dieOnError "Error deploying Exchange"

killPID $HHNODE_PID
