FROM gnarvaja/eth-dev:1.0.0

ENV SETUP_FILE "/usr/local/app/setup.yaml"
ENV M9G_VALIDATE_TYPES "Y"
ENV M9G_SERIALIZE_THIN "Y"

WORKDIR /code
