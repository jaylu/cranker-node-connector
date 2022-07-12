import { buildProtocolResponse, parseProtocolRequest, retryWaitInMillis, sleep } from "./utils";

describe('utils', function () {
    it('can parse protocol request - no body', () => {

        const content = [
            'GET /my-service/hello HTTP/1.1',
            'Cookie:Webstorm-e833ee57=4ed41282-af3f-4a98-98ba-731d4ac48a18; Webstorm-e833f216=4ed41282-af3f-4a98-98ba-731d4ac48a18; Idea-27e65ad1=ad6ebc27-a512-43e4-b80e-488519db66f5',
            'Cookie:duplicateKey=238s823',
            'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
            'User-Agent:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
            'Sec-Fetch-Site:none',
            'Sec-Fetch-Dest:document',
            'Host:localhost:9443',
            'Accept-Encoding:gzip, deflate, br',
            'Sec-Fetch-Mode:navigate',
            'sec-ch-ua:" Not;A Brand";v="99", "Google Chrome";v="91", "Chromium";v="91"',
            'sec-ch-ua-mobile:?0',
            'Cache-Control:max-age=0',
            'Upgrade-Insecure-Requests:1',
            'Sec-Fetch-User:?1',
            'Accept-Language:zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-TW;q=0.6',
            'Forwarded:for=0:0:0:0:0:0:0:1;proto=https;host=localhost:9443;by=0:0:0:0:0:0:0:1',
            'X-Forwarded-For:0:0:0:0:0:0:0:1',
            'X-Forwarded-Proto:https',
            'X-Forwarded-Host:localhost:9443',
            'X-Forwarded-Server:0:0:0:0:0:0:0:1',
            '',
            '_2',
        ].join("\n")

        const protocolRequest = parseProtocolRequest(content);

        expect(protocolRequest.method).toEqual('GET')
        expect(protocolRequest.path).toEqual('/my-service/hello')
        expect(protocolRequest.httpProtocol).toEqual('HTTP/1.1')
        expect(protocolRequest.endMarker).toEqual('_2')

        expect(protocolRequest.headers).toMatchObject({
            "Cookie": "Webstorm-e833ee57=4ed41282-af3f-4a98-98ba-731d4ac48a18; Webstorm-e833f216=4ed41282-af3f-4a98-98ba-731d4ac48a18; Idea-27e65ad1=ad6ebc27-a512-43e4-b80e-488519db66f5;duplicateKey=238s823",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-Dest": "document",
            "Host": "localhost:9443",
            "Accept-Encoding": "gzip, deflate, br",
            "Sec-Fetch-Mode": "navigate",
            "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"91\", \"Chromium\";v=\"91\"",
            "sec-ch-ua-mobile": "?0",
            "Cache-Control": "max-age=0",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-User": "?1",
            "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-TW;q=0.6",
            "Forwarded": "for=0:0:0:0:0:0:0:1;proto=https;host=localhost:9443;by=0:0:0:0:0:0:0:1",
            "X-Forwarded-For": "0:0:0:0:0:0:0:1",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "localhost:9443",
            "X-Forwarded-Server": "0:0:0:0:0:0:0:1"
        })

    });

    it('should can build protocol response', function () {
        const headers = {
            "Cookie": "Webstorm-e833ee57=4ed41282-af3f-4a98-98ba-731d4ac48a18; Webstorm-e833f216=4ed41282-af3f-4a98-98ba-731d4ac48a18; Idea-27e65ad1=ad6ebc27-a512-43e4-b80e-488519db66f5;duplicateKey=238s823",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-Dest": "document",
            "Host": "localhost:9443",
            "Accept-Encoding": "gzip, deflate, br",
            "Sec-Fetch-Mode": "navigate",
            "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"91\", \"Chromium\";v=\"91\"",
            "sec-ch-ua-mobile": "?0",
            "Cache-Control": "max-age=0",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-User": "?1",
            "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-TW;q=0.6",
            "Forwarded": "for=0:0:0:0:0:0:0:1;proto=https;host=localhost:9443;by=0:0:0:0:0:0:0:1",
            "X-Forwarded-For": "0:0:0:0:0:0:0:1",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "localhost:9443",
            "X-Forwarded-Server": "0:0:0:0:0:0:0:1"
        }

        const protocolRequest = buildProtocolResponse("HTTP/1.1", 200, "OK", headers);
        expect(protocolRequest).toEqual([
            'HTTP/1.1 200 OK',
            'Cookie:Webstorm-e833ee57=4ed41282-af3f-4a98-98ba-731d4ac48a18; Webstorm-e833f216=4ed41282-af3f-4a98-98ba-731d4ac48a18; Idea-27e65ad1=ad6ebc27-a512-43e4-b80e-488519db66f5;duplicateKey=238s823',
            'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
            'User-Agent:Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
            'Sec-Fetch-Site:none',
            'Sec-Fetch-Dest:document',
            'Host:localhost:9443',
            'Accept-Encoding:gzip, deflate, br',
            'Sec-Fetch-Mode:navigate',
            'sec-ch-ua:" Not;A Brand";v="99", "Google Chrome";v="91", "Chromium";v="91"',
            'sec-ch-ua-mobile:?0',
            'Cache-Control:max-age=0',
            'Upgrade-Insecure-Requests:1',
            'Sec-Fetch-User:?1',
            'Accept-Language:zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-TW;q=0.6',
            'Forwarded:for=0:0:0:0:0:0:0:1;proto=https;host=localhost:9443;by=0:0:0:0:0:0:0:1',
            'X-Forwarded-For:0:0:0:0:0:0:0:1',
            'X-Forwarded-Proto:https',
            'X-Forwarded-Host:localhost:9443',
            'X-Forwarded-Server:0:0:0:0:0:0:0:1'
        ].join('\n'))
    });

    it('should can sleep()', async function () {
        const before = new Date().getTime()
        await sleep(300)
        const after = new Date().getTime()
        const elapse = after - before;
        expect(elapse).toBeGreaterThan(280)
        expect(elapse).toBeLessThan(320)
    });

    it('should can retryWaitInMillis()', function () {
        expect(retryWaitInMillis(0)).toEqual(0)
        expect(retryWaitInMillis(1)).toEqual(502)
        expect(retryWaitInMillis(2)).toEqual(504)
        expect(retryWaitInMillis(10)).toEqual(1524)
        expect(retryWaitInMillis(11)).toEqual(2548)
        expect(retryWaitInMillis(13)).toEqual(8692)
        expect(retryWaitInMillis(14)).toEqual(10000)
    });
});


