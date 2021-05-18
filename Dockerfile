ARG BASE_CONTAINER=jupyter/scipy-notebook
FROM $BASE_CONTAINER

ENV GUNICORN_WORKERS 1
ENV GUNICORN_WORKER_CLASS "gevent"
ENV GUNICORN_WORKER_CONNECTIONS "100"
ENV GUNICORN_MAX_REQUESTS "50000"
ENV GUNICORN_ACCESSLOG -

RUN pip install --no-cache-dir Flask \
                               gunicorn[gevent] \
                               m9g \
                               pyyaml \
                               eth-brownie \
                               environs

# Installs some utils for debugging
ARG DEV_ENV="0"
RUN if [ $DEV_ENV -ne 0 ]; then pip install ipdb ipython rpdb colorama responses pytest pytest-cov; fi

ENV DEV_ENV $DEV_ENV

ENV SETUP_FILE "/home/jovyan/app/setup.yaml"

RUN brownie networks add Development dev cmd=ganache-cli host=http://ganache-cli:8545
RUN brownie pm install OpenZeppelin/openzeppelin-contracts@4.1.0

# ADD gunicorn.py server.py prototype.py cli.py wadray.py utils.py setup.yaml /home/jovyan/app/
# ADD prototype /home/jovyan/ensuro/prototype/

ENV PYTHONPATH /home/jovyan
# ADD tests/ /usr/local/app/tests

WORKDIR /home/jovyan/app

EXPOSE 8000

CMD ["/usr/local/bin/gunicorn", "--config", "/home/jovyan/app/gunicorn.py", "-b", ":8000", "app.server:app"]
