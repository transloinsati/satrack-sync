// Sync Airtable (Tickets/Origen/Destino/Clientes/Areas, solo lectura) <-> Satrack (SendTrips +
// GetEventsOnRouteByVehicleFromBitacora) <-> Supabase (viajes/etapas/log_sincronizacion, escritura).
//
// Uso local: node scripts/sync-satrack.mjs
// Uso en GitHub Actions: mismo comando, variables de entorno vía secrets del repo.

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";

const {
  SATRACK_CLIENT_ID,
  SATRACK_CLIENT_SECRET,
  SATRACK_GRANT_TYPE = "client_credentials",
  SATRACK_TOKEN_URL = "http://securityprovider.satrack.com:8080/auth/realms/satrack-base/protocol/openid-connect/token",
  SATRACK_API_BASE = "https://trafficcontrolintegrationapi.satrack.com",
  AIRTABLE_PAT,
  AIRTABLE_BASE_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

for (const [name, value] of Object.entries({
  SATRACK_CLIENT_ID,
  SATRACK_CLIENT_SECRET,
  AIRTABLE_PAT,
  AIRTABLE_BASE_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
})) {
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TICKETS_TABLE = "Tickets";
const AREA_TIPO = {
  BODEGA_ORIGEN: "bodega_origen",
  AREA_CARGA: "area_carga",
  BODEGA_DESTINO: "bodega_destino",
  AREA_DESCARGA: "area_descarga",
};

// ---------------------------------------------------------------------------
// Airtable (solo lectura) — API REST estandar, PAT propio del script.
// ---------------------------------------------------------------------------

async function airtableGet(path, params = {}) {
  const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } });
  if (!res.ok) throw new Error(`Airtable GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function airtableGetRecord(table, recordId) {
  return airtableGet(`${encodeURIComponent(table)}/${recordId}`);
}

async function airtableListAll(table, params = {}) {
  let records = [];
  let offset;
  do {
    const page = await airtableGet(encodeURIComponent(table), { ...params, ...(offset ? { offset } : {}) });
    records = records.concat(page.records);
    offset = page.offset;
  } while (offset);
  return records;
}

const normalize = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

// Resuelve el Origen (lat/lng) de un ticket via RUC Cliente -> Clientes.Origen, desambiguando por
// la ciudad de texto del ticket si el cliente tiene mas de un Origen vinculado. Tickets.Origen 2
// (link directo) esta vacio en la practica — no usarlo.
async function resolveOrigen(ticket) {
  const clienteLink = ticket.fields["RUC Cliente"]?.[0];
  if (!clienteLink) return { error: "Ticket sin RUC Cliente vinculado" };

  const cliente = await airtableGetRecord("Clientes", clienteLink);
  const origenLinks = cliente.fields["Origen"] || [];
  if (origenLinks.length === 0) {
    return { error: `Cliente "${cliente.fields["Razón Social"]}" no tiene Origen calibrado` };
  }

  let origenRecordId = origenLinks[0];
  if (origenLinks.length > 1) {
    const ciudadTicket = normalize(ticket.fields["Origen"]);
    const origenes = await Promise.all(origenLinks.map((id) => airtableGetRecord("Origen", id)));
    const match = origenes.find((o) =>
      (o.fields["Name (from Ciudad)"] || []).some((c) => normalize(c) === ciudadTicket)
    );
    if (!match) {
      return {
        error: `Cliente "${cliente.fields["Razón Social"]}" tiene ${origenLinks.length} Origenes y ninguno coincide con la ciudad "${ticket.fields["Origen"]}" del ticket`,
      };
    }
    origenRecordId = match.id;
  }

  const origen = await airtableGetRecord("Origen", origenRecordId);
  const { Latitud, Longitud, Direccion } = origen.fields;
  if (Latitud == null || Longitud == null) {
    return { error: `Origen "${origen.fields.Name}" sin Latitud/Longitud calibradas` };
  }
  return { origen, cliente, lat: Latitud, lng: Longitud, direccion: Direccion };
}

// Resuelve el Destino (lat/lng) via el link directo Tickets."Destino 2" (a diferencia de Origen,
// este si viene poblado en los tickets reales).
async function resolveDestino(ticket) {
  const destinoLink = ticket.fields["Destino 2"]?.[0];
  if (!destinoLink) return { error: "Ticket sin Destino 2 vinculado" };
  const destino = await airtableGetRecord("Destino", destinoLink);
  const { Latitud, Longitud } = destino.fields;
  if (Latitud == null || Longitud == null) {
    return { error: `Destino "${destino.fields["Cliente Entrega"]}" sin Latitud/Longitud calibradas` };
  }
  const direccion = destino.fields["Dirección Entrega"];
  const clienteDestinoLink = destino.fields["Cliente Destino"]?.[0];
  const clienteDestino = clienteDestinoLink ? await airtableGetRecord("Cliente Destino", clienteDestinoLink) : null;
  return { destino, clienteDestino, lat: Latitud, lng: Longitud, direccion };
}

async function fetchAreasFor(clienteOrigenId, clienteDestinoId) {
  const table = "Areas";
  const records = await airtableListAll(table);
  return records.filter((r) => {
    const co = r.fields["Cliente_Origen"]?.[0];
    const cd = r.fields["Cliente_Destino"]?.[0];
    return (clienteOrigenId && co === clienteOrigenId) || (clienteDestinoId && cd === clienteDestinoId);
  });
}

// ---------------------------------------------------------------------------
// Satrack — autenticacion + SendTrips (Pasada 1) + GetEventsOnRouteByVehicleFromBitacora (Pasada 2)
// ---------------------------------------------------------------------------

async function getSatrackToken() {
  const body = new URLSearchParams({
    client_id: SATRACK_CLIENT_ID,
    client_secret: SATRACK_CLIENT_SECRET,
    grant_type: SATRACK_GRANT_TYPE,
  });
  const res = await fetch(SATRACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Satrack token -> ${res.status}: ${await res.text()}`);
  const { access_token } = await res.json();
  return access_token;
}

async function satrackFetch(token, path, options = {}) {
  const res = await fetch(`${SATRACK_API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Satrack ${path} -> ${res.status}: ${text}`);
  return { status: res.status, body: json };
}

function sendTrips(token, payload) {
  return satrackFetch(token, "/Trips/oauth", { method: "POST", body: JSON.stringify(payload) });
}

// El schema de TripHistoryReportResposeModel describe UN solo objeto (no una lista) aunque el
// request acepta un array de placas -> se asume una llamada por placa.
function getEventsForPlate(token, placa) {
  return satrackFetch(token, "/Trips/oauth/GetEventsOnRouteByVehicleFromBitacora", {
    method: "POST",
    body: JSON.stringify([placa]),
  });
}

function manualStartTrip(token, routeId, tripId) {
  return satrackFetch(token, `/Trips/oauth/ManualStart/${routeId}/${tripId}`, { method: "PUT" });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Un viaje recien creado con SendTrips queda en estado ASSIGNED y Satrack lo EXPIRA solo (visto en
// pruebas reales: ~3m21s) si nadie llama ManualStart — no basta con esperar a que el vehiculo entre
// a la geocerca de origen. route.id/trip.tripId no vienen en la respuesta de SendTrips, hay que
// pedirlos con GetEventsOnRouteByVehicleFromBitacora (que puede tardar unos segundos en tener el
// viaje disponible), por eso el reintento corto.
async function iniciarViajeManual(token, placa) {
  for (let intento = 0; intento < 5; intento++) {
    const { body } = await getEventsForPlate(token, placa);
    const routeId = body?.route?.id;
    const tripId = body?.trip?.tripId;
    if (routeId && tripId) {
      await manualStartTrip(token, routeId, tripId);
      return tripId;
    }
    await sleep(2000);
  }
  throw new Error(`No se pudo obtener route/tripId para "${placa}" tras SendTrips (ManualStart no se llamó)`);
}

// ---------------------------------------------------------------------------
// Pasada 1 — Crear viajes
// ---------------------------------------------------------------------------

function ecuadorSplit(isoUtc) {
  const d = new Date(new Date(isoUtc).getTime() - 5 * 60 * 60 * 1000);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 19);
  return { date, time };
}

function buildPayload({ ticket, unidad, cliente, origen, destino, clienteDestino }) {
  const ticketId = ticket.fields["Id Ticket"];
  const fechaSolicitada = ticket.fields["Fecha Carga Solicitada"];
  const { date: creationDate, time } = ecuadorSplit(fechaSolicitada);
  // Ventanas de compromiso: no hay un campo dedicado en Airtable para esto todavia. Se usa un
  // margen fijo (4h para carga, 24h para descarga) como placeholder razonable.
  // Satrack valida server-side que CommitmentDateUpload no sea pasado -> anclar a "ahora", no a
  // Fecha Carga Solicitada (que para tickets ya en curso suele quedar en el pasado).
  const commitmentUpload = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const commitmentDownload = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const payload = {
    customer: {
      document: cliente.fields["RUC"] || "",
      fullName: cliente.fields["Razón Social"] || "",
    },
    route: {
      name: ticket.fields["Ruta"] || `${ticket.fields["Origen"] || ""}-${(ticket.fields["Destino"] || [])[0] || ""}`,
      code: ticketId,
      origin: { address: origen.direccion || "", latitude: origen.lat, longitude: origen.lng },
      destination: { address: destino.direccion || "", latitude: destino.lat, longitude: destino.lng },
      stopConfiguration: { enableAnalysis: true, stopThresholdSeconds: 600 },
    },
    vehicle: {
      serviceCode: unidad.placa,
      model: unidad.modelo,
      ...(unidad.color ? { color: unidad.color } : {}),
      ...(unidad.marca ? { brand: unidad.marca } : {}),
    },
    manifest: {
      code: ticketId,
      creationDate,
      time,
      commitmentDateUpload: commitmentUpload.toISOString(),
      timeCommitmentUpload: commitmentUpload.toISOString().slice(11, 19),
      commitmentDateDownload: commitmentDownload.toISOString(),
      timeCommitmentDownload: commitmentDownload.toISOString().slice(11, 19),
      tripType: "Nacional",
    },
    shipments: [
      {
        remittanceCode: ticketId,
        documentSender: cliente.fields["RUC"] || "",
        senderName: cliente.fields["Razón Social"] || "",
        senderAddress: origen.direccion || "",
        senderLatitude: origen.lat,
        senderLongitude: origen.lng,
        recipientName: clienteDestino?.fields["Razón Social"] || "",
        recipientAddress: destino.direccion || "",
        recipientLatitude: destino.lat,
        recipientLongitude: destino.lng,
        packing: "Pallets",
        code: ticketId,
      },
    ],
    checkPointList: [],
    source: "TMS",
  };
  return payload;
}

async function pasada1CrearViajes(token) {
  // SYNC_ONLY_TICKET_ID: para probar contra un solo ticket real antes de correr contra todos los
  // activos.
  const filterByFormula = process.env.SYNC_ONLY_TICKET_ID
    ? `{Id Ticket} = '${process.env.SYNC_ONLY_TICKET_ID}'`
    : "AND({Placa Unidad} != '', {Estado Ticket} != 'Cancelado')";
  const tickets = await airtableListAll(TICKETS_TABLE, { filterByFormula });

  let ok = 0;
  let error = 0;
  const detalle = [];

  for (const ticket of tickets) {
    const ticketId = ticket.fields["Id Ticket"];
    try {
      const { data: existing } = await supabase
        .from("viajes")
        .select("estado_envio")
        .eq("ticket_id", ticketId)
        .maybeSingle();
      if (existing?.estado_envio === "enviado") continue; // ya se le hizo SendTrips

      const placaLink = ticket.fields["Placa Unidad"]?.[0];
      if (!placaLink) throw new Error("Ticket sin Placa Unidad vinculada");
      // "Copia de Placa Unidad" es un campo formula en Tickets que ya trae la placa como texto,
      // evita un round-trip a Unidad solo para el texto de la placa.
      const unidadRecord = await airtableGetRecord("Unidad", placaLink);
      const unidad = {
        placa: ticket.fields["Copia de Placa Unidad"] || unidadRecord.fields["Placa Unidad"],
        color: unidadRecord.fields["Color"],
        // El swagger marca Vehicle.Model como opcional, pero el servidor real de Satrack lo exige
        // (confirmado con un 400 real: "Vehicle.Model: The vehicle model is required").
        modelo: unidadRecord.fields["Año de Fabricación"],
        marca: unidadRecord.fields["Marca"],
      };
      if (!unidad.modelo) throw new Error(`Unidad "${unidad.placa}" sin Año de Fabricación (requerido por Satrack como vehicle.model)`);

      const origenResult = await resolveOrigen(ticket);
      if (origenResult.error) throw new Error(origenResult.error);
      const destinoResult = await resolveDestino(ticket);
      if (destinoResult.error) throw new Error(destinoResult.error);

      const payload = buildPayload({
        ticket,
        unidad,
        cliente: origenResult.cliente,
        origen: origenResult,
        destino: destinoResult,
        clienteDestino: destinoResult.clienteDestino,
      });

      const { body } = await sendTrips(token, payload);

      // Sin esto el viaje queda ASSIGNED y Satrack lo expira solo en pocos minutos (confirmado con
      // una prueba real) — no marca esto como fallo del envio (el viaje SI se creo en Satrack, no
      // se debe reintentar SendTrips), solo queda registrado en error_mensaje para que se vea.
      let tripId = null;
      let startWarning = null;
      try {
        tripId = await iniciarViajeManual(token, unidad.placa);
      } catch (startErr) {
        startWarning = `SendTrips OK pero ManualStart falló: ${startErr.message}`;
      }

      await supabase.from("viajes").upsert(
        {
          ticket_id: ticketId,
          airtable_record_id: ticket.id,
          placa_unidad: unidad.placa,
          cliente: origenResult.cliente.fields["Razón Social"],
          origen_nombre: origenResult.origen.fields.Name,
          origen_lat: origenResult.lat,
          origen_lng: origenResult.lng,
          destino_nombre: destinoResult.destino.fields["Cliente Entrega"],
          destino_lat: destinoResult.lat,
          destino_lng: destinoResult.lng,
          satrack_correlation_id: body?.correlationId ?? null,
          satrack_trip_id: tripId,
          estado_envio: "enviado",
          error_mensaje: startWarning,
        },
        { onConflict: "ticket_id" }
      );
      ok++;
    } catch (err) {
      error++;
      detalle.push({ ticket_id: ticketId, error: err.message });
      await supabase.from("viajes").upsert(
        {
          ticket_id: ticketId,
          airtable_record_id: ticket.id,
          placa_unidad: ticket.fields["Copia de Placa Unidad"] || "desconocida",
          estado_envio: "error",
          error_mensaje: err.message,
        },
        { onConflict: "ticket_id" }
      );
    }
  }

  await supabase.from("log_sincronizacion").insert({
    pasada: "crear_viajes",
    tickets_procesados: tickets.length,
    tickets_ok: ok,
    tickets_error: error,
    detalle,
  });

  console.log(`Pasada 1: ${ok} enviados, ${error} con error de ${tickets.length} tickets.`);
}

// ---------------------------------------------------------------------------
// Pasada 2 — Revisar viajes activos y escribir Etapas
// ---------------------------------------------------------------------------

// Satrack devuelve vehicleCurrentState.coordinate como [latitud, longitud] (confirmado con datos
// reales: primer valor siempre cerca de 0, segundo cerca de -78/-79 — Ecuador). GeoJSON (y por lo
// tanto Areas.GeoJSON, que viene de la extension Mapbox) exige [longitud, latitud] — sin este swap
// el point-in-polygon compara los ejes al reves y nunca da un match real.
function toFeature([lat, lng]) {
  return { type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] } };
}

// Revisa el punto contra las Areas del cliente, priorizando el poligono mas especifico
// (area_carga/area_descarga) sobre el general (bodega_origen/bodega_destino).
function detectarZona(point, areas) {
  const byTipo = (tipo) => areas.filter((a) => normalize(a.fields["Tipo"]) === tipo);
  const dentro = (list) =>
    list.find((a) => {
      try {
        return booleanPointInPolygon(point, JSON.parse(a.fields["GeoJSON"]));
      } catch {
        return false;
      }
    });

  return (
    dentro(byTipo(AREA_TIPO.AREA_CARGA)) && AREA_TIPO.AREA_CARGA ||
    dentro(byTipo(AREA_TIPO.AREA_DESCARGA)) && AREA_TIPO.AREA_DESCARGA ||
    dentro(byTipo(AREA_TIPO.BODEGA_ORIGEN)) && AREA_TIPO.BODEGA_ORIGEN ||
    dentro(byTipo(AREA_TIPO.BODEGA_DESTINO)) && AREA_TIPO.BODEGA_DESTINO ||
    "en_ruta"
  );
}

const ZONA_TO_ETAPA = {
  bodega_origen: "Llegada Cliente Origen",
  area_carga: "Proceso Carga",
  en_ruta: "En Ruta Destino",
  bodega_destino: "Llegada al cliente",
  area_descarga: "Recepción de Mercadería",
};

async function cerrarYAbrirEtapa(viajeId, ticketId, zonaNueva) {
  const { data: abierta } = await supabase
    .from("etapas")
    .select("id")
    .eq("viaje_id", viajeId)
    .eq("estado_evento", "En Proceso")
    .maybeSingle();

  const ahora = new Date().toISOString();
  if (abierta) {
    await supabase.from("etapas").update({ fecha_fin: ahora, estado_evento: "Finalizado" }).eq("id", abierta.id);
  }

  const etapaNombre = ZONA_TO_ETAPA[zonaNueva];
  if (!etapaNombre) return; // "sin_asignar" u otra zona sin etapa asociada
  await supabase.from("etapas").insert({
    viaje_id: viajeId,
    ticket_id: ticketId,
    etapa: etapaNombre,
    fecha_inicio: ahora,
    estado_evento: "En Proceso",
  });
}

async function pasada2RevisarEtapas(token) {
  const { data: viajesActivos } = await supabase
    .from("viajes")
    .select("*")
    .eq("estado_envio", "enviado")
    .neq("zona_actual", "completado");

  let ok = 0;
  let error = 0;
  const detalle = [];

  for (const viaje of viajesActivos ?? []) {
    try {
      const { status, body } = await getEventsForPlate(token, viaje.placa_unidad);
      if (status === 204 || !body) continue; // sin eventos todavia

      if (body.trip?.tripId && !viaje.satrack_trip_id) {
        await supabase.from("viajes").update({ satrack_trip_id: body.trip.tripId }).eq("id", viaje.id);
      }

      const coordinate = body.vehicleCurrentState?.coordinate;
      if (!coordinate || coordinate.length !== 2) continue;

      const ticket = await airtableGetRecord(TICKETS_TABLE, viaje.airtable_record_id);
      const clienteOrigenId = ticket.fields["RUC Cliente"]?.[0];
      const destinoRecordId = ticket.fields["Destino 2"]?.[0];
      const destinoRecord = destinoRecordId ? await airtableGetRecord("Destino", destinoRecordId) : null;
      const clienteDestinoId = destinoRecord?.fields["Cliente Destino"]?.[0];

      const areas = await fetchAreasFor(clienteOrigenId, clienteDestinoId);
      const zonaNueva = detectarZona(toFeature(coordinate), areas);

      if (zonaNueva !== viaje.zona_actual) {
        await cerrarYAbrirEtapa(viaje.id, viaje.ticket_id, zonaNueva);
        await supabase.from("viajes").update({ zona_actual: zonaNueva }).eq("id", viaje.id);
      }
      ok++;
    } catch (err) {
      error++;
      detalle.push({ ticket_id: viaje.ticket_id, error: err.message });
    }
  }

  await supabase.from("log_sincronizacion").insert({
    pasada: "revisar_etapas",
    tickets_procesados: (viajesActivos ?? []).length,
    tickets_ok: ok,
    tickets_error: error,
    detalle,
  });

  console.log(`Pasada 2: ${ok} revisados, ${error} con error de ${(viajesActivos ?? []).length} viajes activos.`);
}

// ---------------------------------------------------------------------------

async function main() {
  const token = await getSatrackToken();
  await pasada1CrearViajes(token);
  await pasada2RevisarEtapas(token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
