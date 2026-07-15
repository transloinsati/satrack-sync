// Sync Airtable (Tickets/Origen/Destino/Clientes/Areas, solo lectura) <-> Satrack (SendTrips +
// GetEventsOnRouteByVehicleFromBitacora + API de eventos de ubicación) <-> Supabase
// (viajes/etapas/log_sincronizacion, escritura).
//
// Uso local: node scripts/sync-satrack.mjs
// Uso en cron (servidor Transloinsa / GitHub Actions): mismo comando, variables de entorno vía .env
// o secrets del repo.

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";

const {
  SATRACK_CLIENT_ID,
  SATRACK_CLIENT_SECRET,
  SATRACK_GRANT_TYPE = "client_credentials",
  // No confirmado todavia si el API de TMS (trafficcontrolintegrationapi.satrack.com) usa el mismo
  // proveedor de identidad que el API de eventos de ubicacion (documentos_satrack/api_evento.md).
  // Sobreescribir via env si Satrack confirma un host distinto para las credenciales de TMS.
  SATRACK_TOKEN_URL = "http://securityprovider.satrack.com:8080/auth/realms/satrack-base/protocol/openid-connect/token",
  SATRACK_API_BASE = "https://trafficcontrolintegrationapi.satrack.com",
  // Credenciales del producto "API de eventos de ubicación" (distinto del TMS/rutas de arriba) --
  // dan la posición cruda de una placa sin necesidad de que exista un viaje/trip en Satrack. Se usan
  // para detectar "Asignación Unidad" -> "Llegada Cliente Origen" antes de que SendTrips se haya
  // podido hacer (ej. ticket sin Destino todavia) o antes de que el trip empiece a reportar. Opcional
  // -- si faltan, esa detección temprana simplemente se salta sin romper el resto del script.
  SATRACK_EVENTS_CLIENT_ID,
  SATRACK_EVENTS_CLIENT_SECRET,
  SATRACK_EVENTS_API_BASE = "http://locationintegrationapi.satrack.com",
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
// la ciudad de texto del ticket si el cliente tiene mas de un Origen vinculado (ver plan: caso
// Arcacontinental Duran/Quito). Tickets.Origen 2 (link directo) esta vacio en la practica — no usarlo.
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

function areasFor(allAreas, clienteOrigenId, clienteDestinoId) {
  return allAreas.filter((r) => {
    const co = r.fields["Cliente_Origen"]?.[0];
    const cd = r.fields["Cliente_Destino"]?.[0];
    return (clienteOrigenId && co === clienteOrigenId) || (clienteDestinoId && cd === clienteDestinoId);
  });
}

// ---------------------------------------------------------------------------
// Satrack — autenticacion + SendTrips (Pasada 1) + GetEventsOnRouteByVehicleFromBitacora (Pasada 2)
// ---------------------------------------------------------------------------

async function getToken(clientId, clientSecret) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: SATRACK_GRANT_TYPE });
  const res = await fetch(SATRACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Satrack token -> ${res.status}: ${await res.text()}`);
  const { access_token } = await res.json();
  return access_token;
}

const getSatrackToken = () => getToken(SATRACK_CLIENT_ID, SATRACK_CLIENT_SECRET);
const getSatrackEventsToken = () => getToken(SATRACK_EVENTS_CLIENT_ID, SATRACK_EVENTS_CLIENT_SECRET);

// API de eventos de ubicacion (producto distinto al TMS) -- da la posicion cruda de una placa sin
// depender de que exista un viaje en Satrack. GraphQL, un solo query "last".
async function getLastLocation(token, placa) {
  const placaEscapada = placa.replace(/["\\]/g, "");
  const query = `{ last(serviceCodes: ["${placaEscapada}"]) { serviceCode latitude longitude generationDate } }`;
  const res = await fetch(`${SATRACK_EVENTS_API_BASE}/api/location`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Satrack eventos ubicacion -> ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json?.data?.last?.[0] ?? null;
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
// request acepta un array de placas -> se asume una llamada por placa (confirmar con una prueba
// real de 2+ placas si algun dia se necesita procesar en lote).
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
  // margen fijo (4h para carga, 24h para descarga) como placeholder razonable — ajustar si
  // Transloinsa define una regla de negocio real (ej. Cliente."Duración Máxima de Entrega").
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
        // Satrack rechaza recipientName vacio (400) -- algunos Cliente Destino tienen la Razón
        // Social sin llenar (solo RUC), usar el nombre de Destino."Cliente Entrega" como respaldo.
        recipientName: clienteDestino?.fields["Razón Social"] || destino.destino.fields["Cliente Entrega"] || "Cliente",
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
  // activos (recomendado para la primera corrida manual, ver plan_automatizacion_satrack.md).
  // BUG real corregido (2026-07-13): "!= 'Cancelado'" tambien dejaba pasar tickets "Completo" --
  // sin esto, cada corrida procesaba TODO el historial de tickets ya entregados de Transloinsa (no
  // solo los de hoy), lo que agoto el timeout del workflow. Debe ser el mismo filtro que la Pasada 2.
  const filterByFormula = process.env.SYNC_ONLY_TICKET_ID
    ? `{Id Ticket} = '${process.env.SYNC_ONLY_TICKET_ID}'`
    : "AND({Placa Unidad} != '', {Estado Ticket} = 'En proceso')";
  const tickets = await airtableListAll(TICKETS_TABLE, { filterByFormula });

  let ok = 0;
  let error = 0;
  const detalle = [];

  for (const ticket of tickets) {
    const ticketId = ticket.fields["Id Ticket"];
    try {
      // Se busca por airtable_record_id, NO por ticket_id -- "Id Ticket" es una formula que puede
      // cambiar de valor en cualquier momento (usa Documento de Transporte si esta lleno, si no
      // genera "YYYYMMDD-TCxxx"). airtable_record_id es el identificador real, inmutable, de
      // Airtable. Usar ticket_id aqui causo un SendTrips duplicado real en produccion (mismo ticket,
      // dos viajes en Satrack) el 2026-07-13 cuando alguien llenó Documento de Transporte a mitad
      // de camino.
      const { data: existing } = await supabase
        .from("viajes")
        .select("estado_envio")
        .eq("airtable_record_id", ticket.id)
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

      const { data: viajeRow } = await supabase
        .from("viajes")
        .upsert(
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
          { onConflict: "airtable_record_id" }
        )
        .select("id")
        .single();
      if (viajeRow) await asegurarEtapaInicial(viajeRow.id, ticketId);
      ok++;
    } catch (err) {
      error++;
      detalle.push({ ticket_id: ticketId, error: err.message });
      const { data: viajeRow } = await supabase
        .from("viajes")
        .upsert(
          {
            ticket_id: ticketId,
            airtable_record_id: ticket.id,
            placa_unidad: ticket.fields["Copia de Placa Unidad"] || "desconocida",
            estado_envio: "error",
            error_mensaje: err.message,
          },
          { onConflict: "airtable_record_id" }
        )
        .select("id")
        .single();
      if (viajeRow) await asegurarEtapaInicial(viajeRow.id, ticketId);
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

// Fallback cuando un cliente no tiene Areas calibradas -- sin poligonos, detectarZona() nunca sale
// de "en_ruta" y las etapas de llegada/descarga/entrega quedan sin poder detectarse aunque el punto
// (Origen/Destino) si exista. Genera dos circulos genericos centrados en ese punto (misma convencion
// de radios que se usa como sugerencia al calibrar a mano en el modulo Mapbox: ver
// documentos_satrack/calibracion_areas_clientes.md). Es puramente en memoria -- no se escribe en
// Airtable, así la tabla Areas queda solo con calibraciones reales validadas por KMZ/mano. En cuanto
// alguien calibra Areas de verdad para ese cliente, dejan de generarse estos circulos automaticamente
// (el llamador solo cae al fallback si areasFor() no encontro ninguna Area real para ese cliente).
const RADIO_FALLBACK_GENERAL = 180; // ~101,788 m^2
const RADIO_FALLBACK_ESPECIFICO = 60; // ~11,310 m^2

function makeCirclePolygon(lat, lng, radiusMeters, numSides = 32) {
  const R = 6378137;
  const lat0 = (lat * Math.PI) / 180;
  const coords = [];
  for (let i = 0; i <= numSides; i++) {
    const angle = (i / numSides) * 2 * Math.PI;
    const dLat = ((radiusMeters * Math.cos(angle)) / R) * (180 / Math.PI);
    const dLng = ((radiusMeters * Math.sin(angle)) / (R * Math.cos(lat0))) * (180 / Math.PI);
    coords.push([lng + dLng, lat + dLat]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {} };
}

function fallbackArea(lat, lng, tipo) {
  const radio = tipo === AREA_TIPO.BODEGA_DESTINO ? RADIO_FALLBACK_GENERAL : RADIO_FALLBACK_ESPECIFICO;
  return { fields: { Tipo: tipo, GeoJSON: JSON.stringify(makeCirclePolygon(lat, lng, radio)) } };
}

// areasFor() + fallback: por cada tipo (bodega_destino/area_descarga) que el cliente NO tenga
// calibrado de verdad, agrega un circulo generico centrado en el punto propio de ese Destino (siempre
// disponible, no requiere calibracion -- ver resolveDestino()). Es por tipo, no todo-o-nada -- si el
// cliente ya tiene, por ejemplo, bodega_destino real pero le falta area_descarga, solo se rellena la
// que falta y la real calibrada se sigue usando tal cual.
function areasParaDestinoConFallback(allAreas, clienteDestinoId, destinoRecord) {
  const areas = areasFor(allAreas, null, clienteDestinoId);
  if (!clienteDestinoId || destinoRecord?.fields.Latitud == null || destinoRecord?.fields.Longitud == null) {
    return areas;
  }
  const { Latitud: lat, Longitud: lng } = destinoRecord.fields;
  const tieneTipoReal = (tipo) =>
    areas.some((a) => a.fields["Cliente_Destino"]?.[0] === clienteDestinoId && normalize(a.fields["Tipo"]) === tipo);
  const relleno = [AREA_TIPO.BODEGA_DESTINO, AREA_TIPO.AREA_DESCARGA]
    .filter((tipo) => !tieneTipoReal(tipo))
    .map((tipo) => fallbackArea(lat, lng, tipo));
  return areas.concat(relleno);
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

// "Espera de Ruta" y "Fin de Entrega de Mercadería" no son zonas nuevas -- son la transicion de
// salir de la sub-zona especifica (area_carga/area_descarga) pero seguir dentro de la zona general
// (bodega_origen/bodega_destino). Con solo la zona actual no se puede distinguir "recien llegue a
// bodega_origen" de "sali de area_carga y volvi a bodega_origen" (ambas dan zona_actual=
// 'bodega_origen') -- hace falta la zona ANTERIOR para resolver la transicion correcta.
const TRANSICION_A_ETAPA = {
  "area_carga->bodega_origen": "Espera de Ruta",
  "area_descarga->bodega_destino": "Fin de Entrega de Mercadería",
};

function etapaParaTransicion(zonaAnterior, zonaNueva) {
  const clave = `${zonaAnterior}->${zonaNueva}`;
  if (TRANSICION_A_ETAPA[clave]) return TRANSICION_A_ETAPA[clave];
  // Salir de bodega_destino/area_descarga hacia "en_ruta" es el viaje terminando (se aleja del
  // cliente destino), no "otra vez en camino" -- no tiene sentido reabrir "En Ruta Destino" ahi. Se
  // cierra lo que estaba abierto sin abrir nada nuevo; trip.status=FINISHED (Pasada 2) termina de
  // marcar el viaje como completado poco despues.
  if (["bodega_destino", "area_descarga"].includes(zonaAnterior) && zonaNueva === "en_ruta") return null;
  return ZONA_TO_ETAPA[zonaNueva] ?? null;
}

// "Asignación Unidad" no depende de Satrack -- basta con que el ticket tenga Placa Unidad en
// Airtable (que es justo cuando se crea la fila en viajes, exitosa o con error). Se abre una sola
// vez por viaje; la cierra cerrarYAbrirEtapa() cuando se detecte la entrada real a bodega_origen.
async function asegurarEtapaInicial(viajeId, ticketId) {
  const { data: existe } = await supabase.from("etapas").select("id").eq("viaje_id", viajeId).limit(1).maybeSingle();
  if (existe) return;
  await supabase.from("etapas").insert({
    viaje_id: viajeId,
    ticket_id: ticketId,
    etapa: "Asignación Unidad",
    fecha_inicio: new Date().toISOString(),
    estado_evento: "En Proceso",
  });
}

async function cerrarYAbrirEtapa(viajeId, ticketId, etapaNombre) {
  await cerrarEtapaAbierta(viajeId);
  if (!etapaNombre) return; // transicion sin etapa asociada (ej. viaje terminando)
  await supabase.from("etapas").insert({
    viaje_id: viajeId,
    ticket_id: ticketId,
    etapa: etapaNombre,
    fecha_inicio: new Date().toISOString(),
    estado_evento: "En Proceso",
  });
}

async function cerrarEtapaAbierta(viajeId) {
  const { data: abierta } = await supabase
    .from("etapas")
    .select("id")
    .eq("viaje_id", viajeId)
    .eq("estado_evento", "En Proceso")
    .maybeSingle();
  if (abierta) {
    await supabase
      .from("etapas")
      .update({ fecha_fin: new Date().toISOString(), estado_evento: "Finalizado" })
      .eq("id", abierta.id);
  }
}

// trip.status terminal de Satrack -> zona_actual final. FINISHED es una entrega real completada;
// EXPIRED/CANCELLED son viajes que nunca se confirmaron o se cancelaron -- se marcan distinto
// ("cancelado") para no confundirlos con una entrega real en reportes.
const TRIP_STATUS_TERMINAL = {
  FINISHED: "completado",
  EXPIRED: "cancelado",
  CANCELLED: "cancelado",
  CANCELED: "cancelado",
};

// Pasada intermedia — detecta "Llegada Cliente Origen"/"Proceso Carga" para viajes que todavia
// estan en zona_actual='sin_asignar' (sin viaje en Satrack todavia, o el viaje no ha empezado a
// reportar). Usa la API de eventos de ubicacion (posicion cruda por placa, no requiere un "trip")
// -- por eso corre para TODOS los viajes sin_asignar sin importar si SendTrips tuvo exito o error
// (ej. ticket sin Destino: la unidad ya esta fisicamente en camino aunque no se le haya podido
// hacer SendTrips todavia). Opcional: si no hay credenciales de esta API, se salta sin romper nada.
async function pasadaAsignacionOrigen(eventsToken) {
  if (!eventsToken) return;

  const { data: viajesSinAsignar } = await supabase.from("viajes").select("*").eq("zona_actual", "sin_asignar");
  if (!viajesSinAsignar?.length) return;

  const allAreas = await airtableListAll("Areas");

  let ok = 0;
  let error = 0;
  const detalle = [];

  for (const viaje of viajesSinAsignar) {
    try {
      const loc = await getLastLocation(eventsToken, viaje.placa_unidad);
      if (!loc) continue; // sin evento de ubicacion todavia para esta placa

      const ticket = await airtableGetRecord(TICKETS_TABLE, viaje.airtable_record_id);
      const clienteOrigenId = ticket.fields["RUC Cliente"]?.[0];
      const areas = areasFor(allAreas, clienteOrigenId, null); // solo interesan las de origen aqui
      const point = { type: "Feature", geometry: { type: "Point", coordinates: [loc.longitude, loc.latitude] } };
      const zonaDetectada = detectarZona(point, areas);

      // detectarZona() cae en "en_ruta" por defecto si no esta dentro de ningun poligono -- eso no
      // aplica todavia en esta etapa (el viaje ni siquiera ha arrancado en Satrack), solo interesan
      // los dos poligonos de origen.
      if (zonaDetectada === "bodega_origen" || zonaDetectada === "area_carga") {
        await cerrarYAbrirEtapa(viaje.id, viaje.ticket_id, etapaParaTransicion(viaje.zona_actual, zonaDetectada));
        await supabase.from("viajes").update({ zona_actual: zonaDetectada }).eq("id", viaje.id);
        ok++;
      }
    } catch (err) {
      error++;
      detalle.push({ ticket_id: viaje.ticket_id, error: err.message });
    }
  }

  await supabase.from("log_sincronizacion").insert({
    pasada: "asignacion_origen",
    tickets_procesados: viajesSinAsignar.length,
    tickets_ok: ok,
    tickets_error: error,
    detalle,
  });

  console.log(`Pasada asignación origen: ${ok} con cambio de zona, ${error} con error de ${viajesSinAsignar.length} viajes sin asignar.`);
}

// Pasada de recuperación — un viaje puede quedar zona_actual='cancelado' (trip EXPIRED/CANCELLED
// en Satrack) mientras el ticket real sigue "En proceso" en Airtable: se perdió el rastreo, pero el
// envío físico puede seguir en curso. No basta con mirar Airtable para decidir si reintentar
// SendTrips -- Airtable puede estar simplemente sin actualizar (nadie cerró el ticket todavía)
// aunque el camión ya haya entregado. Se usa la posición real (API de eventos) contra las Areas de
// destino: si el camión ya está ahí, se asume entregado (no se reintenta, evita un viaje fantasma
// en Satrack); si sigue lejos, se reactiva para que la Pasada 1 vuelva a intentar en esta misma
// corrida.
async function pasadaRecuperarCancelados(eventsToken) {
  const { data: cancelados } = await supabase
    .from("viajes")
    .select("*")
    .eq("zona_actual", "cancelado")
    .eq("estado_envio", "enviado");
  if (!cancelados?.length) return;

  const allAreas = await airtableListAll("Areas");

  let reactivados = 0;
  let confirmadosCompletos = 0;
  let error = 0;
  const detalle = [];

  for (const viaje of cancelados) {
    try {
      const ticket = await airtableGetRecord(TICKETS_TABLE, viaje.airtable_record_id);
      if (ticket.fields["Estado Ticket"] !== "En proceso") continue; // Airtable ya lo cerró, nada que hacer

      if (!eventsToken) continue; // sin API de eventos no se puede confirmar posición -> no reintentar a ciegas

      const loc = await getLastLocation(eventsToken, viaje.placa_unidad);
      if (!loc) continue; // sin dato de ubicación todavia

      const destinoRecordId = ticket.fields["Destino 2"]?.[0];
      const destinoRecord = destinoRecordId ? await airtableGetRecord("Destino", destinoRecordId) : null;
      const clienteDestinoId = destinoRecord?.fields["Cliente Destino"]?.[0];
      const areas = areasParaDestinoConFallback(allAreas, clienteDestinoId, destinoRecord); // solo interesan las de destino aqui
      const point = { type: "Feature", geometry: { type: "Point", coordinates: [loc.longitude, loc.latitude] } };
      const zonaDetectada = detectarZona(point, areas);

      if (zonaDetectada === "bodega_destino" || zonaDetectada === "area_descarga") {
        // Ya esta en destino -- lo mas probable es que ya se entrego y Satrack solo perdio el trip
        // antes de reportar FINISHED. No reintentar SendTrips (crearia un viaje fantasma en Satrack
        // para un envio que ya terminó).
        await supabase.from("viajes").update({ zona_actual: "completado" }).eq("id", viaje.id);
        confirmadosCompletos++;
      } else {
        // Sigue lejos del destino -- el envio real probablemente sigue en curso, solo se perdió el
        // rastreo. Se reactiva (estado_envio vuelve a 'error') para que la Pasada 1, en esta misma
        // corrida, intente un SendTrips nuevo.
        // zona_actual vuelve a 'sin_asignar' (no se deja en 'cancelado', que es terminal -- si no
        // se resetea, la Pasada 2 nunca vuelve a rastrear el viaje nuevo aunque SendTrips funcione).
        await supabase
          .from("viajes")
          .update({
            estado_envio: "error",
            error_mensaje: "Viaje anterior quedó cancelado/expirado en Satrack sin llegar a destino — reintentando SendTrips",
            satrack_trip_id: null,
            zona_actual: "sin_asignar",
          })
          .eq("id", viaje.id);
        reactivados++;
      }
    } catch (err) {
      error++;
      detalle.push({ ticket_id: viaje.ticket_id, error: err.message });
    }
  }

  await supabase.from("log_sincronizacion").insert({
    pasada: "recuperar_cancelados",
    tickets_procesados: cancelados.length,
    tickets_ok: reactivados + confirmadosCompletos,
    tickets_error: error,
    detalle,
  });

  console.log(
    `Pasada recuperar cancelados: ${reactivados} reactivados, ${confirmadosCompletos} confirmados como completados, ${error} con error de ${cancelados.length} revisados.`
  );
}

async function pasada2RevisarEtapas(token) {
  const { data: viajesActivos } = await supabase
    .from("viajes")
    .select("*")
    .eq("estado_envio", "enviado")
    .not("zona_actual", "in", "(completado,cancelado)");

  // Se trae Areas una sola vez por corrida (antes se re-listaba la tabla completa por cada viaje
  // activo -> con varios viajes simultaneos eso solo ya se comia buena parte del timeout).
  const allAreas = (viajesActivos ?? []).length ? await airtableListAll("Areas") : [];

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

      const zonaTerminal = TRIP_STATUS_TERMINAL[body.trip?.status];
      if (zonaTerminal) {
        await cerrarEtapaAbierta(viaje.id);
        await supabase.from("viajes").update({ zona_actual: zonaTerminal }).eq("id", viaje.id);
        ok++;
        continue; // viaje terminado -- no tiene sentido seguir con deteccion de zona por coordenada
      }

      const coordinate = body.vehicleCurrentState?.coordinate;
      if (!coordinate || coordinate.length !== 2) continue;

      const ticket = await airtableGetRecord(TICKETS_TABLE, viaje.airtable_record_id);
      const clienteOrigenId = ticket.fields["RUC Cliente"]?.[0];
      const destinoRecordId = ticket.fields["Destino 2"]?.[0];
      const destinoRecord = destinoRecordId ? await airtableGetRecord("Destino", destinoRecordId) : null;
      const clienteDestinoId = destinoRecord?.fields["Cliente Destino"]?.[0];

      const areas = areasFor(allAreas, clienteOrigenId, null).concat(
        areasParaDestinoConFallback(allAreas, clienteDestinoId, destinoRecord)
      );
      const zonaNueva = detectarZona(toFeature(coordinate), areas);

      if (zonaNueva !== viaje.zona_actual) {
        await cerrarYAbrirEtapa(viaje.id, viaje.ticket_id, etapaParaTransicion(viaje.zona_actual, zonaNueva));
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

  // Credenciales de la API de eventos son opcionales -- si fallan o no estan puestas, se saltan las
  // pasadas que dependen de ella sin tumbar el resto del sync. Se obtiene ANTES de la Pasada 1 para
  // que un ticket reactivado por pasadaRecuperarCancelados alcance a procesarse en la misma corrida.
  let eventsToken = null;
  if (SATRACK_EVENTS_CLIENT_ID && SATRACK_EVENTS_CLIENT_SECRET) {
    try {
      eventsToken = await getSatrackEventsToken();
    } catch (err) {
      console.warn(`No se pudo autenticar con la API de eventos de ubicación: ${err.message}`);
    }
  }
  await pasadaRecuperarCancelados(eventsToken);
  await pasada1CrearViajes(token);
  await pasadaAsignacionOrigen(eventsToken);
  await pasada2RevisarEtapas(token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
