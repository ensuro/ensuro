#!/bin/bash

die() {
    printf "ERROR: %s\n" "$*"
    exit 1
}

npx hardhat compile || die "Failed to compile contracts"
npx hardhat size-contracts || die "Failed to size contracts"

npm run solhint || die "Linting error"

SKIP_PROXY=1 brownie test -v --coverage || die "Error running tests"
SCRIBBLED_FILES="contracts/PolicyPool.sol contracts/Policy.sol"

for FILE in $SCRIBBLED_FILES; do
    scribble $FILE --output-mode files --arm
done

# Test again with the instrumented files
brownie test -v || die "Error running instrumented tests"
