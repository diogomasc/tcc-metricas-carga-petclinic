# Análise Estática — ISO 25010 (Manutenibilidade)

Documentação técnica da infraestrutura de análise estática do Spring PetClinic REST, configurada com **PMD 7.x** (microestrutural) e **ArchUnit 1.3.0** (macro-arquitetural), mapeada para as subcaracterísticas de **Manutenibilidade** da ISO/IEC 25010.

---

## 1. Visão Geral da Análise Estática

A análise estática automatiza a detecção de anomalias estruturais no código, transformando características de manutenibilidade em métricas objetivas. A abordagem combina duas ferramentas com diferentes níveis de granularidade:

- **PMD:** detecta anomalias **microestruturais** (dentro de métodos e classes, como complexidade ciclomática e acoplamento entre classes).
- **ArchUnit:** valida regras **macroarquiteturais** (isolamento entre camadas, ausência de dependências cíclicas e estabilidade de pacotes).

### Pipeline de Análise

```mermaid
flowchart LR
    subgraph "Entrada"
        SRC["Código-fonte\n(Java)"]
    end

    subgraph "Análise Micro (PMD)"
        RS["ruleset.xml\n(8 regras)"]
        PMD["maven-pmd-plugin\n3.26.0"]
        CSV["target/site/pmd.csv"]
    end

    subgraph "Análise Macro (ArchUnit)"
        TEST["ValidacaoArquiteturalTest\n(JUnit 5)"]
        ARCH["ArchUnit 1.3.0"]
        LOG["Console + Surefire"]
    end

    subgraph "Correlação"
        TAB["Tabulação\n(CSV + Console)"]
        ISO["Relatório\nISO 25010"]
        DYN["Análise Dinâmica\n(K6 + @Observed)"]
    end

    SRC --> RS --> PMD --> CSV --> TAB
    SRC --> TEST --> ARCH --> LOG --> TAB
    TAB --> ISO
    TAB --> DYN
```

---

## 2. Mapeamento ISO 25010 → Ferramentas

A ISO/IEC 25010 define Manutenibilidade por subcaracterísticas. Cada regra de análise estática mapeia para a característica correspondente:

| Subcaracterística | Métrica / Code Smell | Ferramenta | Regra | Critério Técnico |
|---|---|---|---|---|
| **Modularidade** | God Class | PMD | `GodClass` | Classe com excesso de responsabilidades (WMC alto, TCC baixo) |
| **Modularidade** | LOC (Excessive Class) | PMD | XPath custom | Limite de tamanho por arquivo (> 300 linhas) |
| **Analisabilidade** | Long Method | PMD | `NcssCount` + XPath | Limite de tamanho por método (> 50 linhas ou > 40 statements) |
| **Analisabilidade** | Complexidade Ciclomática | PMD | `CyclomaticComplexity` | Risco de caminhos de execução excessivos (CC > 10) |
| **Analisabilidade** | Feature Envy | PMD | `LawOfDemeter` | Acessos encadeados a propriedades de objetos externos |
| **Modularidade** | Data Class | PMD | `DataClass` | Classes com dados e sem comportamento de negócio |
| **Modularidade** | CBO | PMD | `CouplingBetweenObjects` | Acoplamento excessivo entre tipos (> 20 dependências) |
| **Modularidade** | Dispersed Coupling | ArchUnit | Isolamento de camadas | Restrição de acoplamento direto entre camadas não adjacentes |
| **Modificabilidade** | Shotgun Surgery | ArchUnit | Service ✗→ Controller | Dependência invertida exigindo alterações em múltiplos pontos |
| **Modularidade** | Acoplamento Cíclico | ArchUnit | `beFreeOfCycles()` | Ausência de referências circulares entre pacotes |
| **Reusabilidade** | Ca/Ce (Fan-In/Out) | ArchUnit | `ArchitectureMetrics` | Avaliação de estabilidade e instabilidade de pacotes |

---

## 3. PMD — Configuração Microestrutural

### 3.1. Limiares Adotados

| Métrica | Limiar | Critério |
|---|---|---|
| **CC** (Complexidade Ciclomática) | ≤ 10 por método | Limite clássico para evitar excesso de caminhos condicionais e testes |
| **CBO** (Coupling Between Objects) | ≤ 20 por classe | Limiar para evitar classes com excesso de dependências externas |
| **LOC** (Classe) | ≤ 300 linhas | Limite para prevenir acúmulo excessivo de código em um único arquivo |
| **LOC** (Método) | ≤ 50 linhas | Prevenção de métodos excessivamente longos |
| **NCSS** (Method) | ≤ 40 statements | Contagem de declarações executáveis sem linhas em branco |

> **Nota sobre PMD 7.x:** As regras `ExcessiveMethodLength` e `ExcessiveClassLength` foram removidas no PMD 7. Foram reimplementadas via XPath: `//MethodDeclaration[@EndLine - @BeginLine > 50]` e `//TypeDeclaration[@EndLine - @BeginLine > 300]`.

### 3.2. Plugin Maven

```xml
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-pmd-plugin</artifactId>
    <version>3.26.0</version>
    <configuration>
        <rulesets>
            <ruleset>${project.basedir}/ruleset.xml</ruleset>
        </rulesets>
        <format>csv</format>
        <targetDirectory>${project.build.directory}/site</targetDirectory>
        <failOnViolation>false</failOnViolation>
    </configuration>
</plugin>
```

### 3.3. Comando de Execução

```bash
./mvnw clean compile pmd:pmd       # Gera CSV
./mvnw pmd:check -Dpmd.logViolationsToConsole=true  # Visualiza no terminal
```

---

## 4. ArchUnit — Configuração Macro-Arquitetural

### 4.1. Regras Implementadas

#### Isolamento de Camadas

Cada regra protege um invariante arquitetural, assegurando que as dependências sigam a direção da abstração:

| Regra | Verificação | Subcaracterística ISO 25010 |
|---|---|---|
| `controllers_nao_acessam_repositories` | Controller ✗→ Repository | Modularidade |
| `repositories_nao_acessam_controllers` | Repository ✗→ Controller | Modularidade |
| `repositories_nao_acessam_services` | Repository ✗→ Service | Modularidade |
| `services_nao_acessam_controllers` | Service ✗→ Controller | Modificabilidade |
| `model_nao_depende_de_camadas_superiores` | Model ✗→ tudo | Modularidade (DDD) |

#### Acoplamento Cíclico

```java
slices()
    .matching("org.springframework.samples.petclinic.(*)..") 
    .should().beFreeOfCycles()
    .ignoreDependency(resideInAPackage("..mapper.."), resideInAPackage("..rest.dto.."))
    .ignoreDependency(resideInAPackage("..mapper.."), resideInAPackage("..rest.api.."))
```

> O ciclo `mapper ↔ rest.dto` é excluído porque os DTOs são **gerados** pelo OpenAPI Generator — não representam débito técnico da lógica de negócios, tratando-se de acoplamento acidental decorrente de geração de código.

#### Métricas Ca/Ce

| Métrica | Significado | Interpretação |
|---|---|---|
| **Ca** (Afferent) | Quantos pacotes dependem deste | Alto Ca = componente estável (difícil de mudar sem impacto) |
| **Ce** (Efferent) | De quantos pacotes este depende | Alto Ce = componente instável (sensível a mudanças externas) |
| **I** = Ce/(Ca+Ce) | Instabilidade | I=0 (máxima estabilidade) a I=1 (máxima instabilidade) |

---

## 5. Resultados do Código Original (Fork)

Os resultados abaixo refletem o estado do código **como herdado do fork** upstream, sem nenhuma alteração de lógica de negócio. Eles servem como registro das características estruturais do projeto original, validando que as ferramentas de análise estão corretamente configuradas.

### 5.1. PMD — Violações Detectadas (12 totais)

| # | Classe | Regra | Detalhe | Interpretação |
|---|---|---|---|---|
| 1–5 | Person, Pet, Role, User, Visit | DataClass | WOC baixo, NOAM alto | Entidades JPA são Data Classes por design — estruturam dados sem comportamentos de negócio complexos |
| 6 | JdbcPet | DataClass | WOC=0.0% | Classe auxiliar da implementação JDBC — irrelevante para o perfil ativo (spring-data-jpa) |
| 7–9 | JpaOwnerRepositoryImpl | LawOfDemeter | `getSingleResult` on foreign value (×3) | Violação do princípio do menor conhecimento: o repositório navega grafos de objetos ao invés de usar queries diretas |
| 10 | BindingError | DataClass | WOC=20.0% | DTO de validação — Data Class por definição |
| 11 | OwnerRestController | CBO=23 | Limiar: 20 | Controller depende de 23 tipos distintos — reflexo da API ampla |
| 12 | **ClinicServiceImpl** | **CBO=24** | **Limiar: 20** | **Façade com 6 repositórios injetados. Característica herdada do projeto original.** |

> **Observação:** O `ClinicServiceImpl` é a classe com maior CBO e é também o ponto central de instrumentação `@Observed`. Independente da estratégia experimental adotada (refatoração do código existente ou injeção de anomalias adicionais), essa classe será o principal alvo de análise de correlação estática ↔ dinâmica.

### 5.2. ArchUnit — Métricas de Acoplamento por Pacote (código original)

| Pacote | Ca | Ce | I (Instabilidade) | A (Abstração) | Análise |
|---|---|---|---|---|---|
| `model` | 5 | 0 | 0.000 | 0.000 | Máxima estabilidade — dependido por todos, depende de ninguém |
| `rest` | 1 | 3 | 0.750 | 0.263 | Alta instabilidade — esperado para camada de borda |
| `service` | 1 | 2 | 0.667 | 0.500 | Balanceado — mas Ce=2 baixo mascara o CBO=24 interno |
| `repository` | 1 | 2 | 0.667 | 0.462 | Abstração razoável (interfaces + implementações) |
| `config` | 0 | 0 | 1.000 | 0.000 | Isolado — correto para configuração |

### 5.3. ArchUnit — Status das Regras

| Regra | Status |
|---|---|
| Controllers ✗→ Repositories | ✅ PASS |
| Repositories ✗→ Controllers | ✅ PASS |
| Repositories ✗→ Services | ✅ PASS |
| Services ✗→ Controllers | ✅ PASS |
| Model ✗→ Camadas superiores | ✅ PASS |
| Ausência de Ciclos | ✅ PASS |

> Todas as regras passam, confirmando que o débito técnico do código original é **intra-classe** (CBO, Data Class) e não **inter-pacote** (ciclos, inversão de camadas). Essa distinção é relevante para o TCC: demonstra que as características estruturais de interesse residem no nível micro (design de classe), não no nível macro (arquitetura de pacotes).

---

## 6. Comandos Resumo

```bash
# PMD completa (gera CSV)
./mvnw clean compile pmd:pmd

# Violações no terminal
./mvnw pmd:check -Dpmd.logViolationsToConsole=true

# Formatar CSV
column -s, -t target/site/pmd.csv

# ArchUnit (validação + métricas)
./mvnw test -Dtest="ValidacaoArquiteturalTest" -Dsurefire.useFile=false

# Apenas métricas Ca/Ce
./mvnw test -Dtest="ValidacaoArquiteturalTest#extrairMetricasAcoplamento" -Dsurefire.useFile=false

# Build completo
./mvnw compile pmd:pmd && ./mvnw test -Dsurefire.useFile=false
```

---

## 7. Arquivos Criados/Modificados

| Arquivo | Ação | Finalidade |
|---|---|---|
| `ruleset.xml` | Criado | Ruleset PMD 7.x com mapeamento ISO 25010 |
| `pom.xml` | Modificado | Plugin PMD + dependência ArchUnit |
| `ValidacaoArquiteturalTest.java` | Criado | Testes ArchUnit (camadas + ciclos + métricas) |
| `docs/analise-estatica-iso25010.md` | Criado | Esta documentação |
