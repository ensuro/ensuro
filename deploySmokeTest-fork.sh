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
    echo "Starting hardhat node"
    npx hardhat node --fork $ALCHEMY_URL >/dev/null &

    HHNODE_PID=$!
    sleep 5
    kill -0 $HHNODE_PID || die "Error launching hardhat node localhost"
fi

USDC=0x2791bca1f2de4661ed88a30c99a7a9449aa84174
AAVE_ADDR_PROV=0xd05e3E715d945B59290df0ae8eF85c1BdB684744  # Polygon Aave
SWAP_ROUTER=0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506  # Polygon SushiSwap
PRICE_ORACLE=0x0229f777b0fab107f9591a41d5f02e4e98db6f2d  # Polygon Price Oracle of AAVE

TMPFILE=`mktemp`
npx hardhat --network $NETWORK deploy $VERIFY --currency-address $USDC | tee $TMPFILE

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

# Exchange
npx hardhat --network $NETWORK deploy:exchange $VERIFY \
   --swap-router $SWAP_ROUTER \
   --price-oracle $PRICE_ORACLE \
    --pool-address $POOL || die "Error deploying Exchange"

if [ ! -z $HHNODE_PID ]; then
   kill $HHNODE_PID
fi
