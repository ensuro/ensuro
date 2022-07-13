pragma solidity ^0.8.0;

/* 
This is a workaround for:

https://github.com/eth-brownie/brownie/issues/1581

Which affects ethproto. The contract is just here for ethproto's 
sake and is not actually used by any contract.

Once that bug is fixed (either in brownie or in ethproto) this
file can be safely removed.

*/

import {IERC20Metadata as IERC20MetadataOriginal} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface IERC20Metadata is IERC20MetadataOriginal {}
