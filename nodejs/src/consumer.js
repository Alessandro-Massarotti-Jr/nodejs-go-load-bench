import amqp from 'amqplib';
import { hash, iterations } from './work.js';

const PREFETCH = 5;
const url = process.env.AMQP_URL ?? 'amqp://guest:guest@localhost:5672/';
const queue = process.env.QUEUE ?? 'nodejs-queue';
const hashIterations = iterations();

// Processa uma mensagem; cada chamada é uma promise independente no event loop.
async function handle(channel, msg) {
  try {
    const { message } = JSON.parse(msg.content.toString());
    console.log(`mensagem recebida: ${message} hash=${hash(message, hashIterations)}`);
    channel.ack(msg);
  } catch (err) {
    console.error(`mensagem inválida: ${err.message}`);
    channel.nack(msg, false, false);
  }
}

const connection = await amqp.connect(url);
// Conexão fechada: sai com erro para o orquestrador reiniciar.
connection.on('error', (err) => console.error(`erro na conexão: ${err.message}`));
connection.on('close', () => {
  console.error('conexão com o RabbitMQ fechada');
  process.exit(1);
});

const channel = await connection.createChannel();

await channel.assertQueue(queue, { durable: true });

// No máximo 5 mensagens não confirmadas em voo ao mesmo tempo.
await channel.prefetch(PREFETCH);

await channel.consume(
  queue,
  (msg) => {
    if (msg) handle(channel, msg); // dispara sem await: roda de forma assíncrona
  },
  { noAck: false },
);

console.log(`consumer Node ouvindo a fila "${queue}" (prefetch=${PREFETCH}, HASH_ITERATIONS=${hashIterations})`);

const shutdown = async () => {
  console.log('encerrando consumer');
  connection.removeAllListeners('close');
  await channel.close();
  await connection.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
