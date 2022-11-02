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

startHHNode() {
    if [ $NETWORK == "localhost" ]; then
        HHNODE_RUNNING=`ps aux | grep "/.bin/hardhat node" | grep -v grep  | cut -c10-15`
        if [ -z $HHNODE_RUNNING ]; then
            START_HHNODE=1
        fi
    fi

    if [ ! -z $START_HHNODE ]; then
        echo "Starting hardhat node"
        # npx hardhat node $* >/dev/null &
        node_modules/.bin/hardhat node $* >/dev/null &

        HHNODE_PID=$!
        sleep 5
        kill -0 $HHNODE_PID || die "Error launching hardhat node localhost"
    fi
}

readAddress() {
    if [ -z $ADDRESSES_FILENAME ]; then
        ADDRESSES_FILENAME=".addresses-$NETWORK.json"
    fi
    python -c "import json; print(json.load(open('$ADDRESSES_FILENAME'))['$1'])"
    exit $?
}

resetAddresses() {
    python -c "open('.addresses.json', 'wt').write('{}')"
}

readPK() {
    if [ $NETWORK != "localhost" ]; then
        PK_VAR=${NETWORK^^}_ACCOUNTPK_1

        if [ -z ${!PK_VAR} ]; then
            read -p "Please enter the PK for the account: " -s $PK_VAR
            export $PK_VAR
        fi
    fi
}

killPID() {
    if [ ! -z $1 ]; then
        kill $1
    fi
}
