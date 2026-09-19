# ── Estágio 1: BUILD ─────────────────────────────────────────────────────────
# Maven 3.9.9 satisfaz o requireMavenVersion do pom.xml (<maven.version>3.9.9</maven.version>).
# Eclipse Temurin 21 é a mesma família usada no estágio de runtime.
FROM maven:3.9.9-eclipse-temurin-21 AS builder

WORKDIR /app

# Copiar o pom.xml primeiro e baixar dependências offline.
# Esta layer é cacheada: rebuilds por mudança de código-fonte não reexecutam o download.
COPY pom.xml .
RUN mvn dependency:go-offline -q

# Copiar o restante do código e compilar sem rodar os testes.
COPY src ./src
RUN mvn clean package -DskipTests -q

# ── Estágio 2: RUNTIME ───────────────────────────────────────────────────────
# Imagem final leve: apenas o JRE (sem JDK, sem Maven).
# Jammy (Ubuntu 22.04 LTS) = base estável e auditada.
FROM eclipse-temurin:21-jre-jammy AS runtime

# ── Labels OCI ───────────────────────────────────────────────────────────────
# Permitem rastrear qual build está em execução via `docker inspect`,
# e podem ser expostos como label service_version nos dashboards Grafana/Prometheus.
LABEL org.opencontainers.image.version="4.0.2"
LABEL org.opencontainers.image.title="spring-petclinic-rest"
LABEL org.opencontainers.image.description="Spring PetClinic REST API — TCC benchmark target"
LABEL org.opencontainers.image.source="https://github.com/spring-petclinic/spring-petclinic-rest"

WORKDIR /app

# Copiar somente o fat-jar gerado; tudo do estágio builder é descartado.
COPY --from=builder /app/target/*.jar app.jar

# Porta padrão da aplicação (definida em application.properties: server.port=9966).
# Pode ser sobrescrita via SERVER_PORT no docker-compose sem alterar este arquivo.
EXPOSE 9966

ENTRYPOINT ["java", "-jar", "app.jar"]
