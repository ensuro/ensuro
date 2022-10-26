#!/bin/bash

if [ $# -ne 2 ]; then
    echo "Usage $0 <contracts-dir> <new-pragma>"
    exit 1
fi

CONTRACTS_DIR=$1
NEW_PRAGMA=$2

MD5S=`mktemp`

md5sum `find $CONTRACTS_DIR -name "*.sol"` > $MD5S

for SOLFILE in `find $CONTRACTS_DIR -name "*.sol"`; do
    sed -i -r "s/^pragma solidity [0-9^~.]+;/pragma solidity $NEW_PRAGMA;/g" $SOLFILE
done

md5sum --check $MD5S | sed 's/: OK/: UNCHANGED/g' | sed 's/: FAILED/: MODIFIED/g' | grep -v "md5sum: "
