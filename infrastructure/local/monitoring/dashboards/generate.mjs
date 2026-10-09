// Gera bench.json (dashboard do Grafana). Uso: node generate.mjs
import { writeFileSync } from 'node:fs';

const APPS = 'go|nodejs|go-listener|nodejs-listener';
const QUEUES = 'go-queue|nodejs-queue';
const POD_SUFFIX = '-[a-z0-9]{6,10}-[a-z0-9]{5}';

// cAdvisor no Docker Desktop só expõe métricas por pod (sem label "container"):
// o nome do deployment é extraído do nome do pod.
const byApp = (agg, expr) =>
  `${agg} by (app) (label_replace(${expr}, "app", "$1", "pod", "(.*)${POD_SUFFIX}"))`;
const podSel = `{namespace="bench",pod=~"(${APPS})${POD_SUFFIX}"}`;

const panels = [
  ['Réplicas por serviço', `sum by (deployment) (kube_deployment_status_replicas{namespace="bench",deployment=~"${APPS}"})`, '{{deployment}}', 'short'],
  ['CPU por serviço (cores)', byApp('sum', `rate(container_cpu_usage_seconds_total${podSel}[20s])`), '{{app}}', 'short'],
  ['Memória por serviço (soma dos pods)', byApp('sum', `container_memory_working_set_bytes${podSel}`), '{{app}}', 'bytes'],
  ['Memória média por pod', byApp('avg', `container_memory_working_set_bytes${podSel}`), '{{app}}', 'bytes'],
  ['Mensagens na fila (prontas + não confirmadas)', `sum by (queue) (rabbitmq_queue_messages_ready{queue=~"${QUEUES}"}) + sum by (queue) (rabbitmq_queue_messages_unacked{queue=~"${QUEUES}"})`, '{{queue}}', 'short'],
  ['Mensagens confirmadas por segundo', 'sum(rate(rabbitmq_global_messages_acknowledged_total[20s]))', 'ack/s', 'short'],
  ['k6: requisições por segundo', 'sum by (testid) (rate(k6_http_reqs_total[10s]))', '{{testid}}', 'reqps'],
  ['k6: latência p95', 'max by (testid) (k6_http_req_duration_p95)', '{{testid}}', 's'],
];

const ds = { type: 'prometheus', uid: 'prometheus' };
const dashboard = {
  title: 'Benchmark Go vs Node.js',
  uid: 'bench-go-node',
  schemaVersion: 39,
  refresh: '5s',
  time: { from: 'now-30m', to: 'now' },
  panels: panels.map(([title, expr, legendFormat, unit], i) => ({
    id: i + 1,
    type: 'timeseries',
    title,
    gridPos: { h: 8, w: 12, x: (i % 2) * 12, y: Math.floor(i / 2) * 8 },
    datasource: ds,
    fieldConfig: { defaults: { unit }, overrides: [] },
    targets: [{ refId: 'A', expr, legendFormat, datasource: ds }],
  })),
};

writeFileSync(new URL('./bench.json', import.meta.url), JSON.stringify(dashboard, null, 2));
console.log('bench.json gerado');
