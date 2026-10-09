// Teste de carga HTTP. O cenário vem pronto do orquestrador em SCENARIO_JSON
// (um executor do k6), assim todas as definições ficam em scenarios.mjs.
import http from 'k6/http';
import { check } from 'k6';

const TARGET = __ENV.TARGET;
const scenario = JSON.parse(__ENV.SCENARIO_JSON);

export const options = {
  scenarios: { load: scenario },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: true,
};

export default function () {
  const res = http.get(TARGET, { timeout: '10s' });
  check(res, { 'status 200': (r) => r.status === 200 });
}

// Resumo em JSON no stdout, lido pelo orquestrador nos logs do Job.
export function handleSummary(data) {
  return { stdout: `\n@@SUMMARY@@${JSON.stringify(data)}@@END@@\n` };
}
