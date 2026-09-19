/*
 * Copyright 2026 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Teste de Validação Arquitetural – ISO 25010 (Manutenibilidade)
 * ================================================================
 * Verifica isolamento de camadas, ausência de ciclos e extrai métricas
 * de acoplamento aferente (Ca/Fan-In) e eferente (Ce/Fan-Out) por pacote.
 *
 * Mapeamento de Mitigação:
 *   - Isolamento de Camadas → mitiga "Dispersed Coupling" e "Shotgun Surgery"
 *   - Ciclos entre Pacotes  → mitiga dependências circulares (instabilidade)
 *   - Métricas Ca/Ce        → insumo para tabulação manual de acoplamento
 *
 * Referências Acadêmicas (Limiares):
 *   - CC ≤ 10  → McCabe, T. J. (1976). "A Complexity Measure". IEEE TSE.
 *   - CBO ≤ 20 → Chidamber, S. R.; Kemerer, C. F. (1994). "A Metrics Suite
 *                 for Object-Oriented Design". IEEE TSE, 20(6), pp. 476–493.
 *                 Valor conservador alinhado a Lanza & Marinescu (2006).
 */
package org.springframework.samples.petclinic.architecture;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.domain.JavaPackage;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.library.metrics.ArchitectureMetrics;
import com.tngtech.archunit.library.metrics.ComponentDependencyMetrics;
import com.tngtech.archunit.library.metrics.MetricsComponents;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static com.tngtech.archunit.core.domain.JavaClass.Predicates.resideInAPackage;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

/**
 * Validação Arquitetural do Spring PetClinic REST.
 * <p>
 * Regras verificadas:
 * <ul>
 *   <li>Isolamento de camadas (Controller → Service → Repository)</li>
 *   <li>Ausência de acoplamento cíclico entre pacotes de negócio</li>
 *   <li>Extração de métricas Ca (Fan-In) e Ce (Fan-Out) por pacote</li>
 * </ul>
 * <p>
 * <b>Nota:</b> Dependências de/para {@code rest.dto} e {@code rest.api} são excluídas da
 * verificação de ciclos, pois são código gerado automaticamente pelo OpenAPI Generator
 * e não representam débito técnico estrutural da lógica de negócios.
 */
@AnalyzeClasses(
    packages = "org.springframework.samples.petclinic",
    importOptions = ImportOption.DoNotIncludeTests.class
)
@DisplayName("Validação Arquitetural – ISO 25010")
class ValidacaoArquiteturalTest {

    private static final String BASE_PACKAGE = "org.springframework.samples.petclinic";

    // ── Constantes de pacote (evita duplicação de literals) ───────────────
    private static final String PKG_CONTROLLER = "..rest.controller..";
    private static final String PKG_SERVICE    = "..service..";
    private static final String PKG_REPOSITORY = "..repository..";
    private static final String PKG_CONFIG     = "..config..";
    private static final String PKG_MODEL      = "..model..";

    // ── Pacotes gerados pelo OpenAPI Generator (excluídos da análise de ciclos)
    private static final String PKG_REST_DTO = "..rest.dto..";
    private static final String PKG_REST_API = "..rest.api..";

    // ═══════════════════════════════════════════════════════════════════════
    // 1. ISOLAMENTO DE CAMADAS – Mitigação de Dispersed Coupling
    // ═══════════════════════════════════════════════════════════════════════

    @ArchTest
    static final ArchRule controllers_nao_acessam_repositories =
        noClasses()
            .that().resideInAPackage(PKG_CONTROLLER)
            .should().dependOnClassesThat().resideInAPackage(PKG_REPOSITORY)
            .because("Controllers devem delegar para a camada Service (Dispersed Coupling mitigation)");

    @ArchTest
    static final ArchRule repositories_nao_acessam_controllers =
        noClasses()
            .that().resideInAPackage(PKG_REPOSITORY)
            .should().dependOnClassesThat().resideInAPackage(PKG_CONTROLLER)
            .because("Repositories são a camada mais interna e não devem conhecer Controllers");

    @ArchTest
    static final ArchRule repositories_nao_acessam_services =
        noClasses()
            .that().resideInAPackage(PKG_REPOSITORY)
            .should().dependOnClassesThat().resideInAPackage(PKG_SERVICE)
            .because("Repositories não devem ter dependência ascendente para Services");

    // ═══════════════════════════════════════════════════════════════════════
    // 2. ISOLAMENTO DE CAMADAS – Mitigação de Shotgun Surgery
    // ═══════════════════════════════════════════════════════════════════════

    @ArchTest
    static final ArchRule services_nao_acessam_controllers =
        noClasses()
            .that().resideInAPackage(PKG_SERVICE)
            .should().dependOnClassesThat().resideInAPackage(PKG_CONTROLLER)
            .because("Services não devem conhecer a camada de apresentação (Shotgun Surgery mitigation)");

    @ArchTest
    static final ArchRule model_nao_depende_de_camadas_superiores =
        noClasses()
            .that().resideInAPackage(PKG_MODEL)
            .should().dependOnClassesThat().resideInAnyPackage(
                PKG_CONTROLLER,
                PKG_SERVICE,
                PKG_REPOSITORY,
                PKG_CONFIG
            )
            .because("Model (domínio) deve ser independente de infraestrutura");

    // ═══════════════════════════════════════════════════════════════════════
    // 3. ACOPLAMENTO CÍCLICO – Detecção de dependências circulares
    //    Exclui dependências de/para rest.dto e rest.api (código gerado
    //    pelo OpenAPI Generator), que não representam débito técnico
    //    estrutural da lógica de negócios.
    // ═══════════════════════════════════════════════════════════════════════

    @ArchTest
    static final ArchRule sem_ciclos_entre_pacotes =
        slices()
            .matching("org.springframework.samples.petclinic.(*)..")
            .should().beFreeOfCycles()
            .ignoreDependency(resideInAPackage(PKG_REST_DTO), resideInAPackage(PKG_REST_DTO))
            .ignoreDependency(resideInAPackage(PKG_REST_API), resideInAPackage(PKG_REST_API))
            .ignoreDependency(resideInAPackage("..mapper.."), resideInAPackage(PKG_REST_DTO))
            .ignoreDependency(resideInAPackage("..mapper.."), resideInAPackage(PKG_REST_API))
            .because("Ciclos entre pacotes de negócio violam a ISO 25010 – Modularidade e Reusabilidade "
                + "(dependências para DTOs gerados pelo OpenAPI Generator são excluídas)");

    // ═══════════════════════════════════════════════════════════════════════
    // 4. MÉTRICAS DE ACOPLAMENTO – Ca (Fan-In) e Ce (Fan-Out)
    //    Referência: Chidamber & Kemerer (1994), Martin (2002)
    // ═══════════════════════════════════════════════════════════════════════

    @Test
    @DisplayName("Extrai métricas de Acoplamento Aferente (Ca) e Eferente (Ce) por pacote")
    void extrairMetricasAcoplamento() {
        JavaClasses classes = new ClassFileImporter()
            .withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
            .importPackages(BASE_PACKAGE);

        Set<JavaPackage> subPackages = classes.getPackage(BASE_PACKAGE).getSubpackages();

        MetricsComponents<com.tngtech.archunit.core.domain.JavaClass> components =
            MetricsComponents.fromPackages(subPackages);

        ComponentDependencyMetrics metrics = ArchitectureMetrics.componentDependencyMetrics(components);

        System.out.println();
        System.out.println("╔══════════════════════════════════════════════════════════════════════════════╗");
        System.out.println("║       MÉTRICAS DE ACOPLAMENTO POR PACOTE – ISO 25010 (Manutenibilidade)    ║");
        System.out.println("╠══════════════════════════════════════════════════════════════════════════════╣");
        System.out.printf("║ %-40s │ %6s │ %6s │ %6s │ %6s ║%n",
            "Pacote", "Ca", "Ce", "I", "A");
        System.out.println("╠──────────────────────────────────────────┼────────┼────────┼────────┼────────╣");

        for (JavaPackage pkg : subPackages) {
            String pkgName = pkg.getName();
            String shortName = pkgName.replace(BASE_PACKAGE + ".", "");

            int ca = metrics.getAfferentCoupling(pkgName);
            int ce = metrics.getEfferentCoupling(pkgName);
            double instability = metrics.getInstability(pkgName);
            double abstractness = metrics.getAbstractness(pkgName);

            System.out.printf("║ %-40s │ %6d │ %6d │ %6.3f │ %6.3f ║%n",
                shortName, ca, ce, instability, abstractness);
        }

        System.out.println("╠══════════════════════════════════════════════════════════════════════════════╣");
        System.out.println("║ Ca = Acoplamento Aferente (Fan-In)  | Ce = Acoplamento Eferente (Fan-Out)  ║");
        System.out.println("║ I  = Instabilidade (Ce/(Ca+Ce))     | A  = Abstração                      ║");
        System.out.println("╚══════════════════════════════════════════════════════════════════════════════╝");
        System.out.println();
    }
}
