# Go × Node.js

<p>
  <img src="https://img.shields.io/badge/made%20by-Alessandro%20Massarotti%20Jr-00ADD8?style=flat-square">
  <img src="https://img.shields.io/badge/Go-1.26-00ADD8?style=flat-square">
  <img src="https://img.shields.io/badge/Node.js-24-00ADD8?style=flat-square">
  <img alt="GitHub language count" src="https://img.shields.io/github/languages/count/Alessandro-Massarotti-Jr/nodejs-go-load-bench?color=00ADD8&style=flat-square">
  <img alt="GitHub Top Language" src="https://img.shields.io/github/languages/top/Alessandro-Massarotti-Jr/nodejs-go-load-bench?color=00ADD8&style=flat-square">
</p>

Estudo comparativo entre Go e Node.js com o mesmo serviço implementado nas duas linguagens,
rodando num cluster Kubernetes local com autoscaling e testes de carga automatizados.

```
.
├── go/                 # projeto Go     (servidor HTTP + listener RabbitMQ)
├── nodejs/             # projeto Node   (servidor HTTP + listener RabbitMQ)
├── infrastructure/     # charts Helm (aplicações, RabbitMQ, monitoramento)
└── loadtest/           # testes de carga, orquestrador e relatório
```

## Projetos

Os dois projetos têm a mesma base, com dois entrypoints cada:

| | Go | Node.js |
|---|---|---|
| Servidor HTTP | `go/cmd/http` | `nodejs/src/http.js` |
| Listener RabbitMQ | `go/cmd/consumer` | `nodejs/src/consumer.js` |
| Carga de CPU | `go/internal/work` | `nodejs/src/work.js` |
| Lib AMQP | `rabbitmq/amqp091-go` (oficial do RabbitMQ) | `amqplib` |
| Concorrência no listener | uma goroutine por mensagem | uma promise por mensagem |

- **HTTP**: `GET /` calcula um hash e responde `{"message":"Finished!","data":{"result":"<hash>"}}`.
- **Listener**: recebe `{"message":"..."}`, calcula o hash da mensagem e imprime o resultado.
- **Carga de CPU**: SHA-256 encadeado `HASH_ITERATIONS` vezes (padrão 1000). As duas linguagens
  geram exatamente o mesmo hash. Isso garante que as duas fazem o mesmo trabalho.
- **Prefetch** do RabbitMQ: 5 nos dois listeners.
- **Dependências externas**: só a lib AMQP. HTTP, JSON e hash usam a biblioteca padrão.

### Variáveis de ambiente

| Variável | Uso | Padrão |
|---|---|---|
| `PORT` | porta HTTP | Go `8080`, Node `3000` |
| `AMQP_URL` | conexão RabbitMQ | `amqp://guest:guest@localhost:5672/` |
| `QUEUE` | fila do listener | `go-queue` / `nodejs-queue` |
| `HASH_ITERATIONS` | iterações de SHA-256 | `1000` |

### Rodando localmente

```sh
# Go
cd go && go run ./cmd/http
cd go && go run ./cmd/consumer

# Node.js
cd nodejs && npm install
npm run http
npm run consumer
```

Cada projeto gera uma única imagem Docker com os dois entrypoints. O comando é escolhido no deployment:

```sh
docker build -t bench-go:local ./go
docker build -t bench-nodejs:local ./nodejs
```

## Infraestrutura (Kubernetes + Helm)

Um chart Helm por aplicação, mais os charts de suporte do cluster local.

```
infrastructure/
├── applications/            # um chart por serviço
│   ├── go/                  # Deployment go        + Service go-svc     + HPA
│   ├── nodejs/              # Deployment nodejs    + Service nodejs-svc + HPA
│   ├── go-listener/         # Deployment go-listener     + KEDA ScaledObject (go-queue)
│   └── nodejs-listener/     # Deployment nodejs-listener + KEDA ScaledObject (nodejs-queue)
└── local/                   # charts de suporte do cluster local
    ├── common/              # Secret rabbitmq-connection + TriggerAuthentication do KEDA
    ├── rabbitmq/            # RabbitMQ (StatefulSet + Services + ServiceMonitor)
    └── monitoring/          # Prometheus + Grafana (kube-prometheus-stack) + dashboard
```

Cada chart de aplicação segue o mesmo padrão: `values.yaml` com `MIN_REPLICAS`, `MAX_REPLICAS`,
`requests`, `limits`, `image` e as listas `configMaps`/`secrets` injetadas via `envFrom`.

Os 4 serviços usam **os mesmos** valores. Se mudar um, mude nos quatro:

- **Recursos**: `500m` CPU / `256Mi` por pod, com request igual ao limit. O HPA calcula a
  utilização sobre o request, então "70%" significa 70% da capacidade real do pod.
- **Réplicas**: mínimo 2, máximo 5 pods.
- **Escala por CPU**: quando a CPU média passa de 70%.
- **Escala por fila**: os listeners também escalam com mais de 10 mensagens prontas por pod (`QUEUE_LENGTH`).
- **Comportamento**: o mesmo `behavior` de scale up/down no HPA e no KEDA.

### Pré-requisitos (uma vez por cluster)

```sh
# 1. Garanta que está no cluster local!
kubectl config use-context docker-desktop

# 2. metrics-server (o HPA precisa; o Docker Desktop não traz por padrão)
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm upgrade --install metrics-server metrics-server/metrics-server \
  -n kube-system --set "args={--kubelet-insecure-tls}"

# 3. KEDA
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm upgrade --install keda kedacore/keda -n keda --create-namespace

# 4. Prometheus + Grafana
helm dependency build infrastructure/local/monitoring
helm upgrade --install monitoring infrastructure/local/monitoring -n monitoring --create-namespace
```

O Kubernetes do Docker Desktop enxerga as imagens do Docker local, então não há registry.

> Se o cluster for do tipo **kind** (opção do Docker Desktop), carregue as imagens nele:
> `kind load docker-image bench-go:local bench-nodejs:local --name desktop`

### Deploy

Rodar da raiz do repositório. A ordem importa: `common` e `rabbitmq` antes das aplicações.

```sh
kubectl create namespace bench

for chart in local/common local/rabbitmq applications/go applications/nodejs applications/go-listener applications/nodejs-listener; do
  helm upgrade --install "$(basename $chart)" "./infrastructure/$chart" -n bench
done
```

Após mudar o código, gere a imagem de novo e reinicie:

```sh
kubectl -n bench rollout restart deploy
```

### Endereços

| Serviço | Endereço |
|---|---|
| go-svc | http://localhost:8081/ |
| nodejs-svc | http://localhost:3001/ |
| RabbitMQ (painel e API) | http://localhost:15673 (admin/admin) |
| Grafana | http://localhost:3030 (admin/admin), dashboard **Benchmark Go vs Node.js** |
| Prometheus | http://localhost:9090 |

### Observando a escala

```sh
kubectl -n bench get hpa -w          # inclui os HPAs criados pelo KEDA (keda-hpa-*)
kubectl -n bench get scaledobject
kubectl -n bench top pods
```

O dashboard do Grafana é gerado por `infrastructure/local/monitoring/dashboards/generate.mjs`.
No Docker Desktop, o cAdvisor só expõe CPU e memória por pod, sem o label `container`. Por isso,
as queries extraem o nome do deployment a partir do nome do pod.

### Remover

```sh
for r in nodejs-listener go-listener nodejs go rabbitmq common; do helm uninstall $r -n bench; done
helm uninstall monitoring -n monitoring
```

## Testes de carga

```
loadtest/
├── scenarios.mjs          # serviços e cenários (fonte única de verdade)
├── run.mjs                # orquestrador: roda a matriz e salva um JSON por rodada
├── report.mjs             # gera o relatório HTML (local e para publicar) a partir dos JSONs
├── report-template.html   # visual do relatório
├── k6/http.js             # carga HTTP (k6, roda como Job no cluster)
├── publisher/             # carga de filas (Go, roda como Job no cluster)
├── vendor/                # Chart.js em cache para o relatório local
└── results/<suite>/       # suite.json, runs/*.json, report.html, report.artifact.html
```

Requer a infraestrutura acima instalada, incluindo o monitoramento.

### Rodando

```sh
# Suíte completa: 5 cenários × 3 rodadas × 2 linguagens (~3h)
node loadtest/run.mjs

# Perfil curto: os 5 cenários encurtados, 1 rodada (~25 min)
SHORT=1 node loadtest/run.mjs

# Validação rápida do pipeline (~15 min, sem valor estatístico)
QUICK=1 node loadtest/run.mjs

# Só alguns cenários/serviços, ou mais rodadas
node loadtest/run.mjs --scenarios=http-ramp,queue-burst
node loadtest/run.mjs --services=go-http,nodejs-http
RUNS=5 node loadtest/run.mjs

# Retomar uma suíte interrompida (pula rodadas já salvas)
node loadtest/run.mjs --resume=<suiteId>

# Relatório (padrão: a suíte mais recente)
node loadtest/report.mjs [suiteId]
```

O orquestrador reconstrói as imagens no início. Use `--skip-build` para pular.

### Relatório

`node loadtest/report.mjs [suiteId]` gera dois arquivos em `loadtest/results/<suite>/`:

| Arquivo | Uso |
|---|---|
| `report.html` | abrir localmente no navegador; funciona offline, com o Chart.js embutido (cache em `loadtest/vendor/`) |
| `report.artifact.html` | versão para publicar como página compartilhável |

```sh
# Windows (Git Bash) — abre o relatório mais recente
start "" "$(ls -d loadtest/results/*/ | grep -v discarded | tail -1)report.html"
```

### Cenários

| Cenário | Completo (3 rodadas) | Curto (`SHORT=1`, 1 rodada) |
|---|---|---|
| `http-baseline` | 200 req/s constantes por 2 min | 200 req/s por 1 min |
| `http-ramp` | 0 → 1500 req/s em 5 min, 2 min no pico | 0 → 1500 req/s em 90 s, 30 s no pico |
| `http-stress` | 100 → 12000 req/s em 6 min | 100 → 12000 req/s em 2 min |
| `queue-burst` | 100 mil mensagens de uma vez | 30 mil mensagens |
| `queue-sustained` | 800 msg/s por 5 min | 800 msg/s por 90 s |

Com uma única rodada o relatório não tem desvio padrão: diferenças grandes são confiáveis,
diferenças pequenas podem ser oscilação do ambiente.

### Como cada rodada funciona

1. Desinstala os 4 serviços e instala só o testado, do zero (2 pods, HPA/KEDA sem histórico).
2. Nos listeners, espera os 2 consumidores conectarem e esvazia a fila.
3. Espera 30 s em repouso para medir CPU e memória ociosas.
4. Aplica a carga com um Job no cluster:
   - **HTTP**: k6 com taxa de chegada controlada; as métricas chegam ao Prometheus em tempo real.
   - **Filas**: o publicador Go envia as mensagens; a medição vai até a fila zerar (estatísticas do RabbitMQ a cada 1 s).
5. Coleta do Prometheus: CPU, memória, réplicas, filas, latência e vazão.

A ordem dos serviços alterna a cada rodada (Node→Go, Go→Node, …), para que
variações do ambiente afetem os dois por igual.

### Métricas do relatório

- **Resposta (HTTP)**: latência média, p50, p95, p99 e máxima; vazão média e de pico; taxa de erro;
  requisições não enviadas (saturação).
- **Processamento (filas)**: tempo para processar tudo, vazão em msg/s, pico de mensagens na fila.
- **Recursos**: CPU consumida (cpu·s), CPU média e de pico, memória total e por pod, memória em repouso.
- **Escala**: pods no pico, tempo até o 1º scale-up, pod-segundos (indicador de custo), tempo de subida de um pod novo.
- **Eficiência**: requisições ou mensagens por segundo de CPU.

## Anotações de Go

Comandos:

- `go run .` — roda um módulo
- `go mod init module/name` — inicia um go mod
- `go mod tidy` — organiza as dependências no go.mod e no go.sum
- `go build` — gera o executável

Arquivos relevantes:

| Arquivo / diretório | Para que serve |
|---|---|
| `go.mod` | Define o módulo, versão do Go e dependências |
| `go.sum` | Registra hashes das dependências para garantir integridade/reprodutibilidade |
| `*.go` | Código-fonte Go |
| `*_test.go` | Testes automatizados |
| `vendor/` | Cópia local das dependências, quando o projeto usa vendoring |
| `go.work` | Gerencia múltiplos módulos Go em um workspace |
| `go.work.sum` | Checksums usados pelo workspace |
| `.go` com `//go:build` | Código condicionado a determinada plataforma/configuração |
| `Makefile` | Não é específico do Go, mas é comum para padronizar comandos do projeto |
| `Dockerfile` | Também não é específico do Go, mas é muito comum para build/deploy |

Estrutura de projeto:

- `cmd/` — entrypoints
- `internal/` — código que pertence somente ao projeto em questão
- `pkg/` — pacotes que podem ser importados por outros projetos

<br>

---

Desenvolvido Por [Alessandro Massarotti Jr](https://github.com/Alessandro-Massarotti-Jr) 🤖
