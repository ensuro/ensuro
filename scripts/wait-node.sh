# Simple script to wait for the eth node to be ready

if [ -z "$1" ]; then
    echo "Usage: $0 <node_url>"
    exit 1
fi

set -euo pipefail

while ! curl $1 --fail -X POST -H "Content-Type: application/json" -d '{"method":"eth_blockNumber","params":[],"id":1,"jsonrpc":"2.0"}' > /dev/null 2>&1; do
    echo "Waiting for node start"
    sleep 1
done
