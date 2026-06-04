// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title ReentrantPolicyHolderMock
 * @notice Test helper: arms a reentrant call to fire during onERC721Received.
 *         Records whether the reentrant call succeeded or failed without
 *         propagating the error, so the outer transaction can complete.
 *         Used to verify that the replacePolicy reentrancy fix (deleting the old
 *         policy before _safeMint) prevents duplicate-accounting attacks.
 */
contract ReentrantPolicyHolderMock is IERC721Receiver {
    address public target;
    bytes public reentrantCallData;
    bool public armed;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryRevertData;

    function arm(address target_, bytes calldata callData_) external {
        target = target_;
        reentrantCallData = callData_;
        armed = true;
        reentryAttempted = false;
        reentrySucceeded = false;
        delete reentryRevertData;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external override returns (bytes4) {
        if (armed) {
            armed = false;
            reentryAttempted = true;
            (bool ok, bytes memory returnData) = target.call(reentrantCallData);
            reentrySucceeded = ok;
            if (!ok) reentryRevertData = returnData;
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
