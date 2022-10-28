#!/bin/bash

set -e

VERSION=$1
shift

if [ -z $VERSION ]; then
    echo "Usage: $0 <version> [<target dir>]" >&2
    exit 13
fi

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
echo "Changing fixed pragma to developer friendly one '^0.8.0'"
scripts/change-pragma.sh $TARGET_DIR/contracts '^0.8.0'

mkdir $TARGET_DIR/build
cp -r artifacts/contracts $TARGET_DIR/build

mkdir $TARGET_DIR/js
cp test/test-utils.js $TARGET_DIR/js/
cp tasks/deploy.js $TARGET_DIR/js/

find $TARGET_DIR -name "*.dbg.json" -delete
sed "s/%%VERSION%%/$VERSION/" npm-package/package.json > "$TARGET_DIR/package.json"

echo "

Now you should run:
cd $TARGET_DIR
npm login  # If not done already
npm publish --access public
"
