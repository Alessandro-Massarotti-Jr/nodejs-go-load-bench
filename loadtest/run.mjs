// Orquestrador do benchmark Go vs Node.js.
//
//   node loadtest/run.mjs                         # suíte completa
//   SHORT=1 node loadtest/run.mjs                 # perfil curto (~25 min, 1 rodada)
//   QUICK=1 node loadtest/run.mjs                 # teste rápido do pipeline
//   node loadtest/run.mjs --scenarios=http-ramp --services=go-http
//   node loadtest/run.mjs --resume=<suiteId>      # retoma uma suíte interrompida
//
// Para cada rodada: deixa instalado só o serviço testado (+ RabbitMQ), reinstala-o
// do zero (2 pods, HPA/KEDA sem histórico), espera estabilizar, aplica a carga
// com um Job dentro do cluster e coleta as métricas no Prometheus.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profile, scenarios, services, settings } from './scenarios.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTEXT = 'docker-desktop';
const NS = 'bench';
const PROMETHEUS = 'http://localhost:9090';
const RABBIT_API = 'http://localhost:15673/api';
const RABBIT_AUTH = 'Basic ' + Buffer.from('admin:admin').toString('base64');
const K6_IMAGE = 'grafana/k6:1.3.0';
const PUBLISHER_IMAGE = 'bench-publisher:local';
const STEP = 5; // resolução (s) das séries do Prometheus
const APP_CHARTS = Object.values(services).map((s) => s.chart);

// ------------------------------------------------------------------ utilitários

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true']),
);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const now = () => Date.now() / 1000;
const log = (...m) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}]`, ...m);

function run(cmd, cmdArgs, input) {
  return execFileSync(cmd, cmdArgs, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}
const kubectl = (a, input) => run('kubectl', ['--context', CONTEXT, ...a], input);
const helm = (a) => run('helm', ['--kube-context', CONTEXT, ...a]);

async function rabbit(path, method = 'GET') {
  const res = await fetch(RABBIT_API + path, { method, headers: { authorization: RABBIT_AUTH } });
  if (!res.ok) throw new Error(`RabbitMQ ${method} ${path}: ${res.status}`);
  return method === 'GET' ? res.json() : null;
}

async function promRange(query, start, end) {
  const url = `${PROMETHEUS}/api/v1/query_range?` +
    new URLSearchParams({ query, start: String(start), end: String(end), step: String(STEP) });
  const body = await (await fetch(url)).json();
  if (body.status !== 'success') throw new Error(`Prometheus: ${body.error} (${query})`);
  const series = body.data.result[0]?.values ?? [];
  return series.map(([t, v]) => [Number(t), Number(v)]);
}

async function promVector(query, time) {
  const url = `${PROMETHEUS}/api/v1/query?` + new URLSearchParams({ query, time: String(time) });
  const body = await (await fetch(url)).json();
  if (body.status !== 'success') throw new Error(`Prometheus: ${body.error} (${query})`);
  return body.data.result.map((r) => [r.metric, Number(r.value[1])]);
}
const promInstant = async (query, time) => (await promVector(query, time))[0]?.[1] ?? null;

// Go imprime o tempo com nanossegundos; Date.parse aceita até milissegundos.
const parseTime = (iso) => Date.parse(iso.replace(/(\.\d{3})\d+/, '$1')) / 1000;

const extractSummary = (logs) => {
  const m = logs.match(/@@SUMMARY@@(.*)@@END@@/s);
  if (!m) throw new Error('resumo não encontrado nos logs do Job');
  return JSON.parse(m[1]);
};

const stats = (series) => {
  const v = series.map(([, x]) => x).filter(Number.isFinite);
  if (!v.length) return { avg: null, max: null, integral: 0 };
  return { avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v), integral: v.reduce((a, b) => a + b, 0) * STEP };
};

// ----------------------------------------------------------------- preparação

function preflight() {
  const ctx = run('kubectl', ['config', 'get-contexts', '-o', 'name']).split(/\s+/);
  if (!ctx.includes(CONTEXT)) throw new Error(`contexto ${CONTEXT} não encontrado`);

  if (args['skip-build'] !== 'true') {
    log('construindo imagens…');
    run('docker', ['build', '-q', '-t', 'bench-go:local', join(ROOT, 'go')]);
    run('docker', ['build', '-q', '-t', 'bench-nodejs:local', join(ROOT, 'nodejs')]);
    run('docker', ['build', '-q', '-t', PUBLISHER_IMAGE, join(ROOT, 'loadtest', 'publisher')]);
  }

  // Script do k6 disponível no cluster como ConfigMap.
  const cm = kubectl(['-n', NS, 'create', 'configmap', 'k6-script',
    `--from-file=http.js=${join(ROOT, 'loadtest', 'k6', 'http.js')}`, '--dry-run=client', '-o', 'yaml']);
  kubectl(['apply', '-f', '-'], cm);

  const size = (img) => Number(run('docker', ['image', 'inspect', img, '--format', '{{.Size}}']).trim());
  return { goImageBytes: size('bench-go:local'), nodejsImageBytes: size('bench-nodejs:local') };
}

// Deixa instalado apenas `chart`, reinstalado do zero.
async function installOnly(chart) {
  const installed = helm(['list', '-n', NS, '-q']).split(/\s+/).filter(Boolean);
  for (const c of APP_CHARTS.filter((c) => installed.includes(c))) {
    helm(['uninstall', c, '-n', NS, '--wait', '--timeout', '5m']);
  }
  // Garante que nenhum pod antigo ainda está terminando.
  for (let i = 0; i < 60; i++) {
    const pods = kubectl(['-n', NS, 'get', 'pods', '-l', `app in (${APP_CHARTS.join(',')})`, '-o', 'name']).trim();
    if (!pods) break;
    await sleep(2);
  }
  helm(['upgrade', '--install', chart, join(ROOT, 'infrastructure', 'applications', chart),
    '-n', NS, '--wait', '--timeout', '5m']);
  kubectl(['-n', NS, 'wait', '--for=condition=ready', 'pod', '-l', `app=${chart}`, '--timeout=180s']);
}

// --------------------------------------------------------------------- Jobs

function jobManifest(name, container) {
  return JSON.stringify({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: NS, labels: { 'bench-job': name } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { 'bench-job': name } },
        spec: { restartPolicy: 'Never', ...container },
      },
    },
  });
}

async function waitJob(name, timeoutSeconds, onTick) {
  const deadline = now() + timeoutSeconds;
  while (now() < deadline) {
    const job = JSON.parse(kubectl(['-n', NS, 'get', 'job', name, '-o', 'json']));
    if (job.status.succeeded || job.status.failed) {
      return { ok: !!job.status.succeeded, at: now() };
    }
    await onTick?.();
    await sleep(1);
  }
  throw new Error(`Job ${name} não terminou em ${timeoutSeconds}s`);
}

// ------------------------------------------------------------------- rodadas

async function runHttp(service, scenario, runId, jobName) {
  const svc = services[service];
  const sc = scenarios[scenario];
  kubectl(['apply', '-f', '-'], jobManifest(jobName, {
    containers: [{
      name: 'k6',
      image: K6_IMAGE,
      args: ['run', '--quiet', '-o', 'experimental-prometheus-rw', '--tag', `testid=${runId}`, '/scripts/http.js'],
      env: [
        { name: 'TARGET', value: svc.target },
        { name: 'SCENARIO_JSON', value: JSON.stringify(sc.k6) },
        { name: 'K6_PROMETHEUS_RW_SERVER_URL', value: 'http://kps-prometheus.monitoring.svc.cluster.local:9090/api/v1/write' },
        { name: 'K6_PROMETHEUS_RW_TREND_STATS', value: 'avg,p(95),p(99)' },
        { name: 'K6_PROMETHEUS_RW_PUSH_INTERVAL', value: '5s' },
      ],
      resources: settings.k6Resources,
      volumeMounts: [{ name: 'scripts', mountPath: '/scripts' }],
    }],
    volumes: [{ name: 'scripts', configMap: { name: 'k6-script' } }],
  }));

  const { ok, at } = await waitJob(jobName, 30 * 60);
  const summary = extractSummary(kubectl(['-n', NS, 'logs', `job/${jobName}`]));
  const m = summary.metrics;
  return {
    end: at,
    jobOk: ok,
    http: {
      latencyMs: m.http_req_duration.values,
      requests: m.http_reqs.values.count,
      avgRps: m.http_reqs.values.rate,
      errorRate: m.http_req_failed.values.rate,
      droppedIterations: m.dropped_iterations?.values.count ?? 0,
      maxVUs: m.vus_max?.values.max ?? null,
      testRunSeconds: summary.state.testRunDurationMs / 1000,
    },
  };
}

async function runQueue(service, scenario, jobName) {
  const svc = services[service];
  const sc = scenarios[scenario];
  const timeline = [];
  const sample = async () => {
    const q = await rabbit(`/queues/%2F/${svc.queue}`);
    timeline.push([now(), q.messages ?? 0, q.consumers]);
    return q;
  };

  kubectl(['apply', '-f', '-'], jobManifest(jobName, {
    containers: [{
      name: 'publisher',
      image: PUBLISHER_IMAGE,
      imagePullPolicy: 'IfNotPresent',
      env: [
        { name: 'QUEUE', value: svc.queue },
        { name: 'AMQP_URL', valueFrom: { secretKeyRef: { name: 'rabbitmq-connection', key: 'AMQP_URL' } } },
        ...Object.entries(sc.publisher).map(([name, value]) => ({ name, value })),
      ],
      resources: settings.publisherResources,
    }],
  }));

  const published = await waitJob(jobName, 30 * 60, sample);
  const pub = extractSummary(kubectl(['-n', NS, 'logs', `job/${jobName}`]));

  // Espera a fila esvaziar (estatísticas do RabbitMQ atualizadas a cada 1s).
  const deadline = now() + settings.drainTimeoutSeconds;
  let drainedAt = null;
  while (now() < deadline) {
    const q = await sample();
    if ((q.messages ?? 0) === 0) { drainedAt = now(); break; }
    await sleep(1);
  }
  const publishStart = parseTime(pub.start);
  return {
    start: publishStart,
    end: drainedAt ?? now(),
    jobOk: published.ok && drainedAt !== null,
    queue: {
      published: pub.published,
      publishSeconds: pub.seconds,
      publishRate: pub.ratePerSecond,
      drained: drainedAt !== null,
      peakDepth: Math.max(0, ...timeline.map(([, m]) => m)),
      depthTimeline: timeline.map(([t, m, c]) => [Math.round(t), m, c]),
    },
  };
}

function podStartups(chart, since) {
  const pods = JSON.parse(kubectl(['-n', NS, 'get', 'pods', '-l', `app=${chart}`, '-o', 'json'])).items;
  return pods
    .map((p) => {
      const created = Date.parse(p.metadata.creationTimestamp) / 1000;
      const ready = p.status.conditions?.find((c) => c.type === 'Ready' && c.status === 'True');
      return { created, readySeconds: ready ? Date.parse(ready.lastTransitionTime) / 1000 - created : null };
    })
    .filter((p) => p.created >= since);
}

// Reinícios de container (ex.: liveness probe matando um pod saturado) durante a rodada.
export async function podRestarts(chart, t0, end) {
  const sel = `{namespace="${NS}",pod=~"${chart}-[a-z0-9]{6,10}-[a-z0-9]{5}"}`;
  const window = Math.ceil(end - t0);
  const v = await promInstant(`sum(max_over_time(kube_pod_container_status_restarts_total${sel}[${window}s]))`, end);
  return v ?? 0;
}

async function collect(service, t0, t1, jobName, runId) {
  const { chart, kind } = services[service];
  const pod = `{namespace="${NS}",pod=~"${chart}-[a-z0-9]{6,10}-[a-z0-9]{5}"}`;
  const end = t1 + settings.tailSeconds;
  const q = {
    cpu: `sum(rate(container_cpu_usage_seconds_total${pod}[45s]))`,
    memory: `sum(container_memory_working_set_bytes${pod})`,
    memoryPerPod: `avg(container_memory_working_set_bytes${pod})`,
    replicas: `sum(kube_deployment_status_replicas{namespace="${NS}",deployment="${chart}"})`,
    readyReplicas: `sum(kube_deployment_status_replicas_ready{namespace="${NS}",deployment="${chart}"})`,
    generatorCpu: `sum(rate(container_cpu_usage_seconds_total{namespace="${NS}",pod=~"${jobName}-[a-z0-9]{5}"}[45s]))`,
  };
  if (kind === 'http') {
    q.rps = `sum(rate(k6_http_reqs_total{testid="${runId}"}[10s]))`;
    q.p95 = `max(k6_http_req_duration_p95{testid="${runId}"})`;
    q.errorsPerSecond = `sum(rate(k6_http_reqs_total{testid="${runId}",expected_response="false"}[10s])) or vector(0)`;
  } else {
    q.ackRate = `sum(rate(rabbitmq_global_messages_acknowledged_total[20s]))`;
  }

  const series = {};
  for (const [k, expr] of Object.entries(q)) series[k] = await promRange(expr, t0, end);

  const replicas = series.replicas.filter(([t]) => t <= t1);
  const initial = replicas[0]?.[1] ?? 2;
  const firstUp = replicas.find(([, r]) => r > initial);
  const cpu = stats(series.cpu.filter(([t]) => t <= t1));

  // CPU consumida = soma, por pod, do contador no fim menos o contador no início
  // (pods criados durante a rodada começam do zero; pods removidos entram pelo max_over_time).
  const counter = `container_cpu_usage_seconds_total${pod}`;
  const before = new Map((await promVector(counter, t0)).map(([m, v]) => [m.pod, v]));
  const after = await promVector(`max_over_time(${counter}[${Math.ceil(end - t0)}s])`, end);
  const cpuSeconds = after.reduce((acc, [m, v]) => acc + Math.max(0, v - (before.get(m.pod) ?? 0)), 0);
  const settle = settings.settleSeconds;
  const mem = stats(series.memory.filter(([t]) => t <= t1));
  const memPod = stats(series.memoryPerPod.filter(([t]) => t <= t1));
  const gen = stats(series.generatorCpu.filter(([t]) => t <= t1));

  return {
    series,
    resources: {
      cpuAvgCores: cpu.avg,
      cpuPeakCores: cpu.max,
      cpuSeconds,
      memoryAvgBytes: mem.avg,
      memoryPeakBytes: mem.max,
      memoryPerPodAvgBytes: memPod.avg,
      memoryPerPodPeakBytes: memPod.max,
      idleCpuCores: await promInstant(`sum(rate(${counter}[${settle}s]))`, t0),
      idleMemoryPerPodBytes: await promInstant(`avg(avg_over_time(container_memory_working_set_bytes${pod}[${settle}s]))`, t0),
      generatorCpuPeakCores: gen.max,
    },
    scaling: {
      restarts: await podRestarts(chart, t0, end),
      initialReplicas: initial,
      maxReplicas: Math.max(...replicas.map(([, r]) => r)),
      podSeconds: stats(replicas).integral,
      firstScaleUpSeconds: firstUp ? firstUp[0] - t0 : null,
      podStartups: podStartups(chart, t0),
    },
  };
}

async function runOne(service, scenario, n) {
  const { chart, kind, queue } = services[service];
  const runId = `${scenario}.${service}.r${n}.${Date.now()}`;
  const jobName = `load-${Date.now().toString(36)}`;
  log(`▶ ${scenario} | ${service} | rodada ${n}`);

  await installOnly(chart);
  if (kind === 'queue') {
    for (let i = 0; i < 60; i++) {
      const q = await rabbit(`/queues/%2F/${queue}`).catch(() => null);
      if (q?.consumers >= 2) break;
      await sleep(1);
    }
    await rabbit(`/queues/%2F/${queue}/contents`, 'DELETE');
  }
  await sleep(settings.settleSeconds);

  const created = now();
  const result = kind === 'http'
    ? await runHttp(service, scenario, runId, jobName)
    : await runQueue(service, scenario, jobName);
  const t1 = result.end;
  // HTTP: o k6 termina em t1 e rodou testRunSeconds; fila: início real da publicação.
  const t0 = result.http ? t1 - result.http.testRunSeconds : result.start ?? created;
  await sleep(settings.tailSeconds + 10); // deixa o Prometheus raspar o fim da rodada

  const metrics = await collect(service, t0, t1, jobName, runId);
  kubectl(['-n', NS, 'delete', 'job', jobName, '--wait=false']);

  const out = {
    runId, service, scenario, run: n,
    lang: services[service].lang, kind,
    start: t0, end: t1, durationSeconds: t1 - t0,
    jobOk: result.jobOk,
    ...(result.http ? { http: result.http } : {}),
    ...(result.queue ? { queue: result.queue } : {}),
    ...metrics,
  };
  if (kind === 'http') {
    out.efficiency = { requestsPerCpuSecond: (out.http.requests * (1 - out.http.errorRate)) / out.resources.cpuSeconds };
    out.http.peakRps = Math.max(0, ...metrics.series.rps.map(([, v]) => v));
  } else {
    out.queue.consumeRate = out.queue.published / out.durationSeconds;
    out.efficiency = { messagesPerCpuSecond: out.queue.published / out.resources.cpuSeconds };
  }
  log(`✔ ${scenario} | ${service} | rodada ${n}: ${out.durationSeconds.toFixed(0)}s, ` +
    `máx ${out.scaling.maxReplicas} pods, CPU ${out.resources.cpuSeconds.toFixed(0)} cpu·s` +
    (out.http ? `, p95 ${out.http.latencyMs['p(95)'].toFixed(1)}ms, erros ${(out.http.errorRate * 100).toFixed(2)}%` : '') +
    (out.queue ? `, ${out.queue.consumeRate.toFixed(0)} msg/s` : ''));
  return out;
}

// --------------------------------------------------------------------- suíte

async function main() {
  const suiteId = args.resume ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (profile === 'full' ? '' : `-${profile}`);
  const dir = join(ROOT, 'loadtest', 'results', suiteId);
  mkdirSync(join(dir, 'runs'), { recursive: true });

  const pick = (all, filter) => (filter ? filter.split(',') : Object.keys(all));
  const scenarioList = pick(scenarios, args.scenarios);
  const serviceList = pick(services, args.services);

  const meta = existsSync(join(dir, 'suite.json')) ? JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8')) : null;
  const images = preflight();
  writeFileSync(join(dir, 'suite.json'), JSON.stringify({
    suiteId, profile, quick: profile === 'quick', startedAt: meta?.startedAt ?? new Date().toISOString(),
    settings, scenarios, services, images,
    hashIterations: 1000, cluster: { context: CONTEXT },
  }, null, 2));

  log(`suíte ${suiteId}: ${scenarioList.length} cenários × ${settings.runs} rodadas`);
  for (const scenario of scenarioList) {
    const targets = serviceList.filter((s) => services[s].kind === scenarios[scenario].kind);
    for (let n = 1; n <= settings.runs; n++) {
      // Alterna a ordem a cada rodada para que efeitos do ambiente afetem os dois por igual.
      const ordered = n % 2 ? targets : [...targets].reverse();
      for (const service of ordered) {
        const file = join(dir, 'runs', `${scenario}.${service}.r${n}.json`);
        if (existsSync(file)) { log(`↷ já existe: ${scenario} | ${service} | rodada ${n}`); continue; }
        try {
          writeFileSync(file, JSON.stringify(await runOne(service, scenario, n), null, 2));
        } catch (err) {
          log(`✖ ${scenario} | ${service} | rodada ${n}: ${err.message}`);
          writeFileSync(file.replace(/\.json$/, '.error.txt'), String(err.stack ?? err));
        }
      }
    }
  }

  // Restaura o cluster com os 4 serviços.
  for (const c of APP_CHARTS) {
    helm(['upgrade', '--install', c, join(ROOT, 'infrastructure', 'applications', c), '-n', NS]);
  }
  log(`suíte concluída: ${dir}`);
  log(`gere o relatório com: node loadtest/report.mjs ${suiteId}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
