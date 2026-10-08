import { handleVercelApi } from '../server.mjs';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const result = {
      status: 200,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body ?? '';
      },
    };

    const requestLike = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers.entries()),
      body: {},
    };

    if (request.body) {
      requestLike.body = await request.text();
    }

    await handleVercelApi(requestLike, result);
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  },
};
