FROM gnarvaja/eth-dev

ENV SETUP_FILE "/usr/local/app/setup.yaml"

ADD . /usr/local/app

WORKDIR /usr/local/app/

RUN npm install
