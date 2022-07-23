import express from 'express'
import * as http from 'http'
import { Server } from 'http'
import { AddressInfo } from "net";
import { connectToRouter, CrankerConnector } from '../src/connector'

export async function listen(server: Server, port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
        server.listen(port, () => resolve(server))
    });
}

export async function close(server: Server) {
    return new Promise((resolve, reject) => {
        server.close(() => resolve(server))
    });
}

let connector: CrankerConnector;

async function httpServer(config: { port: number }): Promise<http.Server> {
    const app = express()
    app.use(express.json())

    app.get('/my-service/get', (req, res) => {
        res.status(200).send('Hello World!')
    })

    app.post('/my-service/post', (req, res) => {
        console.log('server received body', JSON.stringify(req.body))
        res.status(200).send(req.body)
    })

    app.get('/my-service/connector', (req, res) => {
        if (!connector) {
            res.send('');
            return;
        }
        res.status(200).send(connector.status());
    })

    const httpServer = http.createServer(app);
    return listen(httpServer, config.port)
}

async function main() {

    const server = await httpServer({port: 8080})
    const targetURI = `http://localhost:${(server.address() as AddressInfo).port}`
    console.log(`http server started: ${targetURI}/my-service/get`)

    connector = await connectToRouter({
        targetURI,
        targetServiceName: 'my-service',
        routerURIProvider: () => (["wss://localhost:12001"]),
        slidingWindow: 2
    });

}

process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = String(0);

main()
    .then(() => {
        console.log('done!')
    })
    .catch((error) => {
        console.error('error', error)
    })
