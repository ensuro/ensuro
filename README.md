# Ensuro Roulette Risk Module

For this hackathon we focused on the Ensuro Protocol, to manage the funds invested by liquidity providers to back up insurance policies.

The protocol will run with risk modules plugged on it. These risk modules are going to be responsible for policy calculation (relation between premium and prize) and for the resolution (whether we have to pay to the customer or not, based on external events read from an oracle).

For this demo we did a very simple risk module, a Roulette. The policy parameter is the number the customer bets on and the prize is 36 times the premium. And we swipe the roulette with the resulting number.

Developed and tested using https://hardhat.org/
