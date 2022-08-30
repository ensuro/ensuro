#!/bin/bash

TARGET_DIR=$1

if [ -z $TARGET_DIR ]; then
    TARGET_DIR=./build/npm-package/
fi

rm -fr $TARGET_DIR 2>/dev/null

mkdir -p $TARGET_DIR

npx hardhat clean
env COMPILE_MODE=production npx hardhat compile

git archive --format tar HEAD README.md contracts/ | tar xv -C $TARGET_DIR
# rm -fR $TARGET_DIR/contracts/mocks/

mkdir $TARGET_DIR/build
cp -r artifacts/contracts $TARGET_DIR/build

mkdir $TARGET_DIR/js
cp test/test-utils.js $TARGET_DIR/js/

find $TARGET_DIR -name "*.dbg.json" -delete
cp npm-package/package.json $TARGET_DIR

echo "

Now you should run:
cd $TARGET_DIR
npm login  # If not done already
npm publish --access public
"
