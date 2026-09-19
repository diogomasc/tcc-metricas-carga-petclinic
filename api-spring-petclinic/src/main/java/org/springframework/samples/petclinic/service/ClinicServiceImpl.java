/*
 * Copyright 2002-2017 the original author or authors.
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
package org.springframework.samples.petclinic.service;

import org.springframework.dao.DataAccessException;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.orm.ObjectRetrievalFailureException;
import org.springframework.samples.petclinic.model.*;
import org.springframework.samples.petclinic.repository.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import io.micrometer.observation.annotation.Observed;

import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Mostly used as a facade for all Petclinic controllers
 * Also a placeholder for @Transactional and @Cacheable annotations
 *
 * @author Michael Isvy
 * @author Vitaliy Fedoriv
 */
@Service
public class ClinicServiceImpl implements ClinicService {

    private final PetRepository petRepository;
    private final VetRepository vetRepository;
    private final OwnerRepository ownerRepository;
    private final VisitRepository visitRepository;
    private final SpecialtyRepository specialtyRepository;
    private final PetTypeRepository petTypeRepository;

    public ClinicServiceImpl(
            PetRepository petRepository,
            VetRepository vetRepository,
            OwnerRepository ownerRepository,
            VisitRepository visitRepository,
            SpecialtyRepository specialtyRepository,
            PetTypeRepository petTypeRepository) {
        this.petRepository = petRepository;
        this.vetRepository = vetRepository;
        this.ownerRepository = ownerRepository;
        this.visitRepository = visitRepository;
        this.specialtyRepository = specialtyRepository;
        this.petTypeRepository = petTypeRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public Collection<Pet> findAllPets() throws DataAccessException {
        return petRepository.findAll();
    }

    @Override
    @Transactional
    public void deletePet(Pet pet) throws DataAccessException {
        petRepository.delete(pet);
    }

    @Override
    @Transactional(readOnly = true)
    public Visit findVisitById(int visitId) throws DataAccessException {
        return findEntityById(() -> visitRepository.findById(visitId));
    }

    @Override
    @Transactional(readOnly = true)
    public Collection<Visit> findAllVisits() throws DataAccessException {
        return visitRepository.findAll();
    }

    @Override
    @Transactional
    public void deleteVisit(Visit visit) throws DataAccessException {
        visitRepository.delete(visit);
    }

    @Override
    @Transactional(readOnly = true)
    public Vet findVetById(int id) throws DataAccessException {
        return findEntityById(() -> vetRepository.findById(id));
    }

    /**
     * Lista todos os veterinários com especialidades via relação N:M EAGER (Vet ↔ Specialty).
     *
     * <p><b>Exercitado por:</b> {@code GET /api/vets} (grupo k6 "GET /vets").
     * <p><b>Span Prometheus:</b> {@code metodo_execucao_seconds{observation_contextualName="Service_Vet_FindAll"}}.
     * <p><b>Risco débito técnico:</b> relação N:M EAGER na tabela vet_specialties — amplifica
     * memória e latência sob carga crescente de VUs.
     */
    @Override
    @Transactional(readOnly = true)
    @Observed(name = "metodo.execucao", contextualName = "Service_Vet_FindAll")
    public Collection<Vet> findAllVets() throws DataAccessException {
        return vetRepository.findAll();
    }

    @Override
    @Transactional
    public void saveVet(Vet vet) throws DataAccessException {
        vetRepository.save(vet);
    }

    @Override
    @Transactional
    public void deleteVet(Vet vet) throws DataAccessException {
        vetRepository.delete(vet);
    }

    /**
     * Lista todos os donos com pets e visitas via carregamento EAGER (Owner → Pet → Visit).
     *
     * <p><b>Exercitado por:</b> {@code GET /api/owners} (grupo k6 "GET /owners").
     * <p><b>Span Prometheus:</b> {@code metodo_execucao_seconds{observation_contextualName="Service_Owner_FindAll"}}.
     * <p><b>Risco débito técnico:</b> N+1 EAGER cascade — endppoint crítico com maior potencial
     * de degradação dinâmica proporcional ao volume de dados sob estresse.
     */
    @Override
    @Transactional(readOnly = true)
    @Observed(name = "metodo.execucao", contextualName = "Service_Owner_FindAll")
    public Collection<Owner> findAllOwners() throws DataAccessException {
        return ownerRepository.findAll();
    }

    @Override
    @Transactional(readOnly = true)
    public Page<Owner> findOwners(String lastName, Pageable pageable) throws DataAccessException {
        if (lastName != null) {
            return ownerRepository.findByLastName(lastName, pageable);
        }
        return ownerRepository.findAll(pageable);
    }

    @Override
    @Transactional
    public void deleteOwner(Owner owner) throws DataAccessException {
        ownerRepository.delete(owner);
    }

    /**
     * Busca o tipo de pet por ID — chamado internamente por {@link #savePet(Pet)}.
     *
     * <p><b>Exercitado por:</b> {@code POST /api/owners/{id}/pets} (cadeia interna via savePet).
     * <p><b>Span Prometheus:</b> {@code metodo_execucao_seconds{observation_contextualName="Service_PetType_FindById"}}.
     * <p><b>Risco débito técnico:</b> lookup adicional por dentro de savePet — contribui para
     * o endpoint de adição de pet ter a cadeia de observação mais profunda (4 spans).
     */
    @Override
    @Transactional(readOnly = true)
    @Observed(name = "metodo.execucao", contextualName = "Service_PetType_FindById")
    public PetType findPetTypeById(int petTypeId) {
        return findEntityById(() -> petTypeRepository.findById(petTypeId));
    }

    @Override
    @Transactional(readOnly = true)
    public Collection<PetType> findAllPetTypes() throws DataAccessException {
        return petTypeRepository.findAll();
    }

    @Override
    @Transactional
    public void savePetType(PetType petType) throws DataAccessException {
        petTypeRepository.save(petType);
    }

    @Override
    @Transactional
    public void deletePetType(PetType petType) throws DataAccessException {
        petTypeRepository.delete(petType);
    }

    @Override
    @Transactional(readOnly = true)
    public Specialty findSpecialtyById(int specialtyId) {
        return findEntityById(() -> specialtyRepository.findById(specialtyId));
    }

    @Override
    @Transactional(readOnly = true)
    public Collection<Specialty> findAllSpecialties() throws DataAccessException {
        return specialtyRepository.findAll();
    }

    @Override
    @Transactional
    public void saveSpecialty(Specialty specialty) throws DataAccessException {
        specialtyRepository.save(specialty);
    }

    @Override
    @Transactional
    public void deleteSpecialty(Specialty specialty) throws DataAccessException {
        specialtyRepository.delete(specialty);
    }

    @Override
    @Transactional(readOnly = true)
    public Collection<PetType> findPetTypes() throws DataAccessException {
        return petRepository.findPetTypes();
    }

    /**
     * Busca dono por ID retornando o grafo completo Owner + pets aninhados + visits.
     *
     * <p><b>Exercitado por:</b>
     * <ul>
     *   <li>{@code GET /api/owners/{id}} (grupo k6 "GET /owners/{ownerId}");</li>
     *   <li>{@code POST /api/owners/{id}/pets} (lookup interno antes de savePet).</li>
     * </ul>
     * <p><b>Span Prometheus:</b> {@code metodo_execucao_seconds{observation_contextualName="Service_Owner_FindById"}}.
     * <p><b>Risco débito técnico:</b> grafo profundo por ID — potencial N+1 se não usar JOIN FETCH.
     */
    @Override
    @Transactional(readOnly = true)
    @Observed(name = "metodo.execucao", contextualName = "Service_Owner_FindById")
    public Owner findOwnerById(int id) throws DataAccessException {
        return findEntityById(() -> ownerRepository.findById(id));
    }

    @Override
    @Transactional(readOnly = true)
    public Pet findPetById(int id) throws DataAccessException {
        return findEntityById(() -> petRepository.findById(id));
    }

    /**
     * Persiste um pet resolvendo o PetType por ID antes do flush JPA.
     *
     * <p><b>Exercitado por:</b> {@code POST /api/owners/{id}/pets} (grupo k6 "POST /owners/{ownerId}/pets").
     * <p><b>Span Prometheus:</b> {@code metodo_execucao_seconds{observation_contextualName="Service_Pet_Save"}}.
     * <p><b>Risco débito técnico:</b> CascadeType.ALL no tipo do pet — side-effects inesperados;
     * lookup interno em findPetTypeById adiciona um span extra na cadeia (4 spans totais).
     */
    @Override
    @Transactional
    @Observed(name = "metodo.execucao", contextualName = "Service_Pet_Save")
    public void savePet(Pet pet) throws DataAccessException {
        pet.setType(findPetTypeById(pet.getType().getId()));
        petRepository.save(pet);
    }

    /**
     * Persiste uma visita na tabela filha associada ao pet via FK.
     *
     * <p><b>Exercitado por:</b> {@code POST /api/owners/{id}/pets/{petId}/visits}
     * (grupo k6 "POST /owners/{ownerId}/pets/{petId}/visits").
     * <p><b>Span Prometheus:</b> {@code metodo_execucao_seconds{observation_contextualName="Service_Visit_Save"}}.
     * <p><b>Risco débito técnico:</b> inserção em tabela filha — impacto de
     * lock de linha proporcional ao volume de visitas sob carga.
     */
    @Override
    @Transactional
    @Observed(name = "metodo.execucao", contextualName = "Service_Visit_Save")
    public void saveVisit(Visit visit) throws DataAccessException {
        visitRepository.save(visit);

    }

    @Override
    @Transactional(readOnly = true)
    public Collection<Vet> findVets() throws DataAccessException {
        return vetRepository.findAll();
    }

    /**
     * Persiste um dono via JPA (INSERT ou UPDATE).
     *
     * <p><b>Exercitado por:</b> {@code POST /api/owners} (grupo k6 "POST /owners").
     * <p><b>Span Prometheus:</b> {@code metodo_execucao_seconds{observation_contextualName="Service_Owner_Save"}}.
     * <p><b>Risco débito técnico:</b> write-path completo com Bean Validation e flush JPA —
     * sensível à pressaão do pool de conexões sob pico de VUs concorrentes.
     */
    @Override
    @Transactional
    @Observed(name = "metodo.execucao", contextualName = "Service_Owner_Save")
    public void saveOwner(Owner owner) throws DataAccessException {
        ownerRepository.save(owner);

    }

    @Override
    @Transactional(readOnly = true)
    public Collection<Owner> findOwnerByLastName(String lastName) throws DataAccessException {
        return ownerRepository.findByLastName(lastName);
    }

    @Override
    @Transactional(readOnly = true)
    public Collection<Visit> findVisitsByPetId(int petId) {
        return visitRepository.findByPetId(petId);
    }

    @Override
    @Transactional(readOnly = true)
    public List<Specialty> findSpecialtiesByNameIn(Set<String> names) {
        return findEntityById(() -> specialtyRepository.findSpecialtiesByNameIn(names));
    }

    private <T> T findEntityById(Supplier<T> supplier) {
        try {
            return supplier.get();
        } catch (ObjectRetrievalFailureException | EmptyResultDataAccessException e) {
            // Just ignore not found exceptions for Jdbc/Jpa realization
            return null;
        }
    }

}
