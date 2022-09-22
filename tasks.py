from invoke import task, Collection
from py_docker_k8s_tasks import docker_tasks, util_tasks
from py_docker_k8s_tasks.docker_tasks import docker_exec
from py_docker_k8s_tasks.util_tasks import add_tasks

ns = Collection()
add_tasks(ns, docker_tasks)
add_tasks(ns, util_tasks, "ramdisk")


@ns.add_task
@task
def gunicorn(c):
    docker_tasks.docker_exec(
        c,
        "/usr/local/bin/gunicorn --config /usr/local/app/gunicorn.py "
        "-b :8000 app.server:app",
    )


@ns.add_task
@task
def flask(c, port=8000):
    docker_exec(c, "flask run -h 0.0.0.0")


@ns.add_task
@task
def jupyter(c):
    docker_exec(c, "tini -g -- start-notebook.sh", workdir="/home/jovyan")


@ns.add_task
@task
def kill_flask(c):
    docker_exec(c, "killall flask")


@ns.add_task
@task
def test(c, coverage=False, longrun=False):
    # coverage = "--cov=app --cov-config=app/.coveragerc" if coverage else ""
    # longrun = "--longrun" if longrun else ""
    docker_exec(c, "brownie test --gas")
    if longrun:
        docker_exec(c, "npm install")
        docker_exec(c, "npx hardhat compile")
        docker_exec(c, "npx hardhat test")


@ns.add_task
@task
def refresh_requirements_txt(c, upgrade=False, package=None):
    """Refresh requirements.txt and requirements-dev.txt using pip-tools

    --upgrade will upgrade all packages to latest version
    --package will upgrade a single package
    """
    upgrade = "--upgrade" if upgrade else ""
    package = f"-P {package}" if package is not None else ""
    docker_exec(c, f"pip-compile {upgrade} {package} requirements.in")
    docker_exec(c, f"pip-compile {upgrade} {package} requirements-dev.in")


@ns.add_task
@task
def docs(c, serve=True, clean=True, open_browser=True, browser="brave-browser"):
    serve = "serve" if serve else ""
    clean = "clean" if clean else ""
    if open_browser:
        c.run(f"sleep 5 && {browser} http://127.0.0.1:18000/", asynchronous=True)
    docker_exec(c, f"scripts/build-docs.sh {clean} {serve}")
