import WebSocket from "ws";
import { buildProtocolResponse, parseProtocolRequest, retryWaitInMillis, sleep } from "./utils";
import http, { ClientRequest, IncomingMessage, RequestOptions } from "http";
import https from 'https'
import events from 'events'

function httpClient(uri:string) {
    return uri.startsWith('https') ? https : http;
}

const log = {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    debug: (...args) => console.debug(...args),
    error: (...args) => console.error(...args)
}

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
    slidingWindow: number
}

type State = 'STARTING' | 'STARTED' | 'STOPPING' | 'STOPPED';

/**
 * It is also an EventEmitter, it will publish ['open', 'consumed' 'error'] events
 */
class ConnectorSocket extends events.EventEmitter {

    private readonly registrationUri: string;
    private readonly targetServerName: string;
    private readonly targetUri: string;

    isConsumed: boolean;
    websocket: WebSocket;

    constructor(registrationUri: string,
                targetServerName: string,
                targetUri: string) {
        super();
        this.registrationUri = registrationUri;
        this.targetServerName = targetServerName;
        this.targetUri = targetUri;
        this.isConsumed = false;
    }

    stop() {

    }

    start() {
        let timeoutHandle = null
        let intervalPingHandle = null
        let targetClientRequest: ClientRequest = null
        let isRequestBodyPending = false

        const registerUrl = `${this.registrationUri}/register`

        log.info(`connecting to ${registerUrl}`);

        const websocket = new WebSocket(registerUrl, {
            timeout: 5000,
            headers: {
                'CrankerProtocol': '1.0',
                'Route': this.targetServerName
            }
        })

        const cleanUp = (code: number, reason: string) => {
            if (!this.isConsumed) {
                this.emit('error')
            }
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
            this.emit('open');
            heartbeat()
            intervalPingHandle = setInterval(() => websocket.ping("ping"), PING_INTERVAL_IN_MILLIS)
        });

        websocket.on('message', data => {

            log.info('-->', data)

            this.isConsumed = true;
            this.emit('consumed');

            if (!targetClientRequest) {
                const url = new URL(this.targetUri);
                const {method, path, headers, endMarker} = parseProtocolRequest(data as string);
                const options: RequestOptions = {
                    host: url.hostname,
                    path: path,
                    port: url.port,
                    method,
                    headers
                };

                log.info(`start new http request with option: ${JSON.stringify(options)}`)

                isRequestBodyPending = endMarker === '_1' // REQUEST_BODY_PENDING_MARKER

                const callback = (response: IncomingMessage) => {
                    const {statusCode, statusMessage, headers} = response
                    const responseLineString = buildProtocolResponse('HTTP/1.1', statusCode, statusMessage, headers);

                    websocket.send(responseLineString)

                    response.on('data', (chunk) => {
                        // TODO separate the chunk by max size
                        log.info('targetClientRequest data : ', chunk)
                        websocket.send(chunk)
                    })

                    response.on('close', () => {
                        cleanUp(STATUS_GO_AWAY, 'target server close.')
                        log.info('targetClientRequest close')
                    })
                    response.on('end', () => {
                        cleanUp(STATUS_NORMAL_CLOSE, 'target server end.')
                        log.info('targetClientRequest end')
                    })
                    response.on('error', () => {
                        cleanUp(STATUS_SERVER_UNEXPECTED_CONDITION, 'target server error.')
                        log.info('targetClientRequest error')
                    })
                }

                targetClientRequest = httpClient(this.targetUri).request(options, callback);
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

        this.websocket = websocket;
    }
}

/**
 * RouterRegistration is a holder of a set of idle ConnectorSocket, it's responsible for
 * maintaining ConnectorSocket at the size of slidingWindow
 */
class RouterRegistration {

    public registrationUri: string;
    private readonly targetServerName: string;
    private readonly targetUri: string;
    private readonly slidingWindow: number;

    idleSockets: ConnectorSocket[];
    errorAttempt: number;
    state: State;

    constructor(registrationUri: string,
                targetServerName: string,
                targetUri: string,
                slidingWindow: number) {
        this.registrationUri = registrationUri;
        this.targetServerName = targetServerName;
        this.targetUri = targetUri;
        this.slidingWindow = slidingWindow;
        this.idleSockets = [];
        this.errorAttempt = 0;
        this.state = 'STARTING';
    }

    addAnythingMissing() {
        if (this.state != 'STARTING' && this.state != 'STARTED') return;
        if (this.idleSockets.length < this.slidingWindow) {
            let connectorSocket = new ConnectorSocket(this.registrationUri, this.targetServerName, this.targetUri);
            this.idleSockets.push(connectorSocket);
            connectorSocket
                .on('open', () => this.errorAttempt = 0)
                .on('consumed', () => this.addAnythingMissing())
                .on('error', async () => {
                    await sleep(retryWaitInMillis(this.errorAttempt));
                    this.addAnythingMissing();
                }).start();
        }
    }

    start() {
        this.addAnythingMissing();
        this.state = 'STARTED';
    }

    stop() {
        this.state = 'STOPPING';
        for (const idleSocket of this.idleSockets) {
            idleSocket.stop()
        }
        this.state = 'STOPPED';
    }

}

export class CrankerConnector {

    private config: ConnectorConfig;
    private scheduler: NodeJS.Timeout;

    public registrations: RouterRegistration[];
    public state: State;

    constructor(config: ConnectorConfig) {
        this.config = config;
        this.registrations = [];
    }

    updateRouters() {
        const latestUris = this.config.routerURIProvider();
        const currentUris = this.registrations.map(item => item.registrationUri);

        const toAdds = latestUris.filter(item => !currentUris.includes(item))
        const toRemoves = currentUris.filter(item => !latestUris.includes(item))

        for (const toAdd of toAdds) {
            const routerRegistration = new RouterRegistration(toAdd, this.config.targetServiceName, this.config.targetURI, this.config.slidingWindow);
            this.registrations.push(routerRegistration);
            routerRegistration.start();
        }

        for (const toRemove of toRemoves) {

            this.registrations
                .filter(item => item.registrationUri === toRemove)
                .forEach(item => item.stop())

            this.registrations = this.registrations.filter(item => item.registrationUri !== toRemove)
        }
    }

    start() {
        this.updateRouters();
        this.scheduler = setInterval(() => this.updateRouters(), 60 * 1000);
    }

    stop() {
        if (this.scheduler) clearInterval(this.scheduler);
        this.registrations.forEach(item => item.stop());
    }

    status(): any {
        this.registrations.map(item => ({
            state: item.state,
            registrationUri: item.registrationUri,
            idleSockets: item.idleSockets
        }))
    }
}

export async function connectToRouter(config: ConnectorConfig): Promise<CrankerConnector> {
    const crankerConnector = new CrankerConnector(config);
    crankerConnector.start();
    return crankerConnector;
}
