#!/bin/bash

if [ "xx$1" == "xxclean" ]; then
    rm -fR docs
    shift
fi

npx hardhat docgen
cp README.md docs/index.md
cp Architecture.png docs/

if [ "xx$1" == "xxserve" ]; then
    mkdocs serve -a 0.0.0.0:8000
fi
