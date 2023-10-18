FROM python:3.9

RUN curl -sL https://solc-bin.ethereum.org/linux-amd64/solc-linux-amd64-v0.8.16+commit.07a7930e > /usr/local/bin/solc && chmod +x /usr/local/bin/solc

ENV NODE_MAJOR=16
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install nodejs -y

# Let's make this work with an unprivileged user using user-local packages
RUN useradd --create-home ensuro
USER ensuro
WORKDIR /home/ensuro

ENV HOME_DIR /home/ensuro
ENV PATH ${PATH}:${HOME_DIR}/.local/bin

RUN echo 'alias hh="npx hardhat"' >> $HOME/.bashrc

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
WORKDIR /home/ensuro/code
