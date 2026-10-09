import { createServer } from 'node:http';
import { hash, iterations } from './work.js';

const port = Number(process.env.PORT ?? 3000);
const hashIterations = iterations();

// Entrada fixa: toda requisição calcula o mesmo hash (mesmo valor do projeto Go).
const HASH_INPUT = 'go-vs-node-benchmark';

const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/') {
    res.writeHead(404).end();
    return;
  }

  const body = JSON.stringify({
    message: 'Finished!',
    data: { result: hash(HASH_INPUT, hashIterations) },
  });

  res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
});

server.listen(port, () => {
  console.log(`servidor Node rodando em http://localhost:${port} (HASH_ITERATIONS=${hashIterations})`);
});
