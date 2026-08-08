#!/usr/bin/env node
// Prueba dirigida del perfil del agente y sus overrides.
//
// Uso:  cd backend && node scripts/test_entity_profile_overrides.js
//
// `entities` guardaba persona, principios, estilo e instruccion desde el primer dia y no
// las leia nadie: el paso servido llevaba `role`, y `role` era solo la CLAVE. Editar un
// agente no cambiaba nada observable. Ahora `resolveEntityProfile` mezcla corpus ->
// override global ('*') -> override del proyecto, y `buildStepPayload` adjunta el
// resultado como `role_profile` SOLO si hay algo que decir.
//
// Lo que se comprueba aqui es esa mezcla, que es donde estan las tres formas de
// equivocarse: que el override del proyecto no gane, que un campo nulo borre en vez de
// heredar, y que un agente sin nada que decir arrastre una clave vacia en el payload.
//
// Corre dentro de una transaccion que se deshace al final: no deja rastro en la base.

const knex = require('knex')(require('../knexfile').test);
const { resolveEntityProfile } = require('./lib/method_resolver');

const CLAVE = 'prueba-perfil-agente';
const PROYECTO = 'https://example.invalid/prueba-perfil-agente';
const OTRO = 'https://example.invalid/prueba-perfil-agente-otro';

let fallos = 0;
const ok = (cond, etiqueta, detalle) => {
  console.log(`${cond ? '  OK  ' : ' FALLA'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos += 1;
};

(async () => {
  await knex.transaction(async (trx) => {
    await trx('entities').insert({
      key: CLAVE,
      name: 'Agente de prueba',
      kind: 'role',
      persona: 'persona del corpus',
      instruction: 'instruccion del corpus',
      source_ref: 'prueba:perfil',
    });

    const base = await resolveEntityProfile(trx, CLAVE, PROYECTO);
    ok(base && base.persona === 'persona del corpus', 'sin overrides sale lo del corpus');
    ok(base && base.instruction === 'instruccion del corpus', 'y su instruccion');

    await trx('entity_overrides').insert({
      scope_project_url: '*',
      entity_key: CLAVE,
      instruction: 'instruccion global',
    });

    const global = await resolveEntityProfile(trx, CLAVE, PROYECTO);
    ok(global.instruction === 'instruccion global', 'el override global pisa la instruccion');
    ok(global.persona === 'persona del corpus', 'y un campo nulo hereda en vez de borrar');

    await trx('entity_overrides').insert({
      scope_project_url: PROYECTO,
      entity_key: CLAVE,
      instruction: 'instruccion del proyecto',
    });

    const propio = await resolveEntityProfile(trx, CLAVE, PROYECTO);
    ok(propio.instruction === 'instruccion del proyecto', 'el override del proyecto gana al global');

    const ajeno = await resolveEntityProfile(trx, CLAVE, OTRO);
    ok(ajeno.instruction === 'instruccion global', 'y otro proyecto sigue viendo el global');

    // Un agente sin nada que decir no debe arrastrar una clave vacia hasta el agente.
    await trx('entities').insert({
      key: `${CLAVE}-vacio`,
      name: 'Agente vacio',
      kind: 'role',
      source_ref: 'prueba:perfil',
    });
    const vacio = await resolveEntityProfile(trx, `${CLAVE}-vacio`, PROYECTO);
    ok(vacio === null || Object.keys(vacio).length === 1, 'un agente sin perfil no inventa campos',
      JSON.stringify(vacio));

    ok(await resolveEntityProfile(trx, 'clave-que-no-existe', PROYECTO) === null,
      'una clave desconocida devuelve null');

    // Lo que decide si el paso servido lleva `role_profile` o no.
    ok(await resolveEntityProfile(trx, `${CLAVE}-vacio`, PROYECTO, { requireOverride: true }) === null,
      'sin override, al agente no se le manda perfil');
    const conOverride = await resolveEntityProfile(trx, CLAVE, PROYECTO, { requireOverride: true });
    ok(conOverride && conOverride.instruction === 'instruccion del proyecto',
      'con override, se le manda el perfil efectivo entero');
    ok(conOverride && conOverride.persona === 'persona del corpus',
      'incluidos los campos que el override no toco');

    throw new Error('rollback');
  }).catch((error) => {
    if (error.message !== 'rollback') throw error;
  });

  console.log(fallos ? `\n${fallos} comprobacion(es) fallaron` : '\nTodo en orden');
  await knex.destroy();
  process.exit(fallos ? 1 : 0);
})().catch(async (error) => {
  console.error(error);
  await knex.destroy();
  process.exit(1);
});
