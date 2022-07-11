#!/bin/bash

die() {
    printf "ERROR: %s\n" "$*"
    exit 1
}

dieOnError() {
    if [ $? -ne 0 ]; then
        die $1
    fi
}

export DEPLOY_AMOUNT_DECIMALS=6

NETWORK=${NETWORK:-localhost}

if [ $NETWORK == "localhost" ]; then
    GANACHE_RUNNING=`ps aux | grep ganache-cli | grep -v grep  | cut -c10-15`
    if [ -z $GANACHE_RUNNING ]; then
        START_GANACHE=1
    fi
fi

if [ ! -z $START_GANACHE ]; then
    ganache-cli -q &

    GANACHE_PID=$!
    sleep 2
    kill -0 $GANACHE_PID || die "Error launching ganache-cli localhost"
fi

TMPFILE=`mktemp`

npx hardhat --network $NETWORK deploy $VERIFY | tee $TMPFILE

POOL=`egrep -o  "^PolicyPool deployed to: (https?://.*/)?0x[0-9a-fA-F]+" $TMPFILE |
    sed -r 's|PolicyPool deployed to: (https?://.*/)?(0x[0-9a-fA-F]+)|\2|g'`

if [ $? -ne 0 ]; then
    die "Error deploying pool"
fi

echo "PolicyPool = $POOL"

npx hardhat --network $NETWORK deploy:premiumsAccount $VERIFY --pool-address $POOL | tee $TMPFILE

PREMIUMS_ACCOUNT=`egrep -o  "^PremiumsAccount deployed to: (https?://.*/)?0x[0-9a-fA-F]+" $TMPFILE |
    sed -r 's|PremiumsAccount deployed to: (https?://.*/)?(0x[0-9a-fA-F]+)|\2|g'`

if [ $? -ne 0 ]; then
    die "Error deploying Premiums Account"
fi

echo "PremiumsAccount = $PREMIUMS_ACCOUNT"

npx hardhat --network $NETWORK deploy:eToken  \
    --pool-address $POOL $VERIFY || die "Error deploying eToken"

npx hardhat --network $NETWORK deploy:riskModule $VERIFY --pool-address $POOL \
    --pa-address $PREMIUMS_ACCOUNT \
    --wallet 0x951B9B8a7b0e3701E757c015F43df9F2F867B824 || die "Error deploying riskModule"

# FlightDelayRiskModule
npx hardhat --network $NETWORK deploy:fdRiskModule $VERIFY --pool-address $POOL \
    --pa-address $PREMIUMS_ACCOUNT \
    --rm-name "Flight Delay Insurance" --max-scr-per-policy 10000 --scr-limit 240000 \
    --wallet 0xc62c56f50FcE8881Ec5D7271Af5Bea6f18c88183 \
    --link-token 0x326c977e6efc84e512bb9c30f76e30c160ed06fb \
    --oracle 0x0a908660e9319413a16978fa48df641b4bf37c54 \
    --data-job-id 0x2fb0c3a36f924e4ab43040291e14e0b7 \
    --sleep-job-id 0x4241bd0288324bf8a2c683833d0b824f  || die "Error deploying FlightDelayRiskModule"

# FixedRateAssetManager
npx hardhat --network $NETWORK deploy:fixedInterestAssetManager $VERIFY \
    --pool-address $POOL || die "Error deploying FixedRateAssetManager"

# Whitelist
npx hardhat --network $NETWORK deploy:whitelist $VERIFY \
    --pool-address $POOL
dieOnError "Error deploying Whitelist"

# Exchange
npx hardhat --network $NETWORK deploy:exchange $VERIFY \
    --pool-address $POOL
dieOnError "Error deploying Exchange"

if [ ! -z $GANACHE_PID ]; then
    kill $GANACHE_PID
fi
