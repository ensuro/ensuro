FROM python:3.9

RUN pip install --no-cache-dir m9g \
                               pyyaml \
                               numpy \
                               eth-brownie \
                               environs

# Installs some utils for debugging
ARG DEV_ENV="0"
RUN if [ $DEV_ENV -ne 0 ]; then pip install ipdb ipython rpdb colorama responses pytest pytest-cov; fi

RUN pip install -e "git+https://github.com/gnarvaja/mythril.git#egg=mythril"

ENV DEV_ENV $DEV_ENV

RUN curl -sL https://solc-bin.ethereum.org/linux-amd64/solc-linux-amd64-v0.8.6+commit.11564f7e > /usr/local/bin/solc && chmod +x /usr/local/bin/solc
RUN python -c "import solcx; solcx.import_installed_solc()"
RUN curl -sL https://deb.nodesource.com/setup_14.x | bash
RUN apt-get install -y nodejs
RUN npm install -g ganache-cli eth-scribble --unsafe-perm

ENV SETUP_FILE "/usr/local/app/setup.yaml"

ADD . /usr/local/app

WORKDIR /usr/local/app/

RUN npm install
