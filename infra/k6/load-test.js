// ─────────────────────────────────────────────────────────────────────────────
// Script de Carga — TCC: Métricas de Refatoração (Spring PetClinic REST)
// ─────────────────────────────────────────────────────────────────────────────
//
// Exercita 6 endpoints críticos + 1 baseline de infraestrutura, cobrindo
// as anotações @Observed que geram spans Prometheus para as fitness functions.
//
// Endpoints e suas cadeias de observabilidade:
//   1. GET  /api/owners              → Controller_Owner_ListAll + Service_Owner_FindAll
//   2. POST /api/owners              → Controller_Owner_Add + Service_Owner_Save
//   3. GET  /api/owners/{ownerId}    → Controller_Owner_FindById + Service_Owner_FindById
//   4. POST /api/owners/{ownerId}/pets
//                                   → Controller_Pet_AddToOwner + Service_Owner_FindById
//                                     + Service_PetType_FindById + Service_Pet_Save
//   5. POST /api/owners/{ownerId}/pets/{petId}/visits
//                                   → Controller_Visit_AddToOwner + Service_Visit_Save
//   6. GET  /api/vets               → Controller_Vet_ListAll + Service_Vet_FindAll
//   7. GET  /actuator/health        → Baseline de latência do framework (sem @Observed)
//
// Perfil de carga — NÃO ALTERAR entre fases:
//   Cenário warmup:      ramping-vus 0→30 VUs em 30s (aquecimento JIT + cache)
//   Cenário steady_state: constant-arrival-rate 26 it/s por 12min
//     • rate 26/s: referência da branch mais lenta (~26 req/s observados)
//     • maxVUs 300: ≥ rate × p99_em_segundos (26 × ~10s + folga)
//     • preAllocatedVUs 100: absorve regime estável sem overhead de alocação
//
// Por que constant-arrival-rate (open-loop)?
//   O executor ramping-vus é closed-loop: o throughput varia com a latência
//   da aplicação, quebrando a premissa de "carga constante" necessária para
//   comparação de branches. Com constant-arrival-rate, o k6 dispara iterações
//   em taxa fixa independentemente da latência — se a aplicação travar, VUs
//   se acumulam, mas a taxa de chegada permanece constante.
//   Referência: k6 Docs — constant-arrival-rate executor, Dropped Iterations.
//
// Execução:
//   bash infra/scripts/run-benchmark.sh [baseline|pos-refatoracao]
//   docker compose --profile testing run --rm k6 run /scripts/load-test.js
//
// ⚠️  NÃO altere scenarios, thresholds nem payloads entre as fases.
// ─────────────────────────────────────────────────────────────────────────────

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import faker from "k6/x/faker";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";

// ── Métricas customizadas (metodologia RED expandida) ────────────────────────
// Trends com true = habilita percentis (p50, p90, p95, p99) no relatório k6.
// p99 alimenta LatencyFitnessFunction; p95 mantido para comparação histórica.
const latenciaListarOwners   = new Trend("latencia_listar_owners",   true);
const latenciaCriarOwner     = new Trend("latencia_criar_owner",     true);
const latenciaConsultarOwner = new Trend("latencia_consultar_owner", true);
const latenciaCriarPet       = new Trend("latencia_criar_pet",       true);
const latenciaCriarVisit     = new Trend("latencia_criar_visit",     true);
const latenciaListarVets     = new Trend("latencia_listar_vets",     true);
const latenciaHealth         = new Trend("latencia_health",          true);

// Taxa de erro GLOBAL (usado por ReliabilityFitnessFunction)
const taxaErroGlobal = new Rate("taxa_erro");

// Taxa de erro POR ENDPOINT — permite isolar qual endpoint degrada primeiro
const erroListarOwners   = new Rate("erro_listar_owners");
const erroCriarOwner     = new Rate("erro_criar_owner");
const erroConsultarOwner = new Rate("erro_consultar_owner");
const erroCriarPet       = new Rate("erro_criar_pet");
const erroCriarVisit     = new Rate("erro_criar_visit");
const erroListarVets     = new Rate("erro_listar_vets");

// Counters de escritas bem-sucedidas (throughput útil)
const ownersCriados  = new Counter("owners_criados_com_sucesso");
const petsCriados    = new Counter("pets_criados_com_sucesso");
const visitsCriadas  = new Counter("visits_criadas_com_sucesso");

// ── Configuração ─────────────────────────────────────────────────────────────
const HOST_BASE_URL      = "http://localhost:9966/petclinic/api";
const HOST_ACTUATOR_URL  = "http://localhost:9966/petclinic/actuator";
const SERVICE_BASE_URL   = "http://petclinic-api:9966/petclinic/api";
const SERVICE_ACTUATOR_URL = "http://petclinic-api:9966/petclinic/actuator";

export function setup() {
  if (__ENV.BASE_URL || __ENV.ACTUATOR_URL) {
    return {
      baseUrl:    __ENV.BASE_URL    || HOST_BASE_URL,
      actuatorUrl: __ENV.ACTUATOR_URL || HOST_ACTUATOR_URL,
    };
  }

  const candidates = [
    { baseUrl: SERVICE_BASE_URL,  actuatorUrl: SERVICE_ACTUATOR_URL },
    { baseUrl: HOST_BASE_URL,     actuatorUrl: HOST_ACTUATOR_URL },
  ];

  for (const candidate of candidates) {
    const health = http.get(`${candidate.actuatorUrl}/health`);
    if (health.status === 200) return candidate;
  }

  return candidates[1];
}

const HEADERS = {
  headers: { "Content-Type": "application/json", Accept: "application/json" },
};

// ── IDs do seed data ─────────────────────────────────────────────────────────
const SEED_OWNER_IDS = Array.from({ length: 10 }, (_, i) => i + 1);
const SEED_PET_IDS   = Array.from({ length: 13 }, (_, i) => i + 1);
const PET_TYPES = [
  { id: 1, name: "cat" },
  { id: 2, name: "dog" },
  { id: 3, name: "lizard" },
  { id: 4, name: "snake" },
  { id: 5, name: "bird" },
  { id: 6, name: "hamster" },
];

// ── Perfil de carga (scenarios) ──────────────────────────────────────────────
//
// Dois cenários separados com tags de fase:
//   warmup      → {phase:"warmup"}  EXCLUÍDO dos thresholds de latência
//   steady_state → {phase:"test"}   INCLUÍDO nos thresholds
//
// Parâmetros steady_state justificados:
//   rate=26:           taxa da branch mais lenta (~26 req/s observados em
//                      refactoring-metrics-intentional-code-smells).
//                      Garante que TODAS as branches honrem a taxa sem
//                      gerar dropped iterations na branch degradada.
//                      Usar >26 forçaria maxVUs crescente e contaminaria
//                      a comparação com artefatos de alocação de VU.
//
//   maxVUs=300:        regra prática: maxVUs ≥ rate × p99_em_segundos.
//                      Com p99 ~10s (pior caso degradado) e rate 26/s:
//                      maxVUs ≥ 26 × 10 = 260 → 300 com folga de segurança.
//                      Previne k6 de não conseguir honrar a taxa por falta
//                      de VUs disponíveis (dropped iterations por VU starvation).
//
//   preAllocatedVUs=100: estimativa de VUs em regime estável.
//                        Com p50 ~200ms e rate 26/s, VUs em uso ≈ 26 × 0.2 = 5.
//                        Com p99 ~4s (branch boa): 26 × 4 = 104 VUs.
//                        100 VUs pré-alocados evitam custo de alocação JIT
//                        nas primeiras medições, que contaminariam o p95/p99.
//
// Nota: sem cenário de spike separado. Com open-loop, o "spike" é observável
// pelo acúmulo de VUs quando a aplicação degrada — VUs em uso sobe, p99 sobe,
// mas a taxa de chegada permanece 26/s. Se um spike controlado for necessário,
// adicionar um 3º cenário com startTime posterior e rate diferente.
export const options = {
  scenarios: {
    // Warm-up: ramping-vus é correto aqui — queremos VUs crescentes para
    // aquecer a JVM (JIT compilation) e o cache Spring (Cache-Aside warm-up).
    warmup: {
      executor:         "ramping-vus",
      startVUs:         0,
      stages:           [{ duration: "30s", target: 30 }],
      gracefulRampDown: "5s",
      tags:             { phase: "warmup" },
    },

    // Teste principal: open-loop com taxa constante (constant-arrival-rate).
    // Referência: k6 Docs — "constant-arrival-rate executor" e
    // "Dropped iterations > Configuration-related iteration drops".
    steady_state: {
      executor:        "constant-arrival-rate",
      startTime:       "35s",     // 30s warmup + 5s gracefulRampDown
      rate:            26,         // 26 it/s — taxa da branch mais lenta
      timeUnit:        "1s",
      duration:        "12m",
      preAllocatedVUs: 100,        // ≈ rate × p99_boa (26 × 4s = 104)
      maxVUs:          300,        // ≥ rate × p99_pior (26 × 10s = 260)
      tags:            { phase: "test" },
      gracefulStop:    "10s",
    },
  },

  thresholds: {
    // Threshold global de segurança
    http_req_duration: ["p(95)<5000"],
    taxa_erro:         ["rate<0.10"],

    // Thresholds p95 + p99 por endpoint — aplicam apenas à fase "test"
    // Ambas as métricas na mesma chave: k6 avalia TODAS antes de falhar.
    // p95: comparação histórica | p99: LatencyFitnessFunction (conservador)
    "latencia_listar_owners{phase:test}":   ["p(95)<4000", "p(99)<5000"],
    "latencia_criar_owner{phase:test}":     ["p(95)<3000", "p(99)<4000"],
    "latencia_consultar_owner{phase:test}": ["p(95)<3000", "p(99)<4000"],
    "latencia_criar_pet{phase:test}":       ["p(95)<3000", "p(99)<4000"],
    "latencia_criar_visit{phase:test}":     ["p(95)<3000", "p(99)<4000"],
    "latencia_listar_vets{phase:test}":     ["p(95)<2000", "p(99)<3000"],

    // Taxa de erro por endpoint → ReliabilityFitnessFunction
    "erro_listar_owners{phase:test}":   ["rate<0.10"],
    "erro_criar_owner{phase:test}":     ["rate<0.10"],
    "erro_consultar_owner{phase:test}": ["rate<0.10"],
    "erro_criar_pet{phase:test}":       ["rate<0.10"],
    "erro_criar_visit{phase:test}":     ["rate<0.10"],
    "erro_listar_vets{phase:test}":     ["rate<0.10"],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseJson(body) {
  try   { return JSON.parse(body); }
  catch { return null; }
}

// ── Função de iteração principal ─────────────────────────────────────────────
export default function loadTestScenario(data) {
  const BASE_URL     = data?.baseUrl     || SERVICE_BASE_URL;
  const ACTUATOR_URL = data?.actuatorUrl || SERVICE_ACTUATOR_URL;

  let createdOwnerId = null;
  let createdPetId   = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. GET /owners — Listar todos os donos
  // ─────────────────────────────────────────────────────────────────────────
  // @Observed: Controller_Owner_ListAll → Service_Owner_FindAll (2 spans)
  // Endpoint crítico: volume cresce com owners criados durante o teste.
  // pos-refactoring: JOIN FETCH elimina N+1 implícito do Hibernate.
  // ═══════════════════════════════════════════════════════════════════════════
  group("GET /owners", function () {
    const res = http.get(`${BASE_URL}/owners`, HEADERS);
    latenciaListarOwners.add(res.timings.duration);

    const ok = check(res, {
      "listar-owners: status 200":   (r) => r.status === 200,
      "listar-owners: body é array": (r) => Array.isArray(parseJson(r.body)),
      "listar-owners: array não-vazio": (r) => {
        const d = parseJson(r.body);
        return Array.isArray(d) && d.length > 0;
      },
    });
    taxaErroGlobal.add(!ok);
    erroListarOwners.add(!ok);
  });

  sleep(0.2);

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. POST /owners — Criar dono
  // ─────────────────────────────────────────────────────────────────────────
  // @Observed: Controller_Owner_Add → Service_Owner_Save (2 spans)
  // Escritas crescem durante o teste — aumenta volume de GET /owners.
  // ═══════════════════════════════════════════════════════════════════════════
  group("POST /owners", function () {
    const cleanName = (name) => {
      const cleaned = name.replace(/[^a-zA-Z]/g, "");
      return cleaned.length > 0 ? cleaned : "John";
    };
    const rawPhone = faker.person.phone() || "1234567890";
    const phone = rawPhone.replace(/\D/g, "").substring(0, 10).padStart(10, "0");

    const payload = JSON.stringify({
      firstName: cleanName(faker.person.firstName()),
      lastName:  cleanName(faker.person.lastName()),
      address:   faker.address.street() || `Street ${__ITER}`,
      city:      faker.address.city()   || "City",
      telephone: phone,
    });

    const res = http.post(`${BASE_URL}/owners`, payload, HEADERS);
    latenciaCriarOwner.add(res.timings.duration);

    const ok = check(res, {
      "criar-owner: status 201": (r) => r.status === 201,
      "criar-owner: body tem id": (r) => {
        const d = parseJson(r.body);
        return d !== null && typeof d.id === "number";
      },
    });
    taxaErroGlobal.add(!ok);
    erroCriarOwner.add(!ok);

    if (ok) {
      ownersCriados.add(1);
      const d = parseJson(res.body);
      if (d) createdOwnerId = d.id;
    }
  });

  sleep(0.2);

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. GET /owners/{ownerId} — Consultar dono por ID
  // ─────────────────────────────────────────────────────────────────────────
  // @Observed: Controller_Owner_FindById → Service_Owner_FindById (2 spans)
  // JOIN FETCH em findById já existia na branch original — otimização mantida.
  // ═══════════════════════════════════════════════════════════════════════════
  group("GET /owners/{ownerId}", function () {
    const ownerId = createdOwnerId || randomFrom(SEED_OWNER_IDS);
    const res = http.get(`${BASE_URL}/owners/${ownerId}`, HEADERS);
    latenciaConsultarOwner.add(res.timings.duration);

    const ok = check(res, {
      "consultar-owner: status 200": (r) => r.status === 200,
      "consultar-owner: tem firstName": (r) => {
        const d = parseJson(r.body);
        return d !== null && d.firstName !== undefined;
      },
    });
    taxaErroGlobal.add(!ok);
    erroConsultarOwner.add(!ok);
  });

  sleep(0.2);

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. POST /owners/{ownerId}/pets — Adicionar pet
  // ─────────────────────────────────────────────────────────────────────────
  // @Observed: Controller_Pet_AddToOwner → Service_Owner_FindById
  //            → Service_PetType_FindById → Service_Pet_Save (4 spans)
  // pos-refactoring: PetType servido do cache após warm-up → 0 queries DB.
  // ═══════════════════════════════════════════════════════════════════════════
  group("POST /owners/{ownerId}/pets", function () {
    const ownerId = createdOwnerId || randomFrom(SEED_OWNER_IDS);
    const petType = randomFrom(PET_TYPES);

    let petName;
    try   { petName = faker.animal.dog(); }
    catch { petName = faker.person.firstName(); }

    const year  = 2015 + Math.floor(Math.random() * 8);
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
    const day   = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");

    const payload = JSON.stringify({
      name:      petName.replace(/[^a-zA-Z]/g, "") || "Rex",
      birthDate: `${year}-${month}-${day}`,
      type:      petType,
    });

    const res = http.post(`${BASE_URL}/owners/${ownerId}/pets`, payload, HEADERS);
    latenciaCriarPet.add(res.timings.duration);

    const ok = check(res, {
      "criar-pet: status 201": (r) => r.status === 201,
      "criar-pet: body tem id": (r) => {
        const d = parseJson(r.body);
        return d !== null && typeof d.id === "number";
      },
    });
    taxaErroGlobal.add(!ok);
    erroCriarPet.add(!ok);

    if (ok) {
      petsCriados.add(1);
      const d = parseJson(res.body);
      if (d) createdPetId = d.id;
    }
  });

  sleep(0.2);

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. POST /owners/{ownerId}/pets/{petId}/visits — Criar visita
  // ─────────────────────────────────────────────────────────────────────────
  // @Observed: Controller_Visit_AddToOwner → Service_Visit_Save (2 spans)
  // ═══════════════════════════════════════════════════════════════════════════
  group("POST /owners/{ownerId}/pets/{petId}/visits", function () {
    const ownerId = createdOwnerId || randomFrom(SEED_OWNER_IDS);
    const petId   = createdPetId   || randomFrom(SEED_PET_IDS);

    const ano = 2024 + Math.floor(Math.random() * 2);
    const mes = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
    const dia = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");

    const descWords = [
      "Routine checkup", "Vaccination", "Dental cleaning",
      "Blood test",      "Dermatology",
    ];
    const payload = JSON.stringify({
      date:        `${ano}-${mes}-${dia}`,
      description: randomFrom(descWords) + " by " + faker.person.lastName(),
    });

    const res = http.post(
      `${BASE_URL}/owners/${ownerId}/pets/${petId}/visits`,
      payload,
      HEADERS,
    );
    latenciaCriarVisit.add(res.timings.duration);

    const ok = check(res, {
      "criar-visit: status 201": (r) => r.status === 201,
      "criar-visit: body tem id": (r) => {
        const d = parseJson(r.body);
        return d !== null && typeof d.id === "number";
      },
    });
    taxaErroGlobal.add(!ok);
    erroCriarVisit.add(!ok);

    if (ok) visitsCriadas.add(1);
  });

  sleep(0.2);

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. GET /vets — Listar veterinários
  // ─────────────────────────────────────────────────────────────────────────
  // @Observed: Controller_Vet_ListAll → Service_Vet_FindAll (2 spans)
  // pos-refactoring: resultado cacheado após warm-up → 0 queries DB.
  // ═══════════════════════════════════════════════════════════════════════════
  group("GET /vets", function () {
    const res = http.get(`${BASE_URL}/vets`, HEADERS);
    latenciaListarVets.add(res.timings.duration);

    const ok = check(res, {
      "listar-vets: status 200": (r) => r.status === 200,
    });
    taxaErroGlobal.add(!ok);
    erroListarVets.add(!ok);
  });

  sleep(0.2);

  // ═══════════════════════════════════════════════════════════════════════════
  // BASELINE: GET /actuator/health
  // ─────────────────────────────────────────────────────────────────────────
  // Latência do framework puro — normaliza o overhead de infraestrutura.
  // ═══════════════════════════════════════════════════════════════════════════
  group("GET /actuator/health", function () {
    const res = http.get(`${ACTUATOR_URL}/health`);
    latenciaHealth.add(res.timings.duration);

    check(res, { "health: status 200": (r) => r.status === 200 });
    taxaErroGlobal.add(res.status !== 200);
  });

  // Sleep adaptativo: sob alta carga, reduz para não segurar VUs além do necessário
  sleep(__VU > 80 ? 0.1 : 0.3);
}

// ── Exportação de Resultados ─────────────────────────────────────────────────
//
// handleSummary() recebe o objeto `data` com TODOS os dados agregados ao final
// do teste. O problema do JSON.stringify(data) original: os thresholds só
// exportam { ok: boolean } — não os valores numéricos reais de p95/p99.
//
// Solução: extrair manualmente p95 e p99 de cada Trend via data.metrics[name].
// A estrutura de cada Trend no objeto `data` é:
//   data.metrics["latencia_listar_owners"].values["p(95)"] → número em ms
//   data.metrics["latencia_listar_owners"].values["p(99)"] → número em ms
//
// O summary.json gerado tem duas seções:
//   1. "resumo_por_endpoint": objeto estruturado com p95, p99, avg, erro_rate
//      por endpoint — para análise direta em Python/Pandas sem parsing.
//   2. "raw": objeto data completo do k6 — para auditoria e cálculos adicionais.
//
// Referência: k6 Docs — "handleSummary() data structure", custom-summary.md
// ─────────────────────────────────────────────────────────────────────────────
export function handleSummary(data) {
  // Extrai valores numéricos de um Trend por nome de métrica
  function extractTrend(metricName) {
    const m = data.metrics[metricName];
    if (!m || !m.values) return null;
    const v = m.values;
    return {
      count: v.count            ?? null,
      avg:   roundMs(v.avg),
      min:   roundMs(v.min),
      med:   roundMs(v.med),
      max:   roundMs(v.max),
      p90:   roundMs(v["p(90)"]),
      p95:   roundMs(v["p(95)"]),
      p99:   roundMs(v["p(99)"]),
    };
  }

  // Extrai taxa de erro de um Rate por nome de métrica
  function extractRate(metricName) {
    const m = data.metrics[metricName];
    if (!m || !m.values) return null;
    return {
      rate:  parseFloat((m.values.rate  ?? 0).toFixed(6)),
      fails: m.values.fails ?? null,
      passes: m.values.passes ?? null,
    };
  }

  // Arredonda para 2 casas decimais (ms)
  function roundMs(val) {
    return val != null ? parseFloat(val.toFixed(2)) : null;
  }

  // Extrai status de threshold por nome completo do threshold
  function thresholdOk(metricKey, expr) {
    const m = data.metrics[metricKey];
    if (!m || !m.thresholds) return null;
    return m.thresholds[expr]?.ok ?? null;
  }

  // ── Resumo estruturado por endpoint ────────────────────────────────────────
  const endpoints = [
    { name: "GET /owners",                         trend: "latencia_listar_owners",   erro: "erro_listar_owners"   },
    { name: "POST /owners",                        trend: "latencia_criar_owner",     erro: "erro_criar_owner"     },
    { name: "GET /owners/{ownerId}",               trend: "latencia_consultar_owner", erro: "erro_consultar_owner" },
    { name: "POST /owners/{ownerId}/pets",         trend: "latencia_criar_pet",       erro: "erro_criar_pet"       },
    { name: "POST /owners/{ownerId}/pets/{petId}/visits", trend: "latencia_criar_visit", erro: "erro_criar_visit"  },
    { name: "GET /vets",                           trend: "latencia_listar_vets",     erro: "erro_listar_vets"     },
    { name: "GET /actuator/health",                trend: "latencia_health",          erro: null                   },
  ];

  const resumoPorEndpoint = {};
  for (const ep of endpoints) {
    resumoPorEndpoint[ep.name] = {
      latencia_ms:  extractTrend(ep.trend),
      erro:         ep.erro ? extractRate(ep.erro) : null,
    };
  }

  // ── Resumo global ───────────────────────────────────────────────────────────
  const httpReqDuration = extractTrend("http_req_duration");
  const taxaErro        = extractRate("taxa_erro");

  // ── Métricas de dropped iterations (indicador de saturação) ────────────────
  const droppedIterations = data.metrics["dropped_iterations"]
    ? data.metrics["dropped_iterations"].values
    : { count: 0 };

  // ── Status dos thresholds por endpoint ────────────────────────────────────
  // Recalculados a partir dos valores reais (não apenas ok/fail)
  const thresholdStatus = {
    "GET /owners":       {
      "p(95)<4000": thresholdOk("latencia_listar_owners{phase:test}", "p(95)<4000"),
      "p(99)<5000": thresholdOk("latencia_listar_owners{phase:test}", "p(99)<5000"),
    },
    "POST /owners":      {
      "p(95)<3000": thresholdOk("latencia_criar_owner{phase:test}", "p(95)<3000"),
      "p(99)<4000": thresholdOk("latencia_criar_owner{phase:test}", "p(99)<4000"),
    },
    "GET /owners/{id}":  {
      "p(95)<3000": thresholdOk("latencia_consultar_owner{phase:test}", "p(95)<3000"),
      "p(99)<4000": thresholdOk("latencia_consultar_owner{phase:test}", "p(99)<4000"),
    },
    "POST /pets":        {
      "p(95)<3000": thresholdOk("latencia_criar_pet{phase:test}", "p(95)<3000"),
      "p(99)<4000": thresholdOk("latencia_criar_pet{phase:test}", "p(99)<4000"),
    },
    "POST /visits":      {
      "p(95)<3000": thresholdOk("latencia_criar_visit{phase:test}", "p(95)<3000"),
      "p(99)<4000": thresholdOk("latencia_criar_visit{phase:test}", "p(99)<4000"),
    },
    "GET /vets":         {
      "p(95)<2000": thresholdOk("latencia_listar_vets{phase:test}", "p(95)<2000"),
      "p(99)<3000": thresholdOk("latencia_listar_vets{phase:test}", "p(99)<3000"),
    },
  };

  // ── Objeto final do summary.json ───────────────────────────────────────────
  const summaryJson = {
    // Metadados da execução
    meta: {
      gerado_em: new Date().toISOString(),
      executor:  "constant-arrival-rate",
      rate_por_segundo: 26,
      duracao:   "12m",
      preAllocatedVUs: 100,
      maxVUs:    300,
    },
    // Resumo estruturado por endpoint (p95, p99 numéricos diretos)
    resumo_por_endpoint: resumoPorEndpoint,
    // Métricas globais
    global: {
      http_req_duration: httpReqDuration,
      taxa_erro_global:  taxaErro,
      dropped_iterations: droppedIterations,
      counters: {
        owners_criados_com_sucesso:  data.metrics["owners_criados_com_sucesso"]?.values?.count  ?? 0,
        pets_criados_com_sucesso:    data.metrics["pets_criados_com_sucesso"]?.values?.count    ?? 0,
        visits_criadas_com_sucesso:  data.metrics["visits_criadas_com_sucesso"]?.values?.count  ?? 0,
      },
    },
    // Status dos thresholds com valores numéricos reais acima
    threshold_status: thresholdStatus,
    // Raw completo do k6 para auditoria (inclui todos os valores e thresholds)
    raw: data,
  };

  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "/results/summary.json": JSON.stringify(summaryJson, null, 2),
  };
}
