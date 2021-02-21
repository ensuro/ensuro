# Binance Hackathon Demo walkthrough

## Introduction

For this hackathon we focused on the Ensuro Protocol, to manage the funds invested by liquidity providers to back up policies.

The protocol will run with *risk modules* plugged on it. These *risk modules* are going to be responsible for policy calculation (relation between premium and prize) and for the resolution (whether we have to pay to the customer or not, based on external events read from an oracle).

For this demo we did a very simple *risk module*, a Roulette. The policy parameter is the number the customer bets on and the prize is 36 times the premium. And we *swipe* the roulette with the resulting number.


## 1. Initial setup

TEST currency (ERC20 token deployed by us) balances

- Prov1: 100K
- Prov2: 200K
- Prov3: 300K
- Cust1: 10K
- Cust2: 20K

Contracts deployed on Binance Chain Testnet:
- TestCurrency (ERC20 Token) Contract deployed at 0x4C1878852e7b5E91e9D5dE04f67Af7707F14E5f7
- EnsuroProtocol Contract deployed at 0x2F1A668195692670c36915ef6e5D73F9A5662287
- EnsuroRoulette Contract deployed at 0x499bd60476DD101b0FE58119D5B4a178443f37aA


## 2. Providers investment

- Prov1 invests 10K with cashback period of 1WEEK
- Prov2 invests 20K with cashback period of 2WEEK
- Prov3 invests 30K with cashback period of 3WEEK

*they are careful investors, so they invest only 10% of their capital in Ensuro*

1. Prov1 runs: TEST.approve(EnsuroProtocol.address, 10K)
2. Prov1 runs: EnsuroProtocol.invest(10K, 1WEEK)

Same with providers 2 and 3.

Ocean Available = **60K**


## 3. Customer 1 acquire policy

Cust1 bets 1K on number 17, premium 1K / prize 36K, expiration date: 6DAYS = 518400 (seconds)

1. Cust1 runs: TEST.approve(EnsuroProtocol.address, 1K)
2. Cust1 runs: EnsuroRoulette.new_policy(17, 1000, 36000, 518400)

Expected result:

1. ocean_available = 25K (60K - 35K)
2. All three providers eligible for this policy. MCR distributed among them proportionally
   a. Prov1: 5833
   b. Prov2: 11666
   c. Prov3: 17501


## 4. Customer 2 acquire policy

Cust2 bets 0.5K on number 15, premium 500 / prize 18K, expiration date: 8DAYS = 691200 (seconds)

1. Cust2 runs: TEST.approve(EnsuroProtocol.address, 500)
2. Cust2 runs: EnsuroRoulette.new_policy(15, 500, 18000, 691200)

Expected result:

1. ocean_available = 7.5K (25K - 17.5K)
2. Prov1 is not eligible for this policy because it's cashback period is 1 WEEK and this policy expires in 8 DAYS. So, policy MCR distributed among providers 2 and 3, Prov1 unaffected
    1. Prov1.locked_amount: 5833 (unchanged)
    2. Prov2.locked_amount: 18666 (11666 + 7000)
    3. Prov3.locked_amount: 28001 (17501 + 10500)


## 5. Prov1 ask for withdrawal

Prov1 asks for withdrawal as soon as possible. He receives inmediatelly the unlocked amount and will receive the rest as policies resolve or expire (in less than 1 WEEK).

1. Prov1 runs: EnsuroProtocol.withdraw(1, ASAP=true)

Expected result:

1. He gets 4167 (10000 - 5833)
2. Ocean available: 3333 (7500 - 4167)


## 6. Swipe roulette for 1st policy - customer lost

We simulate roulette swipe with number 20 for policy 1, and the customer losts (he bet on number 17)

EnsuroRoulette.swipe_roulette(1, 20)

Expected result:
1. Premium (1K) distributed proportionally among three providers.
   1. Prov1 gets 166
   2. Prov2 gets 333
   3. Prov3 gets 501
2. In the same operation Prov1 became unlocked, so we transfer the rest of the investment along with the earned premium. Prov1 balance = 100K + 166
3. Ocean available: 33334


## 7. Swipe roulette for 2nd policy - customer 2 wins

We simulate roulette swipe with number 15 for policy 2 and the customer wins)

EnsuroRoulette.swipe_roulette(2, 17)

Expected result:
1. Customer 2 gets the prize, 18K (17.5K from MCR, .5K from premium). Cust2 balance = 20K + 17.5K
2. Ocean available: 33334 (does not change)
3. MCR = 0


## 8. Provider 2 and 3 withdraw
 
Provider 2 and 3 ask for withdrawal ASAP. No funds are locked so they get the money inmediatelly.

1. Prov2 runs: EnsuroProtocol.withdraw(2, ASAP=true)
2. Prov3 runs: EnsuroProtocol.withdraw(3, ASAP=true)

Expected result:
1. Prov2 balance: 200K + 333 - 7000 = 193333
2. Prov3 balance: 300K + 501 - 10500 = 290001
3. Ocean available: 0
