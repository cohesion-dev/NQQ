import { defineConfig } from 'vite';
import { attachGateway, handleRequest } from './server/index';

export default defineConfig({
  build: { assetsInlineLimit: 0 },
  server: {
    host: '127.0.0.1',
  },
  plugins: [{
    name: 'niuqiqi-local-gateway',
    /** 开发时使用同源中间件，避免页面与网关分两条启动命令。 */
    configureServer(server) {
      if (server.httpServer) attachGateway(server.httpServer);
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/')) return next();
        void handleRequest(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'Gateway request failed' }));
        });
      });
    },
  }],
});
