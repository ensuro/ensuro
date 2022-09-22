#!/bin/bash

source `dirname $0`/utils.sh

if [ "xx$1" == "xxclean" ]; then
    rm -fR docs/*.md docs/interfaces/ docs/audits docs/*.png
    shift
fi

npx hardhat docgen
dieOnError "Error generating docs with solidity-docgen"

npx prettier --write docs
dieOnError "Error running prettier"

cp README.md docs/index.md
cp -r CONTRIBUTING.md CODE_OF_CONDUCT.md audits docs/
cp Architecture.png docs/

if [ "xx$1" == "xxserve" ]; then
    mkdocs serve -a 0.0.0.0:8000
fi
