# Protocol simulation

For testing purposes only (at least for now).


## Invoke

This folder uses invoke (http://www.pyinvoke.org/) and inv-py-docker-k8s-tasks (`pip install inv-py-docker-k8s-tasks`) to 
launch and run common task from inside docker.

```
pip install inv-py-docker-k8s-tasks
cp .env.sample .env
inv start-dev
```

This should build and run the docker container. This keeps the container running doing nothing and you can launch the tasks.


## Jupyter Notebook

To launch the Jupyter notebook from docker you can run `inv jupyter`. This will run jupyter inside the
docker container (first you have to run `inv start-dev`). It will print a localhost address to launch in 
the browser.


## CLI Commands

```bash
python -m app.cli deposit USD1YEAR LP1 1000
python -m app.cli deposit USD1YEAR LP2 3000
python -m app.cli fast-forward-time 1w
python -m app.cli balance USD1YEAR LP1
python -m app.cli new-policy Roulette 36 1 --loss_prob .027027
python -m app.cli total-supply USD1YEAR
python -m app.cli get-interest-rates USD1YEAR
python -m app.cli resolve-policy Roulette 1 --customer_won=true

```

