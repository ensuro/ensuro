FROM python:3-alpine

ENV GUNICORN_WORKERS 1
ENV GUNICORN_WORKER_CLASS "gevent"
ENV GUNICORN_WORKER_CONNECTIONS "100"
ENV GUNICORN_MAX_REQUESTS "50000"
ENV GUNICORN_ACCESSLOG -

RUN apk --no-cache add build-base libffi-dev && \
    pip install --no-cache-dir Flask \
                               gunicorn[gevent] \
                               pyyaml \
                               environs && \
    apk del build-base

# Installs some utils for debugging
ARG DEV_ENV="0"
RUN if [ $DEV_ENV -ne 0 ]; then pip install ipdb ipython rpdb colorama responses pytest pytest-cov; fi

ENV DEV_ENV $DEV_ENV

ENV SETUP_FILE "/usr/local/app/setup.yaml"

ADD gunicorn.py server.py prototype.py cli.py setup.yaml /usr/local/app/

# ADD tests/ /usr/local/app/tests

WORKDIR /usr/local

EXPOSE 8000

CMD ["/usr/local/bin/gunicorn", "--config", "/usr/local/app/gunicorn.py", "-b", ":8000", "app.server:app"]
