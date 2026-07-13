# satrack-sync

Sincroniza tickets de transporte desde Airtable (solo lectura) con la API de Satrack
(`SendTrips` + `GetEventsOnRouteByVehicleFromBitacora`), y guarda el resultado (viajes, etapas,
log de corridas) en un proyecto de Supabase. Corre cada 5 minutos vía GitHub Actions.

## Variables de entorno / secrets

| Variable | Descripción |
|---|---|
| `SATRACK_CLIENT_ID` / `SATRACK_CLIENT_SECRET` | Credenciales OAuth de Satrack |
| `AIRTABLE_PAT` | Personal Access Token de Airtable, scope `data.records:read` |
| `AIRTABLE_BASE_ID` | Id de la base de Airtable |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Proyecto de Supabase donde se escribe |

## Uso local

```bash
npm install
cp .env.example .env   # llenar valores
npm run sync
```

`SYNC_ONLY_TICKET_ID` (opcional) acota la Pasada 1 a un solo ticket, útil para pruebas.
