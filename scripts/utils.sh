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

getHHNodePID() {
    ps ax | grep "/.bin/hardhat node" | grep -v grep  | awk '{print $1}'
}

waitHHNode() {
    if [ -z "$1" ]; then
        echo "Usage: $0 <node_url>"
        exit 1
    fi
    while ! curl $1 --fail -X POST -H "Content-Type: application/json" -d '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}' > /dev/null 2>&1; do
        echo "Waiting for node start"
        sleep 1
    done
}

startHHNode() {
    if [ $NETWORK == "localhost" ]; then
        HHNODE_RUNNING=$(getHHNodePID)
        if [ -n "$HHNODE_RUNNING" ]; then
            echo "Terminating existing hardhat node at PID $HHNODE_RUNNING"
            kill -- $HHNODE_RUNNING
        fi
    fi

    echo "Starting hardhat node"
    node_modules/.bin/hardhat node "$@" > /dev/null &

    waitHHNode http://localhost:8545
}

readAddress() {
    if [ -z $ADDRESSES_FILENAME ]; then
        export ADDRESSES_FILENAME=".addresses-$NETWORK.json"
    fi
    python -c "import json; print(json.load(open('$ADDRESSES_FILENAME'))['$1'])"
    exit $?
}

resetAddresses() {
    if [ -z $ADDRESSES_FILENAME ]; then
        export ADDRESSES_FILENAME=".addresses-$NETWORK.json"
    fi
    python -c "open('$ADDRESSES_FILENAME', 'wt').write('{}')"
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
