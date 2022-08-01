FROM python:3.9

RUN curl -sL https://solc-bin.ethereum.org/linux-amd64/solc-linux-amd64-v0.8.6+commit.11564f7e > /usr/local/bin/solc && chmod +x /usr/local/bin/solc
RUN curl -sL https://deb.nodesource.com/setup_12.x | bash
RUN apt-get install -y nodejs
RUN npm config set unsafe-perm true
RUN npm install -g ganache eth-scribble

RUN echo 'alias hh="npx hardhat"' >> /root/.bashrc

COPY requirements.txt /requirements.txt
RUN pip install --no-cache-dir -r /requirements.txt \
    && python -c "import solcx; solcx.import_installed_solc()"

# Installs some utils for debugging
COPY requirements-dev.txt /requirements-dev.txt
RUN pip install -r /requirements-dev.txt

ARG DEV_ENV
ENV DEV_ENV $DEV_ENV

ENV M9G_VALIDATE_TYPES "Y"
ENV M9G_SERIALIZE_THIN "Y"

ENV PYTEST_TIMEOUT "300"
WORKDIR /code
