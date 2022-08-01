# nodejs-cranker-connector

A connector side implementation of [cranker](https://github.com/nicferrier/cranker).

## Usage

1. install dependency

    ```shell
    npm install -D nodejs-cranker-connector
    ```

1. register to cranker gateway as below

    ```javascript

    // connect to cranker like
    const connector = await connectToRouter({
        targetURI,
        targetServiceName: 'my-service',
        routerURIProvider: () => (["ws://localhost:12002"]),
        slidingWindow: 2
    });

    // you can expose connector status in your microservice's health
    // don't expose this to public, it's only for DevOps purpose
    app.get('/health', (req, res) => {
        res.status(200).send({
            component: 'my-service',
            isHealthy: true,
            connector: connector?.status()
        });
    })

    // if you need to connect to cranker server with wss, provide the httpsAgent
    const connector = await connectToRouter({
        targetURI,
        targetServiceName: 'my-service',
        routerURIProvider: () => (["wss://localhost:12002"]),
        slidingWindow: 2,
        httpsAgent: new https.Agent({
            rejectUnauthorized: false // demo purpose, don't do this in production!
        })
    });
    ```

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
