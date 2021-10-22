FROM python:3.9

RUN pip install --no-cache-dir m9g \
                               pyyaml \
                               eth-brownie\<1.17 \
                               eth-prototype[brownie]\>=0.2.0 \
                               environs

# Installs some utils for debugging
RUN pip install ipdb ipython rpdb colorama responses pytest pytest-cov

ENV DEV_ENV $DEV_ENV

RUN curl -sL https://solc-bin.ethereum.org/linux-amd64/solc-linux-amd64-v0.8.6+commit.11564f7e > /usr/local/bin/solc && chmod +x /usr/local/bin/solc
RUN python -c "import solcx; solcx.import_installed_solc()"
RUN curl -sL https://deb.nodesource.com/setup_12.x | bash
RUN apt-get install -y nodejs
RUN npm config set unsafe-perm true
RUN npm install -g ganache-cli eth-scribble

RUN echo 'alias hh="npx hardhat"' >> /root/.bashrc

ENV M9G_VALIDATE_TYPES "Y"
ENV M9G_SERIALIZE_THIN "Y"

RUN pip install --upgrade eth-prototype[brownie]==0.3.1
WORKDIR /code
