// Definição única dos serviços e cenários do benchmark.
//
// Perfis:
//   (padrão)  completo: durações cheias, 3 rodadas (~3h)
//   SHORT=1   curto: os mesmos 5 cenários encurtados, 1 rodada (~25 min)
//   QUICK=1   rápido: só valida o pipeline, sem valor estatístico (~15 min)

export const profile = process.env.QUICK === '1' ? 'quick' : process.env.SHORT === '1' ? 'short' : 'full';
const d = (full, short, quick) => ({ full, short, quick })[profile];

const fmt = (n) => n.toLocaleString('pt-BR');
const seconds = (s) => (s % 60 ? `${s}s` : `${s / 60}m`);
const label = (s) => (s % 60 ? `${s} s` : `${s / 60} min`);

export const services = {
  'nodejs-http': { chart: 'nodejs', lang: 'Node.js', kind: 'http', target: 'http://nodejs-svc:3001/' },
  'go-http': { chart: 'go', lang: 'Go', kind: 'http', target: 'http://go-svc:8081/' },
  'nodejs-listener': { chart: 'nodejs-listener', lang: 'Node.js', kind: 'queue', queue: 'nodejs-queue' },
  'go-listener': { chart: 'go-listener', lang: 'Go', kind: 'queue', queue: 'go-queue' },
};

const baseline = { rate: 200, secs: d(120, 60, 20) };
const ramp = { target: d(1500, 1500, 300), up: d(300, 90, 20), hold: d(120, 30, 10) };
const stress = { target: d(12000, 12000, 1500), up: d(360, 120, 30) };
const burst = { count: d(100000, 30000, 5000) };
const sustained = { rate: 800, secs: d(300, 90, 30) };

export const scenarios = {
  // ---------------------------------------------------------------- HTTP (k6)
  'http-baseline': {
    kind: 'http',
    title: `HTTP: baseline (${baseline.rate} req/s constantes)`,
    description: `Carga leve e constante por ${label(baseline.secs)}: mede latência sem pressão de escala.`,
    k6: {
      executor: 'constant-arrival-rate',
      rate: baseline.rate, timeUnit: '1s', duration: seconds(baseline.secs),
      preAllocatedVUs: 50, maxVUs: 500,
    },
  },
  'http-ramp': {
    kind: 'http',
    title: `HTTP: rampa até ${fmt(ramp.target)} req/s`,
    description: `Sobe de 0 a ${fmt(ramp.target)} req/s em ${label(ramp.up)} e segura ${label(ramp.hold)}: força o autoscaling.`,
    k6: {
      executor: 'ramping-arrival-rate',
      startRate: 0, timeUnit: '1s', preAllocatedVUs: 200, maxVUs: 2000,
      stages: [
        { target: ramp.target, duration: seconds(ramp.up) },
        { target: ramp.target, duration: seconds(ramp.hold) },
      ],
    },
  },
  'http-stress': {
    kind: 'http',
    title: `HTTP: estresse até ${fmt(stress.target)} req/s`,
    description: `Rampa de 100 a ${fmt(stress.target)} req/s em ${label(stress.up)}: encontra o limite de cada serviço.`,
    k6: {
      executor: 'ramping-arrival-rate',
      startRate: 100, timeUnit: '1s', preAllocatedVUs: 500, maxVUs: 3000,
      stages: [{ target: stress.target, duration: seconds(stress.up) }],
    },
  },

  // ----------------------------------------------------- Filas (publicador)
  'queue-burst': {
    kind: 'queue',
    title: `Fila: rajada de ${fmt(burst.count)} mensagens`,
    description: `Publica ${fmt(burst.count)} mensagens de uma vez e mede o tempo até a fila esvaziar.`,
    publisher: { MODE: 'burst', COUNT: String(burst.count) },
  },
  'queue-sustained': {
    kind: 'queue',
    title: `Fila: ${sustained.rate} msg/s por ${label(sustained.secs)}`,
    description: 'Fluxo constante acima da capacidade de 2 pods Node: mede se a fila acompanha.',
    publisher: { MODE: 'rate', RATE: String(sustained.rate), DURATION_SECONDS: String(sustained.secs) },
  },
};

export const settings = {
  profile,
  runs: Number(process.env.RUNS ?? d(3, 1, 1)),
  // Tempo ocioso antes de cada rodada (estabiliza CPU/memória e mede o repouso).
  settleSeconds: d(30, 15, 10),
  // Tempo extra observado após o fim da carga (captura o fim da escala).
  tailSeconds: d(15, 10, 5),
  // Limite de espera para a fila esvaziar após o fim da publicação.
  drainTimeoutSeconds: 1200,
  // Recursos do gerador de carga (iguais para todos os serviços).
  k6Resources: { requests: { cpu: '2', memory: '1Gi' }, limits: { cpu: '6', memory: '3Gi' } },
  publisherResources: { requests: { cpu: '500m', memory: '128Mi' }, limits: { cpu: '2', memory: '512Mi' } },
};
