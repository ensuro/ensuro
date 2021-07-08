#!/bin/bash

npx hardhat compile

brownie test -v --coverage
SCRIBBLED_FILES="contracts/PolicyPool.sol contracts/Policy.sol"

for FILE in $SCRIBBLED_FILES; do
    scribble $FILE --output-mode files --arm
done

# Test again with the instrumented files
brownie test -v
