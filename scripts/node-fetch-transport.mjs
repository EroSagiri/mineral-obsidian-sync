/** Node-only diagnostic transport: real signing, real fetch, never used by the plugin. */
export class NodeFetchTransport {
  async send(request) {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    const headers = {};
    response.headers.forEach((value, name) => { headers[name] = value; });
    const arrayBuffer = await response.arrayBuffer();
    return { status: response.status, headers, text: new TextDecoder().decode(arrayBuffer), arrayBuffer };
  }
}
