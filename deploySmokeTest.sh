#!/bin/bash

die() {
    printf "ERROR: %s\n" "$*"
    exit 1
}

ganache-cli -q &

GANACHE_PID=$!
sleep 2
kill -0 $GANACHE_PID || die "Error launching ganache-cli localhost"

POOL_ADDRESS=`npx hardhat --network localhost deploy |
    egrep -o  "^PolicyPool deployed to: 0x[0-9a-fA-F]+" |
    sed -r 's|PolicyPool deployed to: (0x[0-9a-fA-F]+)|\1|g'`

if [ $? -ne 0 ]; then
    die "Error deploying pool"
fi

echo "PolicyPool = $POOL_ADDRESS"

npx hardhat --network localhost deploy:eToken  --pool-address $POOL_ADDRESS
if [ $? -ne 0 ]; then
    die "Error deploying eToken"
fi

npx hardhat --network localhost deploy:riskModule  --pool-address $POOL_ADDRESS --wallet 0x951B9B8a7b0e3701E757c015F43df9F2F867B824
if [ $? -ne 0 ]; then
    die "Error deploying riskModule"
fi

kill $GANACHE_PID
