// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/*
This is a workaround for:

https://github.com/eth-brownie/brownie/issues/1581

Which affects ethproto. The contract is just here for ethproto's
sake and is not actually used by any contract.

Once that bug is fixed (either in brownie or in ethproto) this
file can be safely removed.

*/

import {ERC1967Proxy as ERC1967ProxyOriginal} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

abstract contract ERC1967Proxy is ERC1967ProxyOriginal {}
