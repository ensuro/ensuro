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

export AMOUNT_DECIMALS=6

NETWORK=${NETWORK:-localhost}

if [ $NETWORK == "localhost" ]; then
    HHNODE_RUNNING=`ps aux | grep "npx hardhat node" | grep -v grep  | cut -c10-15`
    if [ -z $HHNODE_RUNNING ]; then
        START_HHNODE=1
    fi
fi

if [ -z $ALCHEMY_URL ]; then
    echo "Must set environment variable $ALCHEMY_URL"
    exit 1
fi

if [ ! -z $START_HHNODE ]; then
    npx hardhat node --fork $ALCHEMY_URL >/dev/null &

    HHNODE_PID=$!
    sleep 2
    kill -0 $HHNODE_PID || die "Error launching hardhat node localhost"
fi

USDC=0x2791bca1f2de4661ed88a30c99a7a9449aa84174
AAVE_ADDR_PROV=0xd05e3E715d945B59290df0ae8eF85c1BdB684744  # Polygon Aave
SWAP_ROUTER=0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506  # Polygon SushiSwap

POOL=`npx hardhat --network $NETWORK deploy $VERIFY --currency-address $USDC |
    egrep -o  "^PolicyPool deployed to: (https?://.*/)?0x[0-9a-fA-F]+" |
    sed -r 's|PolicyPool deployed to: (https?://.*/)?(0x[0-9a-fA-F]+)|\2|g'`

if [ $? -ne 0 ]; then
    die "Error deploying pool"
fi

echo "PolicyPool = $POOL"

# AaveAssetManager
npx hardhat --network $NETWORK deploy:aaveAssetManager $VERIFY \
   --aave-addr-prov $AAVE_ADDR_PROV \
   --swap-router $SWAP_ROUTER \
    --pool-address $POOL || die "Error deploying AaveAssetManager"

# if [ ! -z $HHNODE_PID ]; then
#    kill $HHNODE_PID
# fi
