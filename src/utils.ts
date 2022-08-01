export const REQUEST_BODY_PENDING_MARKER = "_1";
export const REQUEST_HAS_NO_BODY_MARKER = "_2";
export const REQUEST_BODY_ENDED_MARKER = "_3";

export interface ProtocolRequest {
    method: string
    path: string
    httpProtocol: string
    headers: { [key: string]: string }
    endMarker: string
}

export function parseProtocolRequest(content: string): ProtocolRequest {

    const lines = content.split('\n');
    const [method, path, httpProtocol] = lines[0].split(' ');

    const headerLines = lines.slice(1, lines.length - 1)
    const headers = headerLines.reduce((acc: any, current: string) => {

        const separatorIndex = current.indexOf(':')
        if (separatorIndex == -1) {
            return acc
        }

        const key = current.slice(0, separatorIndex)
        const value = current.slice(separatorIndex + 1, current.length)

        if (acc[key]) {
            acc[key] = acc[key] + ';' + value
        } else {
            acc[key] = value
        }

        return acc
    }, {})

    const endMarker = lines[lines.length - 1] // last line

    return {
        method,
        path,
        httpProtocol,
        headers,
        endMarker
    }
}

export function buildProtocolResponse(httpProtocol: string, status: number, reason: string, headers: any): string {
    const headersArray = []
    for (const key of Object.keys(headers)) {
        const value = headers[key];
        if (Array.isArray(value)) {
            for (const item of value) headersArray.push(`${key}:${item}`)
        } else {
            headersArray.push(`${key}:${value}`)
        }
    }

    const headerLines = headersArray.join('\n')

    return `${httpProtocol} ${status} ${reason}\n${headerLines}`
}

export async function sleep(timeInMillis) {
    return new Promise<any>(resolve => {
        setTimeout(() => {
            resolve(null);
        }, timeInMillis)
    })
}

export function retryWaitInMillis(retryCount: number): number {
    if (retryCount === 0) return 0
    if (retryCount > 14) return 10000
    const wait = 500 + Math.pow(2, retryCount)
    return (wait > 10000) ? 10000 : wait
}
