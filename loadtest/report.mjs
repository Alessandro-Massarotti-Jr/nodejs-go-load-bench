// Gera o relatório HTML de uma suíte.  Uso: node loadtest/report.mjs <suiteId>
// Saídas em loadtest/results/<suiteId>/:
//   report.html           página completa para abrir localmente (funciona offline)
//   report.artifact.html  fragmento para publicar como Artifact (o host adiciona <head>/<body>)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const suiteId = process.argv[2] ?? readdirSync(join(ROOT, 'results')).sort().at(-1);
const dir = join(ROOT, 'results', suiteId);
const suite = JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8'));
const runs = readdirSync(join(dir, 'runs'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, 'runs', f), 'utf8')));
const failures = readdirSync(join(dir, 'runs')).filter((f) => f.endsWith('.error.txt'));

// ------------------------------------------------------------ métricas

const MB = 1024 * 1024;
const startups = (r) => {
  const v = r.scaling.podStartups.map((p) => p.readySeconds).filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// [chave, rótulo, unidade, extrator, menor é melhor?, casas decimais]
const COMMON = [
  ['maxReplicas', 'Pods no pico', 'pods', (r) => r.scaling.maxReplicas, true, 1],
  ['firstScaleUp', 'Tempo até o 1º scale-up', 's', (r) => r.scaling.firstScaleUpSeconds, true, 0],
  ['restarts', 'Reinícios de pod (liveness)', 'reinícios', (r) => r.scaling.restarts, true, 0],
  ['podSeconds', 'Pod-segundos (custo)', 'pod·s', (r) => r.scaling.podSeconds, true, 0],
  ['cpuSeconds', 'CPU consumida', 'cpu·s', (r) => r.resources.cpuSeconds, true, 1],
  ['cpuAvg', 'CPU média (soma dos pods)', 'cores', (r) => r.resources.cpuAvgCores, true, 2],
  ['cpuPeak', 'CPU no pico', 'cores', (r) => r.resources.cpuPeakCores, true, 2],
  ['memPeak', 'Memória no pico (soma)', 'MB', (r) => r.resources.memoryPeakBytes / MB, true, 1],
  ['memPod', 'Memória média por pod', 'MB', (r) => r.resources.memoryPerPodAvgBytes / MB, true, 1],
  ['memIdle', 'Memória por pod em repouso', 'MB', (r) => r.resources.idleMemoryPerPodBytes / MB, true, 1],
  ['startup', 'Subida de pod novo até pronto', 's', startups, true, 1],
];
const METRICS = {
  http: [
    ['p50', 'Latência mediana (p50)', 'ms', (r) => r.http.latencyMs.med, true, 2],
    ['avg', 'Latência média', 'ms', (r) => r.http.latencyMs.avg, true, 2],
    ['p95', 'Latência p95', 'ms', (r) => r.http.latencyMs['p(95)'], true, 2],
    ['p99', 'Latência p99', 'ms', (r) => r.http.latencyMs['p(99)'], true, 2],
    ['max', 'Latência máxima', 'ms', (r) => r.http.latencyMs.max, true, 0],
    ['rps', 'Vazão média', 'req/s', (r) => r.http.avgRps, false, 0],
    ['peakRps', 'Vazão no pico', 'req/s', (r) => r.http.peakRps, false, 0],
    ['requests', 'Requisições feitas', 'req', (r) => r.http.requests, false, 0],
    ['errors', 'Taxa de erro', '%', (r) => r.http.errorRate * 100, true, 2],
    ['dropped', 'Requisições não enviadas (servidor saturado)', 'req', (r) => r.http.droppedIterations, true, 0],
    ['duration', 'Duração do teste', 's', (r) => r.http.testRunSeconds, true, 1],
    ['efficiency', 'Requisições por segundo de CPU', 'req/cpu·s', (r) => r.efficiency.requestsPerCpuSecond, false, 0],
    ...COMMON,
  ],
  queue: [
    ['drain', 'Tempo para processar tudo', 's', (r) => r.durationSeconds, true, 1],
    ['consumeRate', 'Vazão de processamento', 'msg/s', (r) => r.queue.consumeRate, false, 0],
    ['peakDepth', 'Pico de mensagens na fila', 'msg', (r) => r.queue.peakDepth, true, 0],
    ['published', 'Mensagens publicadas', 'msg', (r) => r.queue.published, null, 0],
    ['efficiency', 'Mensagens por segundo de CPU', 'msg/cpu·s', (r) => r.efficiency.messagesPerCpuSecond, false, 0],
    ...COMMON,
  ],
};

const agg = (values) => {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return { mean: null, sd: null, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { mean, sd, n: v.length, values: v };
};

// Série relativa ao início da rodada: [[segundos, valor], ...]
const rel = (series, t0) => (series ?? []).map(([t, v]) => [Math.round(t - t0), +v.toFixed(4)]);

const scenarioData = Object.entries(suite.scenarios).map(([id, sc]) => {
  const svcIds = Object.keys(suite.services).filter((s) => suite.services[s].kind === sc.kind);
  const byService = Object.fromEntries(svcIds.map((s) => [s, runs.filter((r) => r.scenario === id && r.service === s).sort((a, b) => a.run - b.run)]));
  if (!Object.values(byService).some((l) => l.length)) return null;

  const metrics = METRICS[sc.kind].map(([key, label, unit, fn, lowerBetter, digits]) => ({
    key, label, unit, lowerBetter, digits,
    values: Object.fromEntries(svcIds.map((s) => [s, agg(byService[s].map((r) => { try { return fn(r); } catch { return null; } }))])),
  }));

  const series = Object.fromEntries(svcIds.map((s) => [s, byService[s].map((r) => ({
    run: r.run,
    replicas: rel(r.series.replicas, r.start),
    cpu: rel(r.series.cpu, r.start),
    memory: rel(r.series.memory, r.start).map(([t, v]) => [t, +(v / MB).toFixed(1)]),
    ...(sc.kind === 'http'
      ? { rps: rel(r.series.rps, r.start), p95: rel(r.series.p95, r.start).map(([t, v]) => [t, +(v * 1000).toFixed(2)]) }
      : { depth: (r.queue.depthTimeline ?? []).map(([t, m]) => [Math.round(t - r.start), m]) }),
  }))]));

  return { id, ...sc, services: svcIds, metrics, series };
}).filter(Boolean);

const data = {
  suiteId,
  quick: suite.quick,
  profile: suite.profile ?? (suite.quick ? 'quick' : 'full'),
  startedAt: suite.startedAt,
  runsPerScenario: suite.settings.runs,
  totalRuns: runs.length,
  failures,
  hashIterations: suite.hashIterations,
  images: { go: suite.images.goImageBytes / MB, nodejs: suite.images.nodejsImageBytes / MB },
  services: suite.services,
  scenarios: scenarioData,
};

const CHART_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const CHART_TAG = `<script src="${CHART_URL}"></script>`;

// Chart.js baixado uma vez e guardado em loadtest/vendor para o relatório local funcionar offline.
async function chartJs() {
  const file = join(ROOT, 'vendor', 'chart.umd.min.js');
  if (!existsSync(file)) {
    const res = await fetch(CHART_URL);
    if (!res.ok) return null;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await res.text());
  }
  return readFileSync(file, 'utf8');
}

const template = readFileSync(join(ROOT, 'report-template.html'), 'utf8');
const fragment = template.replace('/*__DATA__*/null', JSON.stringify(data).replace(/</g, '\\u003c'));
writeFileSync(join(dir, 'report.artifact.html'), fragment);

// Versão local: documento completo, com o Chart.js embutido quando disponível.
const lib = await chartJs().catch(() => null);
const body = lib
  ? fragment.replace(CHART_TAG, () => `<script>${lib.replace(/<\/script/gi, '<\\/script')}</script>`)
  : fragment;
// Tudo antes de <main> (title, meta, fontes, estilos) vai para o <head>.
const split = body.indexOf('<main');
const standalone = `<!doctype html>
<html lang="pt-BR">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { margin: 0; } img { max-width: 100%; } [hidden] { display: none !important; }</style>
${body.slice(0, split).trim()}
</head>
<body>
${body.slice(split)}
</body>
</html>
`;
writeFileSync(join(dir, 'report.html'), standalone);
console.log(`relatório local: ${join(dir, 'report.html')}${lib ? '' : ' (gráficos precisam de internet)'}`);
console.log(`para publicar:   ${join(dir, 'report.artifact.html')}`);
