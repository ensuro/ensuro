FROM python:3.13

ENV NODE_MAJOR=24
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install nodejs -y

# Install uv (system-wide, as root) and use it to install the Python dependencies
RUN pip install uv==0.12.17

COPY requirements.txt /requirements.txt
RUN uv pip install --system -r /requirements.txt

# Installs some utils for debugging
COPY requirements-dev.txt /requirements-dev.txt
RUN uv pip install --system -r /requirements-dev.txt && uv cache clean

# Let's make this work with an unprivileged user
RUN useradd --create-home ensuro
USER ensuro
WORKDIR /home/ensuro

ENV HOME_DIR /home/ensuro

RUN echo 'alias hh="npx hardhat"\nsource $HOME/code/scripts/utils.sh' >> $HOME/.bashrc

ARG DEV_ENV
ENV DEV_ENV $DEV_ENV

ENV M9G_VALIDATE_TYPES "Y"
ENV M9G_SERIALIZE_THIN "Y"
ENV USE_CUSTOM_ERRORS "Y"

ENV PYTEST_TIMEOUT "300"

WORKDIR /home/ensuro/code
