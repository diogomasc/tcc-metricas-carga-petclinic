/*
 * Copyright 2024 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.springframework.samples.petclinic.config;

import io.micrometer.observation.ObservationRegistry;
import io.micrometer.observation.aop.ObservedAspect;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Registra o {@link ObservedAspect} para processar anotações {@code @Observed}
 * via AOP. Gera métricas de Timer (latência) no Prometheus com tags
 * {@code class}, {@code method} e {@code error}.
 *
 * @see io.micrometer.observation.annotation.Observed
 */
@Configuration(proxyBeanMethods = false)
public class ObservabilityConfig {

    private static final Logger log = LoggerFactory.getLogger(ObservabilityConfig.class);

    @Bean
    @ConditionalOnMissingBean
    ObservedAspect observedAspect(ObservationRegistry registry) {
        log.info("ObservedAspect registrado — métricas @Observed ativas (metodo_execucao_seconds_*)");
        return new ObservedAspect(registry);
    }
}
