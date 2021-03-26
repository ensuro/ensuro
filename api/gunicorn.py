# taken from: https://sebest.github.io/post/protips-using-gunicorn-inside-a-docker-image/
import os

for k, v in os.environ.items():
    if k.startswith("GUNICORN_"):
        key = k.split('_', 1)[1].lower()
        locals()[key] = v


def setup_hooks():
    try:
        from app import gunicorn_hooks as server_hooks
    except ImportError:
        return

    hooks = (
        "on_starting,on_reload,when_ready,pre_fork,post_fork,post_worker_init,worker_int,"
        "worker_abort,pre_exec,pre_request,post_request,child_exit,worker_exit,nworkers_changed,on_exit"
    )

    for hook_name in hooks.split(","):
        hook = getattr(server_hooks, hook_name, None)
        if hook:
            globals()[hook_name] = hook


setup_hooks()
