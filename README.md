# nodejs-cranker-connector

A connector side implementation of [cranker](https://github.com/nicferrier/cranker).

## Development

1. Start cranker server: git clone [cranker](https://github.com/hsbc/mu-cranker-router) to your local, running `RunLocal.java` in it.
2. Start client side: running `npm run local` 

## Manual Testing

```shell
# GET
curl -k https://localhost:12000/my-service/get

# POST
curl -k -X POST https://localhost:12000/my-service/post \
    -H "Content-Type: application/json" \
    -d '{"name":"hello"}'
```
