import WebSocket, { createWebSocketStream } from "ws";
import { buildProtocolResponse, parseProtocolRequest, retryWaitInMillis, sleep } from "./utils";
import http, { ClientRequest, IncomingMessage, RequestOptions } from "http";

const log = console

const STATUS_NORMAL_CLOSE = 1000
const STATUS_GO_AWAY = 1001
const STATUS_PROTOCOL_ERROR = 1002
const STATUS_SERVER_UNEXPECTED_CONDITION = 1011

const MAX_MESSAGE_SIZE_IN_BYTES = 32768

const PING_INTERVAL_IN_MILLIS = 5000
const IDLE_TIMEOUT_IN_MILLIS = 20000

export interface ConnectorConfig {
    targetURI: string
    targetServiceName: string
    routerURIProvider: () => string[]
    windowSize: number
}

export interface SimpleStatistic {
    idle: number,
    connecting: number,
    connected: number
}

type State = 'STARTING' | 'STARTED' | 'STOPPING' | 'STOPPED';

export interface Connector {
    state: State,
    stop: Promise<boolean> // isSuccess
    connections: { [key: string]: WebsocketConnection }
}

function startWebsocket(
    registrationUri: string,
    targetServerName: string,
    targetUri: string,
    onCreated: (websocket: WebSocket) => void,
    onConsumed: (websocket: WebSocket) => void
): WebSocket {

    let timeoutHandle = null
    let intervalPingHandle = null
    let targetClientRequest: ClientRequest = null
    let isRequestBodyPending = false

    const registerUrl = `${registrationUri}/register`


    const websocket = new WebSocket(registerUrl, {
        timeout: 5000,
        headers: {
            'CrankerProtocol': '1.0',
            'Route': targetServerName
        }
    })

    onCreated(websocket);

    const cleanUp = (code: number, reason: string) => {
        onConsumed(websocket);
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (intervalPingHandle) clearInterval(intervalPingHandle)
        if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
            // TODO: force closing
            websocket.close(code, reason)
        }
    }

    const heartbeat = () => {
        log.info("heartbeat")
        if (timeoutHandle) clearTimeout(timeoutHandle)
        timeoutHandle = setTimeout(() => {
            log.warn('no pong heart beat from server, clean up it.')
            cleanUp(STATUS_GO_AWAY, 'timeout')
        }, IDLE_TIMEOUT_IN_MILLIS)
    };

    heartbeat()

    websocket.on('open', () => {
        log.info('on open')
        heartbeat()
        intervalPingHandle = setInterval(() => websocket.ping("ping"), PING_INTERVAL_IN_MILLIS)
    });

    websocket.on('message', data => {

        log.info('-->', data)

        onConsumed(websocket);

        if (!targetClientRequest) {
            const url = new URL(targetUri);
            const { method, path, headers, endMarker } = parseProtocolRequest(data as string);
            const options: RequestOptions = {
                host: url.hostname,
                path: path,
                port: url.port,
                method,
                headers
            };

            isRequestBodyPending = endMarker === '_1' // REQUEST_BODY_PENDING_MARKER

            const callback = (response: IncomingMessage) => {
                const { statusCode, statusMessage, headers } = response
                const responseLineString = buildProtocolResponse('HTTP/1.1', statusCode, statusMessage, headers);

                websocket.send(responseLineString)

                response.on('data', (chunk) => {
                    // TODO separate the chunk by max size
                    websocket.send(chunk)
                })

                response.on('close', () => {
                    cleanUp(STATUS_GO_AWAY, 'target server close.')
                    log.info('targetClientRequest onClose')
                })
                response.on('end', () => {
                    cleanUp(STATUS_NORMAL_CLOSE, 'target server end.')
                })
                response.on('error', () => {
                    cleanUp(STATUS_SERVER_UNEXPECTED_CONDITION, 'target server error.')
                })
            }

            targetClientRequest = http.request(options, callback);
            log.info('targetClientRequest created')

            if (endMarker === '_2') {
                // REQUEST_HAS_NO_BODY_MARKER
                isRequestBodyPending = false
                targetClientRequest.end()
            }

            return
        }

        if (data === '_3') {
            // REQUEST_BODY_ENDED_MARKER
            isRequestBodyPending = false
            targetClientRequest.end()
            return
        }

        if (isRequestBodyPending) {
            targetClientRequest.write(data)
            return
        }

        // it shouldn't reach here..
        cleanUp(STATUS_SERVER_UNEXPECTED_CONDITION, "cranker protocol error")

    })

    websocket.on('pong', () => {
        log.info('on pong')
        heartbeat()
    });

    websocket.on('close', (number, reason) => {
        log.info(`wsClient close, code=${number}, reason=${reason}`)
        cleanUp(STATUS_GO_AWAY, 'ws client close')
    });

    websocket.on('error', (error) => {
        log.info(`wsClient error, error=${error.message}`)
        cleanUp(STATUS_GO_AWAY, 'ws client error')
    });

    return websocket;
}

export async function connectToRouter(config: ConnectorConfig): Connector {
    var state: State = 'STARTING';
    const routerURI = config.routerURIProvider();

    log.info(`connecting to cranker with config: \r\n${JSON.stringify(config, null, 4)}`)


    // const retryWaitTime = retryWaitInMillis(retryCount);
    // if (retryWaitTime > 0) await sleep(retryWaitTime)
    // log.info(`connecting to ${url}, waitTime=${retryWaitTime}ms`)

    const addAnythingMissing = (uri: string, uriToIdleConnectionsMap: { [key: string]: WebSocket[] }) => {
        if (state != 'STARTING' && state != 'STARTED') return;
        if (!uriToIdleConnectionsMap[uri]) uriToIdleConnectionsMap[uri] = [];
        if (uriToIdleConnectionsMap[uri].length < config.windowSize) {
            //TODO:  add debounce time
            startWebsocket(uri, config.targetServiceName, config.targetURI,
                // onCreated
                websocket => uriToIdleConnectionsMap[uri].push(websocket),
                // onConsumed
                websocket => {
                    uriToIdleConnectionsMap[uri] = uriToIdleConnectionsMap[uri].filter(item => item != websocket);
                    addAnythingMissing(uri, uriToIdleConnectionsMap);
                }
            );
        }
    }

    const currentUris = [];
    const uriToIdleConnectionsMap: { [key: string]: WebSocket[] } = {};
    const refresh = () => {
        const latestUris = config.routerURIProvider();
        const toAdds = latestUris.filter(item => !currentUris.includes(item))
        const toRemoves = currentUris.filter(item => !latestUris.includes(item))

        for (const toAdd of toAdds) {
            addAnythingMissing(toAdd, uriToIdleConnectionsMap)
        }
    }


    const context: Connector = {
        state,
        stop: new Promise((resolve, reject) => {

        })
    }
    const url = routerURI[0]

    const onConsumed = (url) => {

    }



    return context;
}
