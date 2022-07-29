pragma solidity ^0.8.3;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20Faucet {
    ERC20 public token;

    address public owner;

    // units of token allowed for tapping into the faucet
    uint256 public dailyLimit;

    mapping(address => uint) public lockTime;

    event Tapped(address from, uint256 amount);

    constructor(address _token, uint256 _dailyLimit) {
        token = ERC20(_token);
        owner = msg.sender;
        dailyLimit = _dailyLimit;
    }

    function totalSupply() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function tap() public {
        require(block.timestamp > lockTime[msg.sender], "No soup for you!");
        uint8 decimals = token.decimals();
        uint256 amount = dailyLimit * (10**decimals);
        require(this.totalSupply() >= amount, "Insufficient supply");

        lockTime[msg.sender] = block.timestamp + 1 days;
        
        token.transfer(msg.sender, amount);

        emit Tapped(msg.sender, dailyLimit);
    }
}
