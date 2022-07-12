import express from "express";
import http, { Server } from "http";
import axios, { AxiosInstance } from 'axios'
import bodyParser from "body-parser";
import { listen, close } from "./run-local";


async function createServerAndClient(app, targetServerPort, crankerServerPort)
    : Promise<{ server: Server, client: AxiosInstance }> {
    const server = http.createServer(app)
    await listen(server, targetServerPort)

    const client = axios.create({
        baseURL: `http://localhost:${crankerServerPort}`,
        timeout: 3000
    })

    return {
        server,
        client
    }
}

describe('connector basic', function () {

    const targetServerPort = 8084
    const crankerServerPort = 8084

    it('should can handle header', async function () {
        let serverReceivedHeader1 = ''
        let serverReceivedHeader2 = ''

        const app = express()

        app.get('/my-service/api/test', (req, res) => {
            serverReceivedHeader1 = req.header("x-client-header-1")
            serverReceivedHeader2 = req.header("x-client-header-2")

            res.header("x-server-header-1", "server-1")
            res.header("x-server-header-2", "server-2")
            res.send('hello world')
        })

        const {server, client} = await createServerAndClient(app, targetServerPort, crankerServerPort)

        const response = await client.get('/my-service/api/test', {
            headers: {
                "x-client-header-1": "client-1",
                "x-client-header-2": "client-2"
            }
        })
        expect(response.status).toEqual(200)
        expect(response.data).toEqual('hello world')

        expect(response.headers['x-server-header-1']).toEqual("server-1")
        expect(response.headers['x-server-header-2']).toEqual("server-2")

        expect(serverReceivedHeader1).toEqual('client-1')
        expect(serverReceivedHeader2).toEqual('client-2')

        await close(server)
    });

    it('should can handle get', async () => {
        const app = express()
        app.get('/my-service/api/test', (req, res) => {
            res.send('hello world')
        })

        const {server, client} = await createServerAndClient(app, targetServerPort, crankerServerPort)

        const response = await client.get('/my-service/api/test')
        expect(response.status).toEqual(200)
        expect(response.data).toEqual('hello world')

        await close(server)
    });

    it('should can handle post', async () => {
        let actualPostBody = '';

        const app = express()
        app.use(bodyParser.json())
        app.post('/my-service/api/test', (req, res) => {
            actualPostBody = req.body
            res.send('hello world')
        })

        const {server, client} = await createServerAndClient(app, targetServerPort, crankerServerPort)

        const postData = {
            name: "Michael"
        };
        const response = await client.post('/my-service/api/test', postData)

        expect(response.status).toEqual(200)
        expect(response.data).toEqual('hello world')
        expect(JSON.stringify(actualPostBody)).toEqual(JSON.stringify(postData))

        await close(server)
    });
});
