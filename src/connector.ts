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

export interface WebsocketConnection {
    state: () => 'CONNECTING' | 'OPEN' | 'CLOSING' | 'CLOSED',
    deregister: () => void
}

export interface Connector {
    state: 'STARTING' | 'STARTED' | 'STOPPING' | 'STOPPED',
    stop: Promise<boolean> // isSuccess
    connections: { [key: string]: WebsocketConnection }
}

function startWebsocket(
    registrationUri: string,
    targetServerName: string,
    targetUri: string,
    onConsumed: (shouldStartNew: boolean) => {},
    onClosed: (shouldStartNew: boolean, message: string) => {},
    onOpen: () => {}): WebsocketConnection {

    let timeoutHandle = null
    let intervalPingHandle = null
    let targetClientRequest: ClientRequest = null
    let isRequestBodyPending = false
    let shouldStartNew = true // default should create successor

    const registerUrl = `${registrationUri}/register`

    const getShouldStartNew = () => {
        const oldState = shouldStartNew;
        if (shouldStartNew) {
            shouldStartNew = false;
        }
        return oldState;
    }

    const wsClient = new WebSocket(registerUrl, {
        timeout: 5000,
        headers: {
            'CrankerProtocol': '1.0',
            'Route': targetServerName
        }
    })

    const cleanUp = (code: number, reason: string) => {
        onClosed(getShouldStartNew(), reason);
        if (timeoutHandle) clearTimeout(timeoutHandle)
        if (intervalPingHandle) clearInterval(intervalPingHandle)
        if (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING) {
            // TODO: force closing
            wsClient.close(code, reason)
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

    wsClient.on('open', () => {
        log.info('on open')
        onOpen();
        heartbeat()
        intervalPingHandle = setInterval(() => wsClient.ping("ping"), PING_INTERVAL_IN_MILLIS)
    });

    wsClient.on('message', data => {

        log.info('-->', data)

        onConsumed(getShouldStartNew());

        if (!targetClientRequest) {
            const url = new URL(targetUri);
            const {method, path, headers, endMarker} = parseProtocolRequest(data as string);
            const options: RequestOptions = {
                host: url.hostname,
                path: path,
                port: url.port,
                method,
                headers
            };

            isRequestBodyPending = endMarker === '_1' // REQUEST_BODY_PENDING_MARKER

            const callback = (response: IncomingMessage) => {
                const {statusCode, statusMessage, headers} = response
                const responseLineString = buildProtocolResponse('HTTP/1.1', statusCode, statusMessage, headers);

                wsClient.send(responseLineString)

                response.on('data', (chunk) => {
                    // TODO separate the chunk by max size
                    wsClient.send(chunk)
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

    wsClient.on('pong', () => {
        log.info('on pong')
        heartbeat()
    });

    wsClient.on('close', (number, reason) => {
        log.info(`wsClient close, code=${number}, reason=${reason}`)
        cleanUp(STATUS_GO_AWAY, 'ws client close')
    });

    wsClient.on('error', (error) => {
        log.info(`wsClient error, error=${error.message}`)
        cleanUp(STATUS_GO_AWAY, 'ws client error')
    });

    return {
        deregister: () => {
            // TODO deregister
        },
        state: () => {
            if (wsClient?.readyState) {
                switch (wsClient.readyState as number) {
                    case WebSocket.CONNECTING:
                        return 'CONNECTING';
                    case WebSocket.OPEN:
                        return 'OPEN';
                    case WebSocket.CLOSING:
                        return 'CLOSING';
                    case WebSocket.CLOSED:
                        return 'CLOSED';
                    default:
                        return 'CLOSED'
                }
            } else {
                return 'CLOSED'
            }
        },
    }
}

export async function connectToRouter(config: ConnectorConfig): Connector {
    const routerURI = config.routerURIProvider();

    log.info(`connecting to cranker with config: \r\n${JSON.stringify(config, null, 4)}`)


    // const retryWaitTime = retryWaitInMillis(retryCount);
    // if (retryWaitTime > 0) await sleep(retryWaitTime)
    // log.info(`connecting to ${url}, waitTime=${retryWaitTime}ms`)


    const currentUris = [];
    const uriToConnectionsMap: { [key: string]: WebsocketConnection[] } = {};
    const refresh = () => {
        const latestUris = config.routerURIProvider();
        const toAdds = latestUris.filter(item => !currentUris.includes(item))
        const toRemoves = currentUris.filter(item => !latestUris.includes(item))

        for (const toAdd of toAdds) {
            startWebsocket(toAdd, config.targetServiceName, config.targetURI, );
        }
    }


    const context: Connector = {
        state: 'STARTING',
        stop: new Promise((resolve, reject) => {

        })
    }
    const url = routerURI[0]

    const onConsumed = (url) => {

    }



    return context;
}
