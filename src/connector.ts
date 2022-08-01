import WebSocket from "ws";
import { buildProtocolResponse, generateUUID, parseProtocolRequest, retryWaitInMillis, sleep } from "./utils";
import http, { ClientRequest, IncomingMessage, RequestOptions } from "http";
import https from 'https'
import events from 'events'

function httpClient(uri: string) {
    return uri.startsWith('https') ? https : http;
}

const log = {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    debug: (...args) => { }, // disabled.
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
    httpsAgent?: https.Agent
}

type State = 'STARTING' | 'STARTED' | 'STOPPING' | 'STOPPED';

/**
 * It is also an EventEmitter, it will publish ['open', 'consumed' 'error'] events
 */
class ConnectorSocket extends events.EventEmitter {

    private connectorInstanceID: string;
    readonly registrationUri: string;
    readonly targetServerName: string;
    readonly targetUri: string;
    readonly httpsAgent: https.Agent;

    private timeoutHandle: NodeJS.Timeout;
    private intervalPingHandle: NodeJS.Timeout;

    isConsumed: boolean;
    websocket: WebSocket;

    constructor(connectorInstanceID: string,
        registrationUri: string,
        targetServerName: string,
        targetUri: string,
        httpsAgent?: https.Agent) {
        super();
        this.connectorInstanceID = connectorInstanceID;
        this.registrationUri = registrationUri;
        this.targetServerName = targetServerName;
        this.targetUri = targetUri;
        this.isConsumed = false;
        this.httpsAgent = httpsAgent;
    }

    heartbeat() {
        if (this.timeoutHandle) clearTimeout(this.timeoutHandle)
        this.timeoutHandle = setTimeout(() => {
            log.warn('no pong heart beat from server, clean up it.')
            this.cleanUp(STATUS_GO_AWAY, 'timeout')
        }, IDLE_TIMEOUT_IN_MILLIS)
    }

    cleanUp(code: number, reason: string) {
        if (!this.isConsumed) {
            this.emit('error')
        }
        if (this.timeoutHandle) clearTimeout(this.timeoutHandle)
        if (this.intervalPingHandle) clearInterval(this.intervalPingHandle)
        if (this.websocket.readyState === WebSocket.OPEN ||
            this.websocket.readyState === WebSocket.CONNECTING) {
            // TODO: force closing
            this.websocket.close(code, reason)
        }
    }

    stop() {
        this.cleanUp(STATUS_GO_AWAY, 'server stop');
    }

    start() {

        let targetClientRequest: ClientRequest = null
        let isRequestBodyPending = false

        const registerUrl = `${this.registrationUri}/register?connectorInstanceID=${encodeURIComponent(this.connectorInstanceID)}&componentName=${this.targetServerName}`

        log.debug(`connecting to ${registerUrl}`);

        this.websocket = new WebSocket(registerUrl, {
            timeout: 2000,
            headers: {
                'CrankerProtocol': '1.0',
                'Route': this.targetServerName
            },
            agent: this.httpsAgent
        })

        this.heartbeat()

        this.websocket.on('open', () => {
            log.debug('on open')
            this.emit('open');
            this.heartbeat()
            this.intervalPingHandle = setInterval(() => this.websocket.ping("ping"), PING_INTERVAL_IN_MILLIS)
        });

        this.websocket.on('message', data => {

            log.debug('-->', data)

            this.isConsumed = true;
            this.emit('consumed');

            if (!targetClientRequest) {
                const url = new URL(this.targetUri);
                const { method, path, headers, endMarker } = parseProtocolRequest(data as string);
                const options: RequestOptions = {
                    host: url.hostname,
                    path: path,
                    port: url.port,
                    method,
                    headers
                };

                log.debug(`start new http request with option: ${JSON.stringify(options)}`)

                isRequestBodyPending = endMarker === '_1' // REQUEST_BODY_PENDING_MARKER

                const callback = (response: IncomingMessage) => {
                    const { statusCode, statusMessage, headers } = response
                    const responseLineString = buildProtocolResponse('HTTP/1.1', statusCode, statusMessage, headers);

                    this.websocket.send(responseLineString)

                    response.on('data', (chunk) => {
                        // TODO separate the chunk by max size
                        log.debug('targetClientRequest data : ', chunk)
                        this.websocket.send(chunk)
                    })

                    response.on('close', () => {
                        this.cleanUp(STATUS_GO_AWAY, 'target server close.')
                        log.debug('targetClientRequest close')
                    })
                    response.on('end', () => {
                        this.cleanUp(STATUS_NORMAL_CLOSE, 'target server end.')
                        log.debug('targetClientRequest end')
                    })
                    response.on('error', () => {
                        this.cleanUp(STATUS_SERVER_UNEXPECTED_CONDITION, 'target server error.')
                        log.debug('targetClientRequest error')
                    })
                }

                targetClientRequest = httpClient(this.targetUri).request(options, callback);
                log.debug('targetClientRequest created')

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
            this.cleanUp(STATUS_SERVER_UNEXPECTED_CONDITION, "cranker protocol error")

        })

        this.websocket.on('pong', () => this.heartbeat());

        this.websocket.on('close', (number, reason) => {
            log.debug(`wsClient close, code=${number}, reason=${reason}`)
            this.cleanUp(STATUS_GO_AWAY, 'ws client close')
        });

        this.websocket.on('error', (error) => {
            log.debug(`wsClient error, error=${error.message}`)
            this.cleanUp(STATUS_GO_AWAY, 'ws client error')
        });
    }
}

/**
 * RouterRegistration is a holder of a set of idle ConnectorSocket, it's responsible for
 * maintaining ConnectorSocket at the size of slidingWindow
 */
class RouterRegistration {

    private connectorInstanceID: string;
    public registrationUri: string;
    readonly targetServerName: string;
    readonly targetUri: string;
    readonly slidingWindow: number;
    readonly httpsAgent: https.Agent;

    readonly idleSockets: ConnectorSocket[];
    errorAttempt: number;
    state: State;

    constructor(connectorInstanceID: string,
        registrationUri: string,
        targetServerName: string,
        targetUri: string,
        slidingWindow: number,
        httpsAgent?: https.Agent) {
        this.connectorInstanceID = connectorInstanceID;
        this.registrationUri = registrationUri;
        this.targetServerName = targetServerName;
        this.targetUri = targetUri;
        this.slidingWindow = slidingWindow;
        this.httpsAgent = httpsAgent;
        this.idleSockets = [];
        this.errorAttempt = 0;
        this.state = 'STARTING';
    }

    removeFromIdleSocket(socket: ConnectorSocket) {
        const index = this.idleSockets.indexOf(socket);
        if (index >= 0) {
            this.idleSockets.splice(index, 1);
        }
    }

    addAnythingMissing() {
        if (this.state != 'STARTING' && this.state != 'STARTED') return;
        while (this.idleSockets.length < this.slidingWindow) {
            let connectorSocket = new ConnectorSocket(this.connectorInstanceID, this.registrationUri, this.targetServerName, this.targetUri, this.httpsAgent);
            this.idleSockets.push(connectorSocket);
            connectorSocket
                .on('open', () => this.errorAttempt = 0)
                .on('consumed', () => {
                    this.removeFromIdleSocket(connectorSocket);
                    this.addAnythingMissing();
                })
                .on('error', async () => {
                    this.errorAttempt++;
                    this.removeFromIdleSocket(connectorSocket);
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
        // TODO: should send unregister to cranker and let cranker aware connector are existing.
        for (const idleSocket of this.idleSockets) {
            idleSocket.stop()
        }
        this.state = 'STOPPED';
    }

}

export class CrankerConnector {

    private readonly connectorInstanceID = generateUUID();
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
            const routerRegistration = new RouterRegistration(this.connectorInstanceID, toAdd, this.config.targetServiceName, this.config.targetURI, this.config.slidingWindow, this.config.httpsAgent);
            this.registrations.push(routerRegistration);
            routerRegistration.start();
            log.info(`cranker registration started: registrationUri=${routerRegistration.registrationUri}`)
        }

        for (const toRemove of toRemoves) {

            this.registrations
                .filter(item => item.registrationUri === toRemove)
                .forEach(item => {
                    item.stop()
                    log.info(`cranker registration stopped: registrationUri=${item.registrationUri}`)
                })

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
        return this.registrations.map(item => ({
            state: item.state,
            registrationUri: item.registrationUri,
            targetServerName: item.targetServerName,
            targetUri: item.targetUri,
            slidingWindow: item.slidingWindow,
            idleSockets: item.idleSockets.map(item => ({
                isConsumed: item.isConsumed,
                websocketReadyState: item.websocket.readyState
            }))
        }))
    }
}

export async function connectToRouter(config: ConnectorConfig): Promise<CrankerConnector> {
    const crankerConnector = new CrankerConnector(config);
    crankerConnector.start();
    return crankerConnector;
}
