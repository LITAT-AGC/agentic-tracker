# APTS Dashboard (frontend)

Dashboard humano de APTS: Vue 3 (Composition API) + Vite + Pinia + Vue Router + PrimeVue + Tailwind CSS + ECharts.

- Login por contraseña (`DASHBOARD_PASSWORD` del backend) con sesión por cookie.
- Vista Overview con métricas, tareas y feed de actividad.
- Vista Projects con drill-down por repositorio y gestión de backlog.
- Resolución manual de bloqueos desde la UI.

## Desarrollo

```bash
npm install
npm run dev
```

Sirve en `http://localhost:47302` y consume el backend en `http://localhost:47301` (ver el README de la raíz para levantar todo junto con `npm run dev`).

## Pruebas E2E

Playwright usa el Chrome local (`channel: 'chrome'`); no ejecutar `npx playwright install`. El backend debe correr en modo test (`npm run test:e2e:prepare` y `npm run test:e2e:backend` desde la raíz). Reglas completas en `AGENTS.md`.

```bash
npx playwright test
```
