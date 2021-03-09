# Ensuro - Descentrilized insurer

Ensuro is a decentralized pool of capital to support insurance products. It will democratize the possibilities and the benefits  of being an insurer for everyone, while allowing innovative companies to nurture and deploy novel, life changing insurance products.

## Smart Contracts

For better understanding of the protocol, check [this demo](BinanceHackathonDemo.md).

### contracts/Ensuro.sol

This is the main smart contract of the protocol, that manages the liquidity pool and the active policies. Works with plugged in risk modules.

### contracts/EnsuroRoulette.sol

This is a toy example of a risk module, a Roulette. The policy parameter is the number the customer bets on, and the prize is 36 times the premium. We *swipe* the roulette and pick the resulting number.

It shows the interface and overall behaviour of risk modules.



Developed and tested using https://hardhat.org/

