#!/bin/bash

npx hardhat compile

brownie test -v --coverage
