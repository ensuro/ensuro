# API server

For testing purposes only (at least for now).

Installing `pip install inv-py-docker-k8s-tasks` you can use `inv start-dev` to build and start the docker container. 

Also other common commands for developing inside docker are available (`inv -l`)


## CLI Commands

```bash
python -m app.cli deposit USD1YEAR LP1 1000
python -m app.cli deposit USD1YEAR LP2 3000
python -m app.cli fast-forward-time 1w
python -m app.cli balance USD1YEAR LP1
python -m app.cli new-policy Roulette 36 1 --loss_prob .027027
python -m app.cli total-supply USD1YEAR
python -m app.cli get-interest-rates USD1YEAR
python -m app.cli resolve-policy Roulette 36 --customer_won

```
