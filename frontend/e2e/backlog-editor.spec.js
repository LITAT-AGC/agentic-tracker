import { test, expect } from '@playwright/test';

// Regresion de los dos defectos del panel sobre el backlog (2026-08-17). Los dos nacen de lo
// mismo —la vista `compact` del listado no manda lo que esta pantalla daba por supuesto—
// pero van en DOS pruebas separadas a proposito: en una sola, la primera asercion que falla
// deja la otra sin comprobar, y entonces no se sabe si cubre el segundo defecto o no.
//
//   1. EL BORRADO. El editor se llenaba con la fila del listado, que no trae `description`
//      ni `acceptance_criteria` —solo las banderas `has_*`—, y el guardado manda siempre los
//      dos campos: abrir el editor de un item con descripcion y pulsar Guardar la borraba,
//      con respuesta 200 y sin rastro. Solo se puede cazar desde aqui: el backend no hizo
//      nada mal, aplico el null que le mandaron.
//
//   2. EL HUERFANO. El motor reparte por `epic_id` y lo que se crea desde el panel nace sin
//      epica, asi que el conductor no lo iba a tomar nunca y la interfaz no lo decia. Que la
//      adopcion haga lo correcto lo cubre `backend/scripts/test_dashboard_backlog_epic_scope.js`,
//      que puede montarse una iniciativa con epica; esta pantalla no.
//
// Necesita el backend levantado con al menos un proyecto. Cada prueba crea su propio item y
// lo borra al terminar, incluso si falla.
//
//   cd backend && PORT=47414 DASHBOARD_PASSWORD=clave-de-prueba-local node scripts/start_test_server.js
//   cd frontend && VITE_API_BASE_URL=/api VITE_DEV_API_PROXY_TARGET=http://localhost:47414 npm run dev
//   cd frontend && DASHBOARD_PASSWORD=clave-de-prueba-local npx playwright test backlog-editor.spec.js
//
// `VITE_API_BASE_URL=/api` no es decorativo: `frontend/.env.local` lo fija a
// `http://localhost:47301/api`, y con eso el navegador habla con ESE puerto y se salta el
// proxy del dev server. Si ahi no hay nada levantado, el login falla con «Error al conectar
// con el servidor» y la prueba muere esperando una navegacion que no llega, sin decir por
// que. Ojo tambien con `loginLimiter`: 5 intentos por 15 minutos y en memoria, asi que
// reintentar en bucle agota el presupuesto y el sintoma es exactamente el mismo.

const CLAVE = process.env.DASHBOARD_PASSWORD || 'admin';
const DESCRIPCION = 'Descripcion que NO se debe perder al abrir el editor y guardar sin tocarla.';
const CRITERIOS = '- criterio uno\n- criterio dos';

const entrar = async (page) => {
  await page.goto('/login');
  await page.locator('#password').fill(CLAVE);
  await page.getByRole('button', { name: 'Acceder al Panel' }).click();
  // El login es un `router.push` del SPA. Se espera contenido, no una navegacion.
  await expect(page.getByText('Resumen del Sistema')).toBeVisible({ timeout: 15000 });
};

const primerProyecto = async (page) => {
  const proyectos = await page.evaluate(async () => {
    const r = await fetch('/api/dashboard/projects', { credentials: 'same-origin' });
    const j = await r.json();
    return j.projects || j || [];
  });
  return Array.isArray(proyectos) && proyectos.length ? proyectos[0].url : null;
};

// Se crea por la MISMA via que produce los dos defectos: la del panel.
const crearItem = (page, proyectoUrl, titulo) => page.evaluate(async ([url, title, description, acceptance]) => {
  const r = await fetch(`/api/dashboard/projects/${encodeURIComponent(url)}/backlog`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      description,
      acceptance_criteria: acceptance,
      item_type: 'chore',
      status: 'ready',
      priority: 999,
      sort_order: 0,
      source_kind: 'dashboard',
      source_ref: 'e2e-backlog-editor'
    })
  });
  const body = await r.json();
  return { status: r.status, id: body.backlog_item && body.backlog_item.id };
}, [proyectoUrl, titulo, DESCRIPCION, CRITERIOS]);

const borrarItem = (page, id) => page.evaluate(async (backlogId) => {
  await fetch(`/api/dashboard/backlog/${backlogId}`, { method: 'DELETE', credentials: 'same-origin' });
}, id);

test('el editor no borra la descripcion al abrirlo y guardar', async ({ page }) => {
  const TITULO = 'E2E backlog — no borrar al guardar';
  await entrar(page);
  const url = await primerProyecto(page);
  test.skip(!url, 'el backend no tiene ningun proyecto');

  const creado = await crearItem(page, url, TITULO);
  expect(creado.status).toBe(201);

  try {
    await page.goto(`/dashboard/projects/${encodeURIComponent(url)}`);
    const fila = page.locator('tr').filter({ hasText: TITULO }).first();
    await expect(fila).toBeVisible({ timeout: 15000 });

    await fila.getByRole('button', { name: /Editar|Abriendo/ }).click();
    const dialogo = page.locator('.p-dialog', { hasText: 'Editar backlog item' });
    await expect(dialogo).toBeVisible();

    // LA asercion: con el defecto puesto los dos textareas llegaban vacios.
    await expect(dialogo.locator('textarea').first()).toHaveValue(DESCRIPCION);

    await dialogo.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(dialogo).toBeHidden({ timeout: 15000 });

    const despues = await page.evaluate(async (backlogId) => {
      const r = await fetch(`/api/dashboard/backlog/${backlogId}`, { credentials: 'same-origin' });
      return (await r.json()).backlog_item;
    }, creado.id);
    expect(despues.description).toBe(DESCRIPCION);
    expect(despues.acceptance_criteria).toBe(CRITERIOS);
  } finally {
    await borrarItem(page, creado.id);
  }
});

test('el panel avisa de lo que queda fuera del plan y ofrece adoptarlo', async ({ page }) => {
  // El titulo NO lleva «fuera del plan»: es el texto del propio aviso, y un titulo que lo
  // contenga hace que el localizador de la fila y el del aviso se confundan entre si.
  const TITULO = 'E2E backlog — huerfano visible';
  await entrar(page);
  const url = await primerProyecto(page);
  test.skip(!url, 'el backend no tiene ningun proyecto');

  const creado = await crearItem(page, url, TITULO);
  expect(creado.status).toBe(201);

  try {
    await page.goto(`/dashboard/projects/${encodeURIComponent(url)}`);
    const fila = page.locator('tr').filter({ hasText: TITULO }).first();
    await expect(fila).toBeVisible({ timeout: 15000 });

    await expect(fila.getByText('fuera del plan')).toBeVisible();
    await expect(fila.getByRole('button', { name: /Adoptar/ })).toBeVisible();
  } finally {
    await borrarItem(page, creado.id);
  }
});
