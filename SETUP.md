# Jira Git Worklog — Setup

Herramienta local para **automatizar la imputación de horas en Jira** a partir de tus commits de GitHub.
Detecta la clave del ticket en el nombre de la rama (p. ej. `feature/WEB-1234-login`), reparte la jornada
entre los tickets del día ponderando por líneas de código cambiadas, añade las reuniones fijas (daily, etc.)
y te deja **previsualizar y editar** antes de imputar.

Cada persona levanta la app en su máquina con **su propio token de Jira** (los worklogs se crean a nombre
del dueño del token).

---

## 1. Requisitos

- **Node.js 20+** (probado con v24). Comprueba con `node -v`.
- Una cuenta de **Jira Cloud** con permiso para registrar tiempo.
- Un **token de API de Jira** y un **token de GitHub** (ver abajo).

---

## 2. Conseguir los tokens

### Jira API token
1. Entra en <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. **Create API token**, ponle un nombre (p. ej. `worklog-cli`) y **cópialo** (no se vuelve a mostrar).
3. Necesitarás también el **email** con el que entras a Jira.

### GitHub token (Personal Access Token)
1. Entra en <https://github.com/settings/tokens>.
2. Crea un **classic token** con estos permisos (scopes):
   - `repo` — leer commits y ramas (incluye repos privados de la organización).
   - `read:org` — listar los repositorios de tu organización.
3. Cópialo.

> Si la organización usa **SSO**, tras crear el token pulsa **Configure SSO → Authorize** para habilitarlo.

---

## 3. Configurar secretos

Copia la plantilla y rellena tus valores:

```bash
cp .env.example .env
```

Edita `.env`:

```dotenv
JIRA_BASE_URL=https://your-company.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your_jira_api_token
GITHUB_TOKEN=your_github_token
GITHUB_ORG=your-org
PORT=4000
CONFIG_PATH=./config.yaml
```

El `.env` está en `.gitignore`: **nunca se sube al repo**.

---

## 4. Configurar reglas de imputación

Copia la plantilla de configuración:

```bash
cp config.example.yaml config.yaml
```

Puedes editar este fichero a mano **o** desde la pestaña **Config** de la web (se guarda en el mismo `config.yaml`).
Campos principales:

- **`workday.defaultHours`** — horas de jornada estándar (8).
- **`workday.seasonal`** — jornada reducida por meses (p. ej. verano: meses `6,7,8` → `7` horas).
- **`recurring`** — reuniones fijas que se imputan siempre. Cada bloque tiene `label`, `weekday`
  (`*` = todos los laborables, o `mon`/`tue`/…), `minutes` e **`issue`** (la clave Jira donde imputar).
  ⚠️ Rellena el `issue` de la **daily** y demás reuniones o se omitirán con un aviso.
- **`fallbackIssue`** — ticket para días laborables sin commits (déjalo vacío para no imputar esos días).
- **`distribution`** — `weighted-by-churn` (por líneas cambiadas), `weighted-by-commits` o `equal`.
- **`ticketRegex`** — patrón para extraer la clave del nombre de la rama (por defecto `[A-Z][A-Z0-9]+-\d+`).
- **`holidays`** — fechas `YYYY-MM-DD` que se saltan.
- **`people`** — cada persona con su `id`, `githubLogin`, `emails` (para atribuir commits) y `default: true`
  para la persona preseleccionada.

---

## 5. Instalar y arrancar

```bash
npm install          # instala server + web (una sola vez)
npm run dev          # levanta API (127.0.0.1:4000) y web (127.0.0.1:5173) a la vez
```

Abre <http://127.0.0.1:5173>. En la cabecera verás tu usuario de Jira si los tokens son correctos.

Para comprobar solo las credenciales de Jira sin la web:

```bash
npm run check:jira
```

---

## 6. Flujo de uso

1. **Config** — revisa jornada, reuniones fijas (pon el `issue` de la daily), festivos y personas.
2. **Vincular ramas** — si alguna rama no lleva la clave en el nombre (p. ej. `hotfix/login`),
   vincúlala manualmente a su ticket.
3. **Previsualizar** — elige persona y rango de fechas, pulsa **Generar**. Verás el plan por día:
   tickets, origen (commits / recurring / fallback) y horas. Puedes **editar horas, cambiar el ticket
   o eliminar filas**.
4. **Imputar en Jira** — crea los worklogs. Es **idempotente**: cada worklog lleva un marcador propio,
   así que reimputar el mismo día no duplica (se omiten los ya creados).

---

## 7. Limitaciones conocidas

- **Autoría**: la API REST de Jira crea el worklog a nombre del **dueño del token**. Por eso cada persona
  usa el suyo; no se puede imputar en nombre de un compañero (requeriría OAuth 3LO).
- **Ramas, no default branch**: se recorren repos → ramas → commits. La búsqueda global de GitHub
  (`/search/commits`) solo indexa la rama por defecto, por eso no se usa.
- **Rate limits de GitHub**: en organizaciones con muchos repos la primera recolección puede tardar;
  el churn (líneas cambiadas) se **cachea por SHA** para acelerar las siguientes.
- **Datos locales**: vínculos de ramas, caché de churn y registro de imputaciones se guardan en
  `server/data/store.json` (ignorado por git).
```
