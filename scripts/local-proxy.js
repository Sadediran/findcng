// Local test-only CONNECT relay for headless Chromium in this VM.
// Chromium cannot do proxy auth from --proxy-server, and the VM egress
// proxy requires it. This relay listens on 127.0.0.1, accepts CONNECT
// from the local browser only, and forwards it to the egress proxy with
// the Proxy-Authorization header derived from HTTPS_PROXY at runtime
// (the same pattern as ~/.ssh/proxy-connect.sh). Credentials stay
// in-process and are never printed or written anywhere.
// Usage: node local-proxy.js [port]   (default 18080)
const net = require("net");
const { URL } = require("url");

const PORT = Number(process.argv[2] || 18080);
const upstream = new URL(process.env.HTTPS_PROXY || process.env.https_proxy || "");
if (!upstream.hostname) { console.error("no HTTPS_PROXY set"); process.exit(1); }
const auth = upstream.username
  ? "Basic " + Buffer.from(decodeURIComponent(upstream.username) + ":" + decodeURIComponent(upstream.password || "")).toString("base64")
  : null;
const UP_HOST = upstream.hostname, UP_PORT = Number(upstream.port || 3128);

const server = net.createServer((client) => {
  let buf = Buffer.alloc(0);
  let target = null;
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) return;
    const head = buf.subarray(0, end).toString("ascii");
    const first = head.split("\r\n")[0] || "";
    const m = first.match(/^CONNECT\s+(\S+)\s+HTTP\//i);
    client.removeListener("data", onData);
    if (!m) { client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n"); return; }
    target = m[1];
    const rest = buf.subarray(end + 4);
    const up = net.connect(UP_PORT, UP_HOST, () => {
      let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
      if (auth) req += `Proxy-Authorization: ${auth}\r\n`;
      req += "\r\n";
      up.write(req);
    });
    let upBuf = Buffer.alloc(0);
    let established = false;
    up.on("data", (c) => {
      if (established) { client.write(c); return; }
      upBuf = Buffer.concat([upBuf, c]);
      const e = upBuf.indexOf("\r\n\r\n");
      if (e === -1) return;
      const status = upBuf.subarray(0, e).toString("ascii").split("\r\n")[0] || "";
      if (!/^HTTP\/\S+ 200/.test(status)) {
        console.error("upstream CONNECT failed for", target, "->", status);
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        up.destroy();
        return;
      }
      established = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const leftover = upBuf.subarray(e + 4);
      if (leftover.length) client.write(leftover);
      if (rest.length) up.write(rest);
      client.pipe(up);
      // NOTE: upstream->client forwarding stays in this same handler
      // (the `established` branch above). Do NOT add a second data
      // listener — it would duplicate bytes and corrupt TLS.
    });
    up.on("error", (e) => { try { client.end(); } catch {} });
    client.on("error", () => { try { up.destroy(); } catch {} });
    client.on("close", () => { try { up.destroy(); } catch {} });
  };
  client.on("data", onData);
  client.on("error", () => {});
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`relay listening on 127.0.0.1:${PORT} -> ${UP_HOST}:${UP_PORT}`);
});
