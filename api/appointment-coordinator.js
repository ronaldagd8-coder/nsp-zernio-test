import { timingSafeEqual } from "node:crypto";

const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const BOOKING_FIELD_NAME = "booking_state";
const MAX_HISTORY_MESSAGES = 15;

export const config = {
  maxDuration: 60,
};

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;
  const received = Buffer.from(String(receivedSecret));
  const expected = Buffer.from(String(expectedSecret));
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function normalizeText(value, maxLength = 2000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeForIntent(value) {
  return normalizeText(value, 200)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const DFW_LOCATION_PATTERN = /\b(dallas|fort worth|arlington|plano|frisco|mckinney|denton|lewisville|carrollton|richardson|garland|irving|grand prairie|mesquite|allen|grapevine|southlake|coppell|addison|farmers branch|the colony|little elm|prosper|celina|aubrey|flower mound|highland village|keller|roanoke|trophy club|north richland hills|haltom city|hurst|euless|bedford|mansfield|burleson|crowley|aledo|weatherford|rockwall|rowlett|sachse|wylie|murphy|forney|terrell|waxahachie|midlothian|cedar hill|desoto|duncanville|lancaster|red oak|ennis|cleburne|granbury|decatur)\b/;
const CLEARLY_OUTSIDE_DFW_TEXAS_PATTERN = /\b(houston|austin|san antonio|el paso|corpus christi|lubbock|amarillo|midland|odessa|waco|killeen|temple|beaumont|mcallen|laredo|brownsville|galveston|tyler|longview|abilene|college station|bryan)\b/;
const NON_TEXAS_STATE_PATTERN = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oclajoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/;
const NON_TEXAS_POSTAL_CODE_PATTERN = /(?:,\s*|\b(?:in|en)\s+)(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|ut|vt|va|wa|wv|wi|wy)(?:\s+\d{5}(?:-\d{4})?|\s*$)/;

function serviceAreaSignal(value) {
  const text = normalizeForIntent(value);
  if (!text) return "unknown";
  if (DFW_LOCATION_PATTERN.test(text)) return "inside_dfw";
  if (
    NON_TEXAS_STATE_PATTERN.test(text) ||
    NON_TEXAS_POSTAL_CODE_PATTERN.test(text) ||
    CLEARLY_OUTSIDE_DFW_TEXAS_PATTERN.test(text)
  ) {
    return "outside_dfw";
  }
  return "unknown";
}

function isPlausiblePropertyTypeAnswer(value) {
  const text = normalizeForIntent(value);
  if (!isSpecificPropertyType(text)) return false;
  if (serviceAreaSignal(text) !== "unknown") return false;
  if (
    /\b(el |the )?(trabajo|proyecto|propiedad|work|project|property) (es|esta|queda|seria|is|would be|is located) (en|in)\b/.test(
      text,
    ) ||
    /\b(ubicad[oa] en|located in|direccion|address|ciudad|city|estado|state|codigo postal|zip)\b/.test(
      text,
    )
  ) {
    return false;
  }
  return true;
}

function projectScopeSupportedByCurrentMessage(scope, currentMessage) {
  const stopWords = new Set([
    "para", "quiero", "necesito", "otra", "nuevo", "nueva", "cita", "visita",
    "proyecto", "trabajo", "servicio", "the", "for", "want", "need", "another",
    "new", "appointment", "visit", "project", "work", "service", "with", "and",
  ]);
  const stems = (value) =>
    normalizeForIntent(value)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !stopWords.has(token))
      .map((token) => token.slice(0, 4));
  const scopeStems = stems(scope);
  const messageStems = new Set(stems(currentMessage));
  return scopeStems.some((stem) => messageStems.has(stem));
}

function isSiteAccessQuestion(value) {
  const text = normalizeForIntent(value);
  if (!text || text.length > 1000) return false;
  return /\b(si no hay nadie|si no hubiese nadie|si no esta nadie|tiene que haber (a )?alguien|tendria que haber (a )?alguien|debe haber (a )?alguien|alguien (debe|tiene que|tendria que) estar|alguien presente|pueden entrar|podrian entrar|entrarian ustedes|ustedes entrarian|dar acceso|facilitar el acceso|without anyone there|if nobody is there|if no one is there|does someone need to be there|must someone be present|need someone present|can you enter|could you enter|access the property)\b/.test(
    text,
  );
}

function isSiteVisitEvaluationClarification(value) {
  const text = normalizeForIntent(value);
  if (!text || text.length > 1000) return false;
  return /\b(no es para (la )?instalacion|no van a instalar|not for (the )?installation)\b/.test(text) &&
    /\b(ver|vean|vea|revisar|revisen|evaluar|evaluen|inspeccionar|inspeccionen|visita|evaluacion|inspeccion|see|review|evaluate|inspect|walkthrough|site visit)\b/.test(
      text,
    );
}

function recentHistoryHasSiteAccessContext(history) {
  const recent = Array.isArray(history) ? history.slice(-6).join("\n") : "";
  return isSiteAccessQuestion(recent) ||
    /\b(alguien presente|facilitar el acceso|someone present|provide access)\b/.test(
      normalizeForIntent(recent),
    );
}

function siteAccessReply(language) {
  return language === "es"
    ? "Para una visita de evaluación debe estar presente una persona autorizada para proporcionar acceso, salvo que el equipo haya aprobado previamente por escrito otra modalidad. NEXT SOLUTIONS PARTNERS no entrará por su cuenta sin autorización expresa."
    : "For an evaluation visit, an authorized person must be present to provide access unless the team has approved another arrangement in writing beforehand. NEXT SOLUTIONS PARTNERS will not enter the property without express authorization.";
}

function isDirectConfirmation(value) {
  const text = normalizeForIntent(value);
  if (!text || text.length > 120) return false;

  if (
    /^(no|no gracias|no confirmo|cancelar|cancela|cancel|stop|detener)\b/.test(text)
  ) {
    return false;
  }

  return /^(si|yes|confirmo|confirm|confirmed|correcto|correct|de acuerdo|ok|okay|adelante|proceder|proceed)\b/.test(
    text,
  );
}

function isDirectRejection(value) {
  const text = normalizeForIntent(value);
  if (!text || text.length > 120) return false;
  return /^(no|no gracias|no confirmo|incorrecto|cambiar|quiero cambiar|otra fecha|no|no thanks|do not confirm|incorrect|change|change it|another date)\b/.test(
    text,
  );
}

function isExplicitBookingCancellation(value) {
  const text = normalizeForIntent(value);
  if (!text || text.length > 300) return false;
  return /\b(cancela(r)? (eso|la cita|la visita|la solicitud|la reserva)|cancelar (eso|la cita|la visita|la solicitud|la reserva)|olvida (eso|la cita|la visita|la solicitud|la reserva)|cancel (that|the appointment|the visit|the request|the booking)|forget (that|the appointment|the visit|the request|the booking))\b/.test(
    text,
  );
}

function asksToAddressAnotherQuestion(value) {
  const text = normalizeForIntent(value);
  return /\b(respondeme (la|esa|mi) pregunta|contesta(me)? (la|esa|mi) pregunta|primero (dime|respondeme|contesta)|answer (the|that|my) question|first (tell me|answer))\b/.test(
    text,
  );
}

function detectConfirmedCommercialService(value) {
  const text = normalizeForIntent(value);
  if (!text) return null;

  const services = [
    ["dataAutomation", /\b(data|datos|automation|automatizacion|cableado|cabling|network|red|wifi|wi-fi|security systems?|sistemas? de seguridad)\b/],
    ["fireSystems", /\b(fire systems?|fire protection|sistemas? contra incendios)\b/],
    ["gasLine", /\b(gas lines?|lineas? de gas)\b/],
    ["roofing", /\b(roofing|roof|techo|techado)\b/],
    ["hvac", /\b(hvac|aire acondicionado|refrigeracion|refrigeration)\b/],
    ["electrical", /\b(electricidad|electrico|electrical)\b/],
    ["plumbing", /\b(plomeria|plumbing)\b/],
    ["painting", /\b(pintura|painting)\b/],
    ["drywall", /\b(drywall|panel de yeso)\b/],
    ["framing", /\b(framing|estructura)\b/],
  ];

  return services.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function isServiceExplanationQuestion(value) {
  const text = normalizeForIntent(value);
  return /\b(que tipo|cual tipo|que incluye|en que consiste|explica|mas informacion|what kind|what type|what does it include|explain|more information)\b/.test(
    text,
  );
}

function isServiceCapabilityQuestion(value) {
  const raw = normalizeText(value, 500);
  const text = normalizeForIntent(value);
  if (!text || text.length > 500) return false;

  const knownService = Boolean(detectConfirmedCommercialService(text));

  const asksCapability =
    /\b(tambien|ademas) (hacen|ofrecen|realizan|trabajan|atienden)\b|\b(ustedes )?(hacen|ofrecen|realizan|trabajan con|atienden)\b|\bquiero saber si (hacen|ofrecen|realizan)\b|\b(do you also|can you also|do you offer|do you provide|can you handle|do you work with)\b/.test(
      text,
    );

  const shortFollowUp =
    /^(y|e|and|what about)\b/.test(text) && knownService;
  const trailingAlsoQuestion =
    knownService && /\b(tambien|also)\s*\??$/.test(text);
  const bareServiceQuestion =
    knownService && /\?\s*$/.test(raw) && text.split(/\s+/).length <= 8;

  return asksCapability || shortFollowUp || trailingAlsoQuestion || bareServiceQuestion;
}

function confirmedServiceReply(service, language) {
  const replies = {
    framing: ["Sí, realizamos trabajos de framing comercial.", "Yes, we provide commercial framing services."],
    drywall: ["Sí, realizamos trabajos de drywall comercial.", "Yes, we provide commercial drywall services."],
    electrical: ["Sí, realizamos trabajos de electricidad comercial.", "Yes, we provide commercial electrical services."],
    hvac: ["Sí, realizamos trabajos comerciales de HVAC y refrigeración.", "Yes, we provide commercial HVAC and refrigeration services."],
    plumbing: ["Sí, realizamos trabajos de plomería comercial.", "Yes, we provide commercial plumbing services."],
    fireSystems: ["Sí, realizamos trabajos de sistemas contra incendios para propiedades comerciales.", "Yes, we provide fire-system services for commercial properties."],
    gasLine: ["Sí, realizamos trabajos comerciales de líneas de gas.", "Yes, we provide commercial gas-line services."],
    painting: ["Sí, realizamos trabajos de pintura comercial.", "Yes, we provide commercial painting services."],
    roofing: ["Sí, realizamos trabajos de roofing comercial.", "Yes, we provide commercial roofing services."],
    dataAutomation: ["Sí, ofrecemos servicios comerciales de data y automatización.", "Yes, we provide commercial data and automation services."],
  };
  const pair = replies[service];
  return pair ? pair[language === "es" ? 0 : 1] : null;
}

function isResumeBookingIntent(value) {
  const text = normalizeForIntent(value);
  if (!text || text.length > 300) return false;
  return /\b(sigamos|continuemos|seguir con|seguimos con|retomemos|retomar|continuar con) (la )?(reservacion|reserva|solicitud|cita|visita|agenda)|\b(continue|resume|go back to) (with |the )?(booking|appointment|request|site visit)\b/.test(
    text,
  );
}

function isAddressCorrectionIntent(value) {
  const text = normalizeForIntent(value);
  if (!text || text.length > 500) return false;
  const correctionLanguage =
    /\b(no es|esta mal|direccion correcta|dirección correcta|me equivoque|quise decir|corrige|corregir|is not|isn't|wrong address|correct address|i meant|change the address)\b/.test(
      text,
    );
  const addressSignal =
    /\b(direccion|address|calle|street|avenue|ave|road|rd|drive|dr|boulevard|blvd|ciudad|city|estado|state|zip|codigo postal|texas|tx)\b/.test(
      text,
    );
  return correctionLanguage && addressSignal;
}

function extractExplicitOnlyService(value) {
  const text = normalizeForIntent(value).replace(/[.!?]+$/g, "").trim();
  const match = /^(?:no[, ]+)?(?:mejor\s+)?(?:solo|solamente|only)\s+(?:la |el |the )?(.+)$/.exec(text);
  if (!match) return null;
  const service = normalizeText(match[1], 300);
  return service || null;
}

function serviceScopeLabel(service, language) {
  const labels = {
    framing: ["framing", "framing"],
    drywall: ["drywall", "drywall"],
    electrical: ["electricidad", "electrical work"],
    hvac: ["HVAC y refrigeración", "HVAC and refrigeration"],
    plumbing: ["plomería", "plumbing"],
    fireSystems: ["sistemas contra incendios", "fire systems"],
    gasLine: ["líneas de gas", "gas-line work"],
    painting: ["pintura", "painting"],
    roofing: ["roofing", "roofing"],
    dataAutomation: ["data y automatización", "data and automation"],
  };
  const pair = labels[service];
  return pair ? pair[language === "es" ? 0 : 1] : null;
}

function specificIncludedScopeLabel(value, language) {
  const text = normalizeForIntent(value);
  if (!text) return null;

  if (/\b(aire acondicionado|air conditioning|a\/c|ac unit|ac system)\b/.test(text)) {
    const asksForReview =
      /\b(revisar|revisen|vean|chequear|inspeccionar|check|inspect|look at)\b/.test(text);
    if (language === "es") {
      return asksForReview ? "revisar el aire acondicionado" : "aire acondicionado";
    }
    return asksForReview
      ? "inspect the air-conditioning system"
      : "air-conditioning work";
  }

  if (/\b(refrigeracion|refrigeration|walk-in cooler|walk in cooler)\b/.test(text)) {
    return language === "es" ? "refrigeración" : "refrigeration work";
  }

  return null;
}

function extractExplicitIncludedService(value, language) {
  const text = normalizeForIntent(value).replace(/[.!?]+$/g, "").trim();
  const match = /^(?:(?:quiero|deseo|necesito)\s+)?(?:incluir|agregar|anadir|incluye|agrega|include|add)\s+(?:la |el |the )?(.+?)(?:\s+(?:en|para)\s+(?:la\s+)?(?:visita|solicitud|cita|reserva)|\s+(?:to|in|for)\s+(?:the\s+)?(?:visit|request|appointment|booking))?$/.exec(text);
  if (match) {
    const service = normalizeText(match[1], 300);
    if (service) return service;
  }

  const hasInclusionIntent =
    /\b(agrega|agregues|agregar|agreguemos|incluye|incluyas|incluir|anade|anadas|anadamos|add|include)\b/.test(
      text,
    );
  if (!hasInclusionIntent) return null;

  const specificScope = specificIncludedScopeLabel(text, language);
  if (specificScope) return specificScope;

  const confirmedService = detectConfirmedCommercialService(text);
  return confirmedService
    ? serviceScopeLabel(confirmedService, language === "es" ? "es" : "en")
    : null;
}

function inferPropertyTypeFromMessage(value, language) {
  const text = normalizeForIntent(value);
  if (!text) return null;

  const propertyTypes = [
    [/\b(oficina|office)\b/, ["oficina", "office"]],
    [/\b(restaurante|restaurant)\b/, ["restaurante", "restaurant"]],
    [/\b(tienda|retail store|storefront|store)\b/, ["tienda", "retail store"]],
    [/\b(almacen|bodega|warehouse)\b/, ["almacén", "warehouse"]],
    [/\b(hotel|motel)\b/, ["hotel", "hotel"]],
    [/\b(iglesia|church)\b/, ["iglesia", "church"]],
    [/\b(escuela|colegio|school)\b/, ["escuela", "school"]],
    [/\b(clinica|consultorio|clinic|medical office|dental office)\b/, ["consultorio", "medical office"]],
  ];

  const matched = propertyTypes.find(([pattern]) => pattern.test(text));
  return matched ? matched[1][language === "es" ? 0 : 1] : null;
}

function normalizeProjectScope(value, propertyType) {
  let scope = normalizeText(value, 2000);
  if (!scope) return "";

  scope = scope
    .replace(/\b(?:uno|una|un)\s+toma\s*corrientes?\b/gi, "un tomacorriente")
    .replace(/\btoma\s*corrientes?\b/gi, "tomacorriente")
    .replace(/\b(?:one|an?)\s+electrical outlet\b/gi, "an electrical outlet")
    .replace(/\s+/g, " ")
    .trim();

  const normalizedProperty = normalizeForIntent(propertyType);
  if (normalizedProperty === "oficina" || normalizedProperty === "office") {
    scope = scope
      .replace(/\s+en\s+(?:mi\s+|la\s+)?oficina\s*$/i, "")
      .replace(/\s+in\s+(?:my\s+|the\s+)?office\s*$/i, "")
      .trim();
  }

  return scope;
}

function mergeProjectScopes(currentScope, includedService, language = "es") {
  const current = normalizeText(currentScope, 2000);
  const included = normalizeText(includedService, 300);
  if (!current) return included;
  if (!included) return current;
  if (normalizeForIntent(current).includes(normalizeForIntent(included))) return current;
  return `${current}${language === "es" ? " y " : " and "}${included}`;
}

function capitalizeFirst(value) {
  const text = normalizeText(value, 120);
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "";
}

function scopeChangeAcknowledgement({ onlyService, includedService, state, language }) {
  const firstName = capitalizeFirst(getFirstName(state));
  const addressedName = firstName ? `, ${firstName}` : "";
  if (onlyService) {
    return language === "es"
      ? `Entendido${addressedName}. Dejaremos únicamente ${onlyService} para la visita.`
      : `Understood${addressedName}. We will keep the visit scope limited to ${onlyService}.`;
  }
  if (includedService) {
    return language === "es"
      ? `Perfecto${addressedName}. Entonces la visita incluirá ${state.projectScope}.`
      : `Perfect${addressedName}. The visit will include ${state.projectScope}.`;
  }
  return "";
}

function prependAcknowledgement(acknowledgement, reply) {
  return acknowledgement ? `${acknowledgement} ${reply}` : reply;
}

function isEmojiOnlyMessage(value) {
  const text = normalizeText(value, 500);
  if (!text) return false;

  const remainder = text.replace(
    /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\s]/gu,
    "",
  );

  return remainder.length === 0;
}

export function isCourtesyOnlyMessage(value) {
  const text = normalizeForIntent(value)
    .replace(/[.!?,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 80) return false;
  return /^(gracias|muchas gracias|mil gracias|gracias por todo|chevere( gracias)?|listo( gracias)?|perfecto( gracias)?|dale( gracias)?|ok( gracias| perfecto| excelente)?|esta bien|entendido|nos vemos|thank you|thanks|thanks a lot|perfect( thank you)?|great( thanks)?|all set( thanks)?|okay( thanks)?|ok( thanks)?|see you)$/.test(
    text,
  );
}

export function isGreetingOnlyMessage(value) {
  const text = normalizeForIntent(value)
    .replace(/[.!?,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 80) return false;
  return /^(hola|hola buenos dias|hola buenas tardes|hola buenas noches|buenos dias|buenas tardes|buenas noches|hello|hi|hey|good morning|good afternoon|good evening)$/.test(
    text,
  );
}

export function isResidentialPropertyMessage(value) {
  const text = normalizeForIntent(value);
  return /\b(mi casa|en casa|casa residencial|vivienda|residencia|residencial|my house|my home|at home|residential|residence)\b/.test(text);
}

function selectsPreviousProperty(value) {
  const text = normalizeForIntent(value);
  return /^(si|sí|yes|la misma|esa misma|misma direccion|misma propiedad|same one|same address|same property)\b/.test(text);
}

function selectsAnotherProperty(value) {
  const text = normalizeForIntent(value);
  return /\b(otra direccion|otra propiedad|otro local|otra ubicacion|different address|another property|different property|another location)\b/.test(text);
}

function selectedKnownPropertyIndex(value, maximum) {
  const text = normalizeForIntent(value);
  const match = /^(?:opcion |option )?([1-3])\b/.exec(text);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < maximum ? index : null;
}

function extractEmail(value) {
  const match = normalizeText(value, 500).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase() ?? null;
}

function declinesEmail(value) {
  const text = normalizeForIntent(value);
  return /^(no|no gracias|solo whatsapp|por whatsapp|sin correo|prefiero whatsapp|skip|no thanks|whatsapp only|no email|i prefer whatsapp)\b/.test(text);
}

function isClearlyOutOfScopeService(value) {
  const text = normalizeForIntent(value);
  if (!text) return false;
  return /\b(tapizar|tapizado|tapiceria|retapizar|upholster|upholstery|reupholster|reupholstery|reparar (una |varias )?sillas?|reparacion de (una |varias )?sillas?|repair (a |the )?chairs?|chair repair|reparar muebles?|reparacion de muebles?|furniture repair|limpieza general|limpieza de pisos?|servicio de limpieza|servicios de limpieza|conserjeria|aseo general|janitorial|general cleaning|floor cleaning|housekeeping|maid service)\b/.test(
    text,
  );
}

function isReviewableCommercialSupportService(value) {
  const text = normalizeForIntent(value);
  if (!text) return false;
  return /\b(limpieza|cleaning|desengrase|degreasing|mantenimiento|maintenance)\b/.test(text) &&
    /\b(campana|campanas|hood|hoods|cocina industrial|cocinas industriales|commercial kitchen|commercial kitchens|kitchen exhaust|extractor de cocina|extractores de cocina)\b/.test(text);
}

function isWebsiteDevelopmentRequest(value) {
  const text = normalizeForIntent(value);
  if (!text) return false;
  if (isWebsiteReferralMessage(value)) return false;
  return /\b(quiero|necesito|pueden|puedes|hacen|hacer|crear|desarrollar|construir|disenar|build|create|develop|design|make|need|want)\b/.test(text) &&
    /\b(pagina web|sitio web|web page|website|web site|una web|desarrollo web|web development)\b/.test(text);
}

export function isWebsiteReferralMessage(value) {
  const text = normalizeForIntent(value);
  if (!text) return false;
  return /\b(contactando|contacto|escribiendo|llegue|vengo|contacting|reaching out|messaging|came|found you)\b/.test(text) &&
    /\b(desde|por|through|from|via)\b/.test(text) &&
    /\b(su pagina web|la pagina web|el sitio web|your website|the website|website link|web site)\b/.test(text);
}

export function getWebsiteReferralReply(language, firstName = "") {
  const name = formatPersonName(firstName).split(/\s+/)[0] || "";
  return language === "es"
    ? `Gracias${name ? `, ${name},` : ""} por contactarnos desde nuestra página web. ¿En qué podemos ayudarte con tu proyecto comercial?`
    : `Thank you${name ? `, ${name},` : ""} for reaching out through our website. How can NEXT SOLUTIONS PARTNERS assist you with your commercial project?`;
}

export function recentHistoryHasWebsiteProjectRedirect(history) {
  const recent = normalizeForIntent(
    Array.isArray(history) ? history.slice(-6).join("\n") : "",
  );
  return (
    /no ofrecemos desarrollo de paginas web/.test(recent) &&
    /trabajo comercial de construccion o remodelacion/.test(recent)
  ) || (
    /do not provide website development/.test(recent) &&
    /commercial construction or remodeling project/.test(recent)
  );
}

export function hasActiveWebsiteProjectFollowUp(state, now = Date.now()) {
  if (state?.awaitingWebsiteProjectFollowUp !== true) return false;
  const markedAt = Date.parse(state?.websiteProjectFollowUpAt ?? "");
  return Number.isFinite(markedAt) && now - markedAt >= 0 && now - markedAt <= 30 * 60 * 1000;
}

function getWebsiteDevelopmentReply(language) {
  return language === "es"
    ? "Gracias por consultarnos. NEXT SOLUTIONS PARTNERS se especializa en construcción, remodelación y reparaciones de propiedades comerciales, por lo que no ofrecemos desarrollo de páginas web."
    : "Thank you for contacting us. NEXT SOLUTIONS PARTNERS specializes in commercial construction, remodeling, and facility repairs, so we do not provide website development.";
}

export function getOutOfScopeReply(language) {
  return language === "es"
    ? "Gracias por consultarnos. Esa solicitud no corresponde a los servicios de construcción, remodelación o reparación de instalaciones comerciales que ofrece NEXT SOLUTIONS PARTNERS, por lo que no puedo programar una visita para ese servicio."
    : "Thank you for checking with us. That request is outside the commercial construction, remodeling, and building-repair services offered by NEXT SOLUTIONS PARTNERS, so I cannot schedule a visit for that service.";
}

function formatPersonName(value) {
  const name = normalizeText(value, 500);
  if (!name) return "";
  const hasIntentionalInternalCapital = name
    .split(/[\s'-]+/)
    .some((part) => /\p{Ll}\p{Lu}/u.test(part));
  if (hasIntentionalInternalCapital) return name;
  return name.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toUpperCase());
}

function getFirstName(state) {
  return formatPersonName(state?.customerName).split(/\s+/)[0] || "";
}

function safeJsonParse(value, fallback = null) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function defaultState() {
  return {
    active: false,
    stage: "idle",
    language: null,
    customerName: null,
    companyName: null,
    propertyType: null,
    projectAddress: null,
    projectScope: null,
    email: null,
    emailAsked: false,
    previousPropertyAddress: null,
    previousPropertyType: null,
    knownProperties: [],
    preferredDate: null,
    preferredPeriod: null,
    offeredSlots: [],
    selectedStart: null,
    selectedDisplay: null,
    eventId: null,
    awaitingWebsiteProjectFollowUp: false,
    websiteProjectFollowUpAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeState(value) {
  const parsed = safeJsonParse(value, {});
  const storedPropertyType = normalizeText(parsed?.propertyType, 500);
  const storedProjectAddress = normalizeText(parsed?.projectAddress, 500);
  return {
    ...defaultState(),
    ...(parsed && typeof parsed === "object" ? parsed : {}),
    customerName: formatPersonName(parsed?.customerName) || null,
    propertyType:
      storedPropertyType && isPlausiblePropertyTypeAnswer(storedPropertyType)
        ? storedPropertyType
        : null,
    projectAddress:
      storedProjectAddress && serviceAreaSignal(storedProjectAddress) !== "outside_dfw"
        ? storedProjectAddress
        : null,
    offeredSlots: Array.isArray(parsed?.offeredSlots) ? parsed.offeredSlots.slice(0, 3) : [],
    knownProperties: Array.isArray(parsed?.knownProperties) ? parsed.knownProperties.slice(0, 3) : [],
  };
}

async function zernioFetch(path, options = {}) {
  return fetch(`${ZERNIO_API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
}

function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}

async function resolveContactId(identifier) {
  if (!identifier) return null;

  const normalizedIdentifier = normalizeText(String(identifier), 200);
  const looksLikePhone = /^\+?\d{7,15}$/.test(
    normalizedIdentifier.replace(/[\s().-]/g, ""),
  );

  if (!looksLikePhone) {
    const directResponse = await zernioFetch(
      `/contacts/${encodeURIComponent(normalizedIdentifier)}`,
    );

    if (directResponse.ok) {
      const directData = await directResponse.json();
      return directData?.contact?.id ?? directData?.id ?? normalizedIdentifier;
    }
  }

  const targetPhone = normalizePhone(identifier);
  if (!targetPhone) return null;

  const listResponse = await zernioFetch(
    "/contacts?platform=whatsapp&limit=200",
  );

  if (!listResponse.ok) return null;

  const listData = await listResponse.json();
  const contacts = Array.isArray(listData?.contacts)
    ? listData.contacts
    : Array.isArray(listData?.data?.contacts)
      ? listData.data.contacts
      : Array.isArray(listData?.data)
        ? listData.data
        : [];

  const contact = contacts.find((candidate) => {
    const candidateNumbers = [
      candidate?.phone,
      candidate?.platformIdentifier,
      candidate?.displayIdentifier,
    ]
      .map(normalizePhone)
      .filter(Boolean);

    return candidateNumbers.includes(targetPhone);
  });

  return contact?.id ?? contact?._id ?? null;
}

function extractContactIdentifier(body) {
  return normalizeText(
    body?.contactId ??
      body?.contact?.id ??
      body?.contact?._id ??
      body?.contact?.contactId ??
      body?.variables?.contactId ??
      body?.variables?.contact?.id ??
      body?.variables?.contact?._id ??
      body?.vars?.contactId ??
      body?.vars?.contact?.id ??
      body?.contact?.phone ??
      body?.contact?.platformIdentifier ??
      body?.contact?.displayIdentifier,
    200,
  );
}

function extractConversationId(body) {
  return normalizeText(
    body?.conversationId ??
      body?.event?.conversationId ??
      body?.variables?.conversationId ??
      body?.vars?.conversationId,
    200,
  );
}

function extractCurrentMessage(body) {
  const transcript = normalizeText(
    body?.voiceTranscript ??
      body?.variables?.voiceInput?.body?.transcript ??
      body?.variables?.voiceInput?.transcript ??
      body?.vars?.voiceInput?.body?.transcript ??
      body?.vars?.voiceInput?.transcript,
  );
  if (transcript) return transcript;

  return normalizeText(
    body?.messageText ??
      body?.message?.body ??
      body?.message?.text ??
      body?.event?.message?.body ??
      body?.event?.message?.text ??
      body?.event?.message ??
      body?.variables?.message?.body ??
      body?.variables?.message?.text ??
      body?.variables?.messageBody ??
      body?.vars?.message?.body ??
      body?.vars?.message?.text,
  );
}

function extractMessages(data) {
  const candidates = [data?.messages, data?.data?.messages, data?.data, data?.items];
  return candidates.find(Array.isArray) ?? [];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeText(value, 1500);
    if (normalized) return normalized;
  }
  return "";
}

function findNestedMessageText(value, depth = 0) {
  if (value === null || value === undefined || depth > 7) return "";

  if (typeof value === "string") {
    return normalizeText(value, 1500);
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) {
      const found = findNestedMessageText(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value !== "object") return "";

  const priorityKeys = [
    "body",
    "text",
    "content",
    "caption",
    "messageText",
    "transcript",
    "message",
    "payload",
    "data",
  ];

  for (const key of priorityKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const found = findNestedMessageText(value[key], depth + 1);
    if (found) return found;
  }

  return "";
}

function messageText(message) {
  const directText = firstNonEmpty(
    message?.body,
    message?.text,
    message?.content,
    message?.caption,
    message?.message?.body,
    message?.message?.text,
    message?.message?.content,
    message?.payload?.body,
    message?.payload?.text,
    message?.data?.body,
    message?.data?.text,
  );

  return directText || findNestedMessageText(message);
}

function messageIsInbound(message) {
  const direction = String(
    message?.direction ??
      message?.messageDirection ??
      message?.message?.direction ??
      message?.type ??
      "",
  ).toLowerCase();

  if (!direction) return null;
  if (
    direction.includes("inbound") ||
    direction.includes("incoming") ||
    direction === "received"
  ) return true;
  if (
    direction.includes("outbound") ||
    direction.includes("outgoing") ||
    direction === "sent"
  ) return false;
  return null;
}

function collectContactIdentifiers(value, depth = 0, results = []) {
  if (!value || typeof value !== "object" || depth > 6 || results.length >= 30) {
    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      collectContactIdentifiers(item, depth + 1, results);
    }
    return results;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      /^(contactId|contact_id|waId|wa_id|phone|phoneNumber|platformIdentifier|displayIdentifier)$/i.test(key) &&
      (typeof nestedValue === "string" || typeof nestedValue === "number")
    ) {
      const candidate = normalizeText(String(nestedValue), 200);
      if (candidate && !results.includes(candidate)) results.push(candidate);
    }

    if (nestedValue && typeof nestedValue === "object") {
      collectContactIdentifiers(nestedValue, depth + 1, results);
    }

    if (results.length >= 30) break;
  }

  return results;
}

function extractAccounts(data) {
  const candidates = [data?.accounts, data?.data?.accounts, data?.data, data?.items];
  return candidates.find(Array.isArray) ?? [];
}

async function resolveWhatsAppAccountId() {
  const response = await zernioFetch("/accounts?platform=whatsapp");
  if (!response.ok) return null;
  const accounts = extractAccounts(await response.json()).filter(
    (account) => String(account?.platform ?? "").toLowerCase() === "whatsapp",
  );
  const selected =
    accounts.find((account) =>
      ["active", "live", "connected"].includes(
        String(account?.status ?? "").toLowerCase(),
      ),
    ) ?? accounts[0];
  return selected?.accountId ?? selected?.id ?? selected?._id ?? null;
}

function messageToHistoryLine(message) {
  const text = messageText(message);
  if (!text) return null;

  const inbound = messageIsInbound(message);
  const role = inbound === false ? "Assistant" : "Customer";
  return `${role}: ${text}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getConversationContext(conversationId) {
  if (!conversationId) {
    return { history: [], latestCustomerMessage: "", contactIdentifiers: [] };
  }

  const accountId = await resolveWhatsAppAccountId();
  if (!accountId) throw new Error("WhatsApp account could not be resolved");

  const path =
    `/inbox/conversations/${encodeURIComponent(conversationId)}/messages` +
    `?accountId=${encodeURIComponent(accountId)}&sortOrder=desc&limit=${MAX_HISTORY_MESSAGES}`;

  let messages = [];
  let payload = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const messagesResponse = await zernioFetch(path);
    if (!messagesResponse.ok) {
      const upstreamBody = await messagesResponse.text();
      throw new Error(
        `Conversation message lookup failed: ${messagesResponse.status} ${upstreamBody.slice(0, 200)}`,
      );
    }

    payload = await messagesResponse.json();
    messages = extractMessages(payload);
    if (messages.length) break;
    if (attempt < 2) await delay(350 * (attempt + 1));
  }

  if (!messages.length) throw new Error("No conversation messages were returned");

  const newestFirst = messages.slice();
  const latestInbound =
    newestFirst.find((message) => messageIsInbound(message) === true && messageText(message)) ??
    newestFirst.find((message) => messageText(message));

  return {
    history: newestFirst
      .slice()
      .reverse()
      .map(messageToHistoryLine)
      .filter(Boolean),
    latestCustomerMessage: latestInbound ? messageText(latestInbound) : "",
    contactIdentifiers: collectContactIdentifiers({ payload, latestInbound }),
  };
}

async function getContact(contactId) {
  const response = await zernioFetch(`/contacts/${encodeURIComponent(contactId)}`);
  if (!response.ok) throw new Error(`Contact lookup failed: ${response.status}`);
  const data = await response.json();
  return data?.contact ?? data;
}

function getCustomFields(contact) {
  return contact?.customFields ?? contact?.metadata?.customFields ?? {};
}

function normalizePhoneForDisplay(value) {
  const raw = normalizeText(
    value === null || value === undefined ? "" : String(value),
    100,
  )
    .replace(/^(?:whatsapp|wa)\s*:/i, "")
    .trim();
  if (!raw || !/^\+?[\d\s().-]{7,30}$/.test(raw)) return "";

  const digits = normalizePhone(raw);
  if (digits.length < 7 || digits.length > 15) return "";
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return digits;
}

function collectContactPhoneCandidates(value, depth = 0, results = []) {
  if (!value || typeof value !== "object" || depth > 7 || results.length >= 40) {
    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) {
      collectContactPhoneCandidates(item, depth + 1, results);
    }
    return results;
  }

  const typedAsPhone = /\b(whatsapp|phone|telephone|mobile|sms)\b/.test(
    normalizeForIntent(
      value.type ?? value.platform ?? value.channel ?? value.kind ?? "",
    ),
  );

  for (const [key, nestedValue] of Object.entries(value)) {
    const phoneKey = /^(phone|phoneNumber|mobile|mobileNumber|waId|wa_id|platformIdentifier|displayIdentifier)$/i.test(
      key,
    );
    const typedValueKey =
      typedAsPhone && /^(value|identifier|address|username|number|id)$/i.test(key);

    if (
      (phoneKey || typedValueKey) &&
      (typeof nestedValue === "string" || typeof nestedValue === "number")
    ) {
      const candidate = normalizeText(String(nestedValue), 100);
      if (candidate && !results.includes(candidate)) results.push(candidate);
    }

    if (nestedValue && typeof nestedValue === "object") {
      collectContactPhoneCandidates(nestedValue, depth + 1, results);
    }
  }

  return results;
}

function getContactPhone(contact, fallbackIdentifiers = []) {
  const candidates = [
    contact?.phone,
    contact?.phoneNumber,
    contact?.platformIdentifier,
    contact?.displayIdentifier,
    contact?.metadata?.phone,
    ...collectContactPhoneCandidates(contact),
    ...fallbackIdentifiers,
  ];

  for (const candidate of candidates) {
    const normalized = normalizePhoneForDisplay(candidate);
    if (normalized) return normalized;
  }

  return "";
}

async function saveState(contactId, state) {
  const value = JSON.stringify({ ...state, updatedAt: new Date().toISOString() });
  const response = await zernioFetch(
    `/contacts/${encodeURIComponent(contactId)}/fields/${BOOKING_FIELD_NAME}`,
    { method: "PUT", body: JSON.stringify({ value }) },
  );
  if (!response.ok) throw new Error(`Booking state update failed: ${response.status}`);
}

function getBaseUrl(request) {
  const forwardedHost = normalizeText(request.headers["x-forwarded-host"], 300);
  const host = forwardedHost || normalizeText(request.headers.host, 300);
  const forwardedProto = normalizeText(request.headers["x-forwarded-proto"], 20);
  const protocol = forwardedProto || "https";
  if (!host) throw new Error("Application host is missing");
  return `${protocol}://${host}`;
}

async function internalPost(request, path, body) {
  const response = await fetch(`${getBaseUrl(request)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": process.env.INTERNAL_WEBHOOK_SECRET,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function initializeAdditionalRequest({ request, contactId, existingState, analysis, language, currentMessage }) {
  const propertyHistoryResult = await internalPost(request, "/api/calendar-booking", {
    action: "list_properties",
    contactIdentifier: contactId,
  });
  const knownProperties = propertyHistoryResult.ok && Array.isArray(propertyHistoryResult.data?.properties)
    ? propertyHistoryResult.data.properties.slice(0, 3)
    : [];
  const nextState = applyUpdates(
    {
      ...defaultState(),
      active: true,
      stage: "confirming_property_for_new_request",
      language,
      customerName: existingState.customerName,
      companyName: existingState.companyName,
      previousPropertyAddress: existingState.projectAddress,
      previousPropertyType: existingState.propertyType,
      knownProperties,
    },
    analysis,
  );
  nextState.projectAddress = null;
  nextState.propertyType = null;
  if (!projectScopeSupportedByCurrentMessage(nextState.projectScope, currentMessage)) {
    nextState.projectScope = null;
  }
  return nextState;
}

function additionalPropertyQuestion(state, language) {
  const firstName = getFirstName(state);
  const personalizedOpening = firstName
    ? language === "es"
      ? `Hola, ${firstName}. Claro, `
      : `Hello, ${firstName}. Of course, `
    : language === "es"
      ? "Claro, "
      : "Of course, ";
  const propertyLines = state.knownProperties
    .map((property, index) => `${index + 1}. ${property.address}`)
    .join("\n");
  if (state.knownProperties.length > 1) {
    return language === "es"
      ? `${personalizedOpening}¿para cuál propiedad necesitas este nuevo servicio?\n\n${propertyLines}\n${state.knownProperties.length + 1}. Otra propiedad\n\nPuedes responder con el número o escribir la dirección.`
      : `${personalizedOpening}which property needs this new service?\n\n${propertyLines}\n${state.knownProperties.length + 1}. Another property\n\nYou can reply with the number or enter the address.`;
  }
  return language === "es"
    ? `${personalizedOpening}¿este nuevo trabajo es para la propiedad ubicada en ${state.previousPropertyAddress}, o para otra dirección?`
    : `${personalizedOpening}is this new work for the property at ${state.previousPropertyAddress}, or for a different address?`;
}

export function returningCustomerGreeting(state, language, message) {
  const firstName = getFirstName(state);
  const text = normalizeForIntent(message);

  if (language === "es") {
    if (text.includes("buenos dias")) return `Buenos días, ${firstName}. ¿En qué puedo ayudarte hoy?`;
    if (text.includes("buenas tardes")) return `Buenas tardes, ${firstName}. ¿En qué puedo ayudarte hoy?`;
    if (text.includes("buenas noches")) return `Buenas noches, ${firstName}. ¿En qué puedo ayudarte hoy?`;
    return `Hola, ${firstName}. ¿En qué puedo ayudarte hoy?`;
  }

  if (text.includes("good morning")) return `Good morning, ${firstName}. How can I help you today?`;
  if (text.includes("good afternoon")) return `Good afternoon, ${firstName}. How can I help you today?`;
  if (text.includes("good evening")) return `Good evening, ${firstName}. How can I help you today?`;
  return `Hello, ${firstName}. How can I help you today?`;
}

async function analyzeMessage({ currentMessage, history, state }) {
  const systemPrompt = `You extract scheduling information for NEXT SOLUTIONS PARTNERS, a commercial general contractor in Dallas-Fort Worth.
Return one JSON object only. Do not write customer-facing prose.

Determine whether the customer's CURRENT message is related to requesting, selecting, confirming, changing, cancelling, or checking a commercial site-visit appointment.
If booking state is already active, interpret short answers in that scheduling context.
Extract only information actually stated or clearly established in the conversation. Never invent an address, name, date, time, property type, scope, company, or confirmation.
NEXT SOLUTIONS PARTNERS handles commercial construction and building-related work, including new construction, renovations, remodeling, tenant improvements, build-outs, additions, demolition, repairs, and maintenance. Relevant trades and components may include electrical, plumbing, HVAC, framing, drywall, insulation, painting, flooring, ceramic and tile, suspended and acoustic ceilings, concrete, masonry, carpentry, millwork, cabinets, doors, windows, storefronts, roofing, shingles, waterproofing, gutters, siding, stucco, and related interior or exterior commercial work. These examples are not exhaustive. Do not promise that a specific project will be accepted; collect the details and state that the team will review the request.
Commercial hood cleaning, commercial kitchen deep cleaning, kitchen-exhaust cleaning, and closely related commercial-facility maintenance may be submitted as a site-visit request for team review. Treat these as eligible for review, not as a promise that the company has accepted the work.
General janitorial work, routine floor cleaning, housekeeping, maid services, residential cleaning, standalone furniture repair, chair repair, and upholstery are outside the company's scope. Do not treat an appointment request for an out-of-scope service as eligible for scheduling.
When the customer names the property in the same message as the work, extract both facts. For example, "install an outlet in my office" establishes propertyType=office and projectScope=install an electrical outlet. Do not ask for the property type again.
Preserve the customer's actual work description. Do not broaden "inspect the air conditioner" into "HVAC and refrigeration" and do not add refrigeration unless the customer requested it. Normalize minor grammar without changing intent.
Dates must be YYYY-MM-DD. Resolve relative dates using today's Central Time date: ${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())}.
preferredPeriod must be morning, afternoon, or any.
selectedOption must be 1, 2, or 3 only when the customer clearly chooses one of the offered options.
explicitConfirmation is true only when the assistant previously presented a booking summary and the customer clearly approves it.
cancelBooking is true only when the customer clearly cancels or stops the scheduling process.
changeOrCancelExisting is true if the customer wants to change or cancel a request already submitted for team approval.
separateProjectQuestion is true when the CURRENT message asks a company, service, construction, property, or project question that is separate from answering the pending scheduling question. A booking state being active does not by itself make a separate project question booking-related.
newBookingRequest is true only when the customer clearly wants a new or additional visit, service, project, or property request rather than asking about an existing appointment.
newCommercialProject is true when, after an earlier appointment was submitted or confirmed, the CURRENT message starts or continues a different commercial-project conversation. This includes a short answer such as "Sí, en una oficina" or "Yes, at an office" after the assistant asks whether the customer has another construction or remodeling need. It is not a request to change, cancel, or correct the earlier appointment. If the customer has not yet requested another visit, newCommercialProject may be true while bookingRelated remains false.
existingBookingQuestion is true when the customer is asking about the status or details of an appointment already submitted or confirmed.
propertyUse is residential when the customer says the work is for a house, home, residence, or residential property; commercial when clearly stated; otherwise unknown.
customerCorrectingAssistant is true when the customer says the assistant misunderstood, mentions that the prior response was unrelated, or corrects what service/property they meant.

Required JSON keys:
{
  "bookingRelated": boolean,
  "serviceInScope": boolean | null,
  "language": "es" | "en",
  "cancelBooking": boolean,
  "changeOrCancelExisting": boolean,
  "separateProjectQuestion": boolean,
  "newBookingRequest": boolean,
  "newCommercialProject": boolean,
  "existingBookingQuestion": boolean,
  "propertyUse": "residential" | "commercial" | "unknown",
  "customerCorrectingAssistant": boolean,
  "explicitConfirmation": boolean,
  "selectedOption": number | null,
  "customerName": string | null,
  "companyName": string | null,
  "propertyType": string | null,
  "projectAddress": string | null,
  "projectScope": string | null,
  "email": string | null,
  "preferredDate": string | null,
  "preferredPeriod": "morning" | "afternoon" | "any" | null
}`;

  const userPrompt = JSON.stringify({
    currentMessage,
    existingBookingState: state,
    recentConversation: history,
  });

  const response = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`OpenAI booking analysis failed: ${response.status}`);
  const content = data?.choices?.[0]?.message?.content;
  const parsed = safeJsonParse(content, null);
  if (!parsed) throw new Error("OpenAI booking analysis returned invalid JSON");
  return parsed;
}

function applyUpdates(state, analysis) {
  const next = { ...state };
  const fields = [
    "customerName",
    "companyName",
    "propertyType",
    "projectAddress",
    "projectScope",
    "preferredDate",
    "preferredPeriod",
  ];
  for (const field of fields) {
    const value = normalizeText(analysis?.[field], field === "projectScope" ? 2000 : 500);
    if (value) {
      next[field] = field === "customerName"
        ? formatPersonName(value)
        : field === "projectScope"
          ? normalizeProjectScope(value, analysis?.propertyType ?? next.propertyType)
          : value;
    }
  }
  const email = extractEmail(analysis?.email);
  if (email) next.email = email;
  if (["es", "en"].includes(analysis?.language)) next.language = analysis.language;
  return next;
}

function isCompleteProjectAddress(value) {
  const address = normalizeText(value, 500);
  if (address.length < 10) return false;
  if (!/\d/.test(address)) return false;
  if (!/[a-zA-Z]{2,}/.test(address)) return false;
  if (/^p\.?\s*o\.?\s*box\b/i.test(address)) return false;
  return /\b\d{1,8}[a-zA-Z]?\s+\S+/i.test(address);
}

function isSpecificPropertyType(value) {
  const propertyType = normalizeForIntent(value);
  if (!propertyType) return false;
  const genericValues = new Set([
    "comercial",
    "commercial",
    "propiedad comercial",
    "commercial property",
    "espacio comercial",
    "commercial space",
    "negocio",
    "business",
    "local",
  ]);
  return !genericValues.has(propertyType);
}

function missingRequiredFields(state) {
  const missing = [];
  if (!normalizeText(state.customerName)) missing.push("customerName");
  if (!isSpecificPropertyType(state.propertyType)) missing.push("propertyType");
  if (!isCompleteProjectAddress(state.projectAddress)) missing.push("projectAddress");
  if (!normalizeText(state.projectScope)) missing.push("projectScope");
  return missing;
}

function applyExpectedFieldAnswer(state, analysis, currentMessage) {
  const nextAnalysis = { ...analysis };
  const answer = normalizeText(currentMessage, 500);
  const expectedField = missingRequiredFields(state)[0] ?? null;

  if (!answer || !expectedField) return nextAnalysis;

  // When the assistant has just asked for a specific missing field, capture the
  // customer's direct answer deterministically instead of relying only on the
  // AI extractor. This prevents short valid replies such as "Restaurante" from
  // being ignored and causing the same question to repeat.
  if (
    expectedField === "propertyType" &&
    !normalizeText(nextAnalysis.propertyType) &&
    answer.length <= 120 &&
    isPlausiblePropertyTypeAnswer(answer)
  ) {
    nextAnalysis.propertyType = answer;
  }

  if (
    expectedField === "projectAddress" &&
    !normalizeText(nextAnalysis.projectAddress) &&
    isCompleteProjectAddress(answer)
  ) {
    nextAnalysis.projectAddress = answer;
  }

  // Preserve useful partial location data. If the customer first gives a city
  // and state and then supplies only the street number/name, combine both
  // replies before validating the address.
  if (
    expectedField === "projectAddress" &&
    !normalizeText(nextAnalysis.projectAddress)
  ) {
    const previousAddress = normalizeText(state.projectAddress, 500);
    const combinedAddress = previousAddress
      ? `${answer}, ${previousAddress}`
      : answer;

    if (isCompleteProjectAddress(combinedAddress)) {
      nextAnalysis.projectAddress = combinedAddress;
    }
  }

  return nextAnalysis;
}

function askForField(field, language, state = {}) {
  const firstName = getFirstName(state);
  const namePrefix = firstName ? `${firstName}, ` : "";
  const hasPartialAddress =
    field === "projectAddress" &&
    normalizeText(state.projectAddress, 500) &&
    !isCompleteProjectAddress(state.projectAddress);

  const es = {
    customerName: "Para preparar la solicitud, ¿me indicas tu nombre?",
    propertyType: `${namePrefix}¿qué tipo de propiedad o negocio comercial es? Por ejemplo, restaurante, oficina o tienda.`,
    projectAddress: hasPartialAddress
      ? `Gracias${firstName ? `, ${firstName}` : ""}. Ya tengo ${normalizeText(state.projectAddress, 500)} como ubicación general. Para completar la dirección, ¿cuál es el número y el nombre de la calle? Si tienes el código postal, inclúyelo también.`
      : `${namePrefix}¿cuál es la dirección física completa de la propiedad comercial? Incluye número, calle, ciudad, estado y código postal si lo tienes. Necesitamos la ubicación exacta para poder solicitar la visita.`,
    projectScope: `${namePrefix}¿qué trabajo necesitas que revisemos durante la visita?`,
  };
  const en = {
    customerName: "To prepare the request, may I have your name?",
    propertyType: `${namePrefix}what type of commercial property or business is it, such as a restaurant, office, or retail store?`,
    projectAddress: hasPartialAddress
      ? `Thank you${firstName ? `, ${firstName}` : ""}. I have ${normalizeText(state.projectAddress, 500)} as the general location. To complete the address, what are the street number and street name? Please include the ZIP code if available.`
      : `${namePrefix}what is the complete physical address of the commercial property? Please include the street number, street name, city, state, and ZIP code if available. We need the exact location to request the visit.`,
    projectScope: `${namePrefix}what work would you like us to review during the visit?`,
  };
  return (language === "es" ? es : en)[field];
}

function resumeBookingReply(state, language) {
  const missing = missingRequiredFields(state);
  if (missing.length) return askForField(missing[0], language, state);

  if (state.stage === "collecting_email") {
    return language === "es"
      ? "¿A qué correo electrónico te gustaría recibir la confirmación de la visita? Si prefieres continuar únicamente por WhatsApp, también está bien."
      : "What email address would you like us to use for the visit confirmation? If you prefer to continue through WhatsApp only, that is also fine.";
  }

  if (state.stage === "awaiting_confirmation") {
    return confirmationReply(state, language);
  }

  if (state.stage === "awaiting_slot_selection" && state.offeredSlots.length) {
    return availabilityReply(state.offeredSlots, language);
  }

  return language === "es"
    ? "Claro, continuemos. ¿Qué fecha prefieres para la visita comercial?"
    : "Of course, let's continue. What date would you prefer for the commercial site visit?";
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizeText(value, 20));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return { year, month, day, date };
}

function centralDateParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function dateSerial(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000;
}

function hasConflictingExplicitDate(message, preferredDate) {
  const parsed = parseIsoDate(preferredDate);
  if (!parsed) return true;

  const normalized = normalizeForIntent(message);
  const weekdays = [
    [0, /\b(domingo|sunday)\b/],
    [1, /\b(lunes|monday)\b/],
    [2, /\b(martes|tuesday)\b/],
    [3, /\b(miercoles|wednesday)\b/],
    [4, /\b(jueves|thursday)\b/],
    [5, /\b(viernes|friday)\b/],
    [6, /\b(sabado|saturday)\b/],
  ];
  const statedWeekday = weekdays.find(([, pattern]) => pattern.test(normalized));
  if (statedWeekday && parsed.date.getUTCDay() !== statedWeekday[0]) return true;

  const months = [
    [1, /\b(enero|january)\b/], [2, /\b(febrero|february)\b/],
    [3, /\b(marzo|march)\b/], [4, /\b(abril|april)\b/],
    [5, /\b(mayo|may)\b/], [6, /\b(junio|june)\b/],
    [7, /\b(julio|july)\b/], [8, /\b(agosto|august)\b/],
    [9, /\b(septiembre|setiembre|september)\b/], [10, /\b(octubre|october)\b/],
    [11, /\b(noviembre|november)\b/], [12, /\b(diciembre|december)\b/],
  ];
  const statedMonth = months.find(([, pattern]) => pattern.test(normalized));
  return Boolean(statedMonth && parsed.month !== statedMonth[0]);
}

function isPastPreferredDate(preferredDate) {
  const parsed = parseIsoDate(preferredDate);
  if (!parsed) return true;
  return dateSerial(parsed) < dateSerial(centralDateParts());
}

function keepSlotsOnOrAfterPreferredDate(options, preferredDate) {
  const requested = parseIsoDate(preferredDate);
  if (!requested) return [];

  return options
    .map((option) => {
      const start = new Date(option?.start);
      if (Number.isNaN(start.getTime())) return null;
      const distance = dateSerial(centralDateParts(start)) - dateSerial(requested);
      return { option, distance, startTime: start.getTime() };
    })
    .filter((entry) => entry && entry.distance >= 0)
    .sort((a, b) => a.startTime - b.startTime)
    .map((entry) => entry.option)
    .slice(0, 3);
}

function availabilityReply(options, language) {
  const lines = options.map((option, index) => `${index + 1}. ${option.display}`);
  return language === "es"
    ? `Estos son los horarios disponibles más cercanos:\n\n${lines.join("\n")}\n\n¿Cuál prefieres: 1, 2 o 3?`
    : `These are the closest available times:\n\n${lines.join("\n")}\n\nWhich do you prefer: 1, 2, or 3?`;
}

function formatSlotDisplay(startValue, language) {
  const start = new Date(startValue);

  if (Number.isNaN(start.getTime())) {
    return normalizeText(startValue, 200);
  }

  const locale = language === "es" ? "es-US" : "en-US";

  const dateLabel = new Intl.DateTimeFormat(locale, {
    timeZone: "America/Chicago",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(start);

  const timeLabel = new Intl.DateTimeFormat(locale, {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(start);

  return language === "es"
    ? `${dateLabel} a las ${timeLabel}, hora central`
    : `${dateLabel} at ${timeLabel} Central Time`;
}

function confirmationReply(state, language) {
  const selectedDisplay = state.selectedStart
    ? formatSlotDisplay(state.selectedStart, language)
    : state.selectedDisplay;
  if (language === "es") {
    return `Antes de enviar la solicitud, confirma por favor estos datos:\n\nNombre: ${formatPersonName(state.customerName)}\nPropiedad: ${state.propertyType}\nDirección: ${state.projectAddress}\nTrabajo: ${state.projectScope}\nCorreo: ${state.email || "No proporcionado"}\nHorario solicitado: ${selectedDisplay}\n\nEste horario quedará pendiente de aprobación del equipo. ¿Confirmas que deseas enviar la solicitud?`;
  }
  return `Before I submit the request, please confirm these details:\n\nName: ${formatPersonName(state.customerName)}\nProperty: ${state.propertyType}\nAddress: ${state.projectAddress}\nWork requested: ${state.projectScope}\nEmail: ${state.email || "Not provided"}\nRequested time: ${selectedDisplay}\n\nThis time will remain pending team approval. Would you like me to submit the request?`;
}

function pendingReply(state, language) {
  const selectedDisplay = state.selectedStart
    ? formatSlotDisplay(state.selectedStart, language)
    : state.selectedDisplay;
  return language === "es"
    ? `Tu solicitud para ${selectedDisplay} fue registrada y quedó pendiente de aprobación. El equipo de NEXT SOLUTIONS PARTNERS revisará los detalles antes de confirmar la visita.`
    : `Your request for ${selectedDisplay} has been submitted and is pending approval. The NEXT SOLUTIONS PARTNERS team will review the details before confirming the visit.`;
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const receivedSecret =
    request.headers["x-webhook-secret"] ??
    request.body?.webhookSecret ??
    request.query?.secret;

  if (!secretsMatch(receivedSecret, process.env.INTERNAL_WEBHOOK_SECRET)) {
    return response.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (!process.env.ZERNIO_API_KEY || !process.env.OPENAI_API_KEY) {
    return response.status(500).json({ ok: false, error: "Server configuration error" });
  }

  const suppliedContactIdentifier = extractContactIdentifier(request.body);
  const conversationId = extractConversationId(request.body);
  const suppliedCurrentMessage = extractCurrentMessage(request.body);

  if (!suppliedCurrentMessage && !conversationId) {
    return response.status(400).json({
      ok: false,
      error: "A valid conversation or current message is required",
    });
  }

  try {
    const conversationContext = conversationId
      ? await getConversationContext(conversationId)
      : { history: [], latestCustomerMessage: "", contactIdentifiers: [] };

    const currentMessage =
      suppliedCurrentMessage || conversationContext.latestCustomerMessage;

    let contactId = null;
    const contactCandidates = [
      suppliedContactIdentifier,
      ...conversationContext.contactIdentifiers,
    ].filter(Boolean);

    for (const candidate of contactCandidates) {
      contactId = await resolveContactId(candidate);
      if (contactId) break;
    }

    if (!contactId) {
      return response.status(422).json({
        ok: false,
        error: "The contact could not be resolved from the conversation",
      });
    }

    const contact = await getContact(contactId);
    const history = conversationContext.history;
    const effectiveCurrentMessage = currentMessage;

    if (!effectiveCurrentMessage) {
      return response.status(422).json({
        ok: false,
        error: "The current message could not be retrieved",
      });
    }

    if (isEmojiOnlyMessage(effectiveCurrentMessage)) {
      return response.status(200).json({
        ok: true,
        handled: true,
        suppressReply: true,
        reply: null,
        stage: "silent_emoji",
      });
    }

    const customFields = getCustomFields(contact);
    let state = normalizeState(customFields?.[BOOKING_FIELD_NAME]);
    let analysis = await analyzeMessage({
      currentMessage: effectiveCurrentMessage,
      history,
      state,
    });

    const currentServiceAreaSignal = serviceAreaSignal(effectiveCurrentMessage);
    if (currentServiceAreaSignal === "outside_dfw") {
      const serviceAreaLanguage =
        analysis.language === "es" ? "es" : state.language === "es" ? "es" : "en";
      const serviceAreaName = getFirstName(state);
      return response.status(200).json({
        ok: true,
        handled: true,
        outsideServiceArea: true,
        bookingDraftPreserved: state.active || state.stage !== "idle",
        language: serviceAreaLanguage,
        reply:
          serviceAreaLanguage === "es"
            ? `Entiendo${serviceAreaName ? `, ${serviceAreaName}` : ""}. NEXT SOLUTIONS PARTNERS atiende el área de Dallas–Fort Worth y el DFW Metroplex, por lo que no puedo programar una visita para esa ubicación. Si tienes otra propiedad comercial dentro del Metroplex, puedo ayudarte con esa solicitud.`
            : `I understand${serviceAreaName ? `, ${serviceAreaName}` : ""}. NEXT SOLUTIONS PARTNERS serves Dallas–Fort Worth and the DFW Metroplex, so I cannot schedule a visit for that location. If you have another commercial property within the Metroplex, I can help with that request.`,
        stage: state.stage,
      });
    }

    if (
      normalizeText(analysis.propertyType) &&
      !isPlausiblePropertyTypeAnswer(analysis.propertyType)
    ) {
      analysis.propertyType = null;
    }

    const inferredPropertyType = inferPropertyTypeFromMessage(
      effectiveCurrentMessage,
      analysis.language,
    );
    if (!isSpecificPropertyType(analysis.propertyType) && inferredPropertyType) {
      analysis.propertyType = inferredPropertyType;
    }
    const continuesWebsiteProjectRedirect =
      Boolean(inferredPropertyType) &&
      /^(si|sí|yes)\b/i.test(normalizeText(effectiveCurrentMessage, 500)) &&
      (hasActiveWebsiteProjectFollowUp(state) ||
        recentHistoryHasWebsiteProjectRedirect(history));
    if (continuesWebsiteProjectRedirect) {
      analysis.newCommercialProject = true;
    }
    if (
      state.stage === "confirmed" &&
      !analysis.changeOrCancelExisting &&
      !analysis.existingBookingQuestion &&
      ((inferredPropertyType && /^(si|sí|yes)\b/i.test(normalizeText(effectiveCurrentMessage, 500))) ||
        /\b(otro proyecto|nuevo proyecto|otro trabajo|nuevo trabajo|another project|new project|another job|new job)\b/.test(
          normalizeForIntent(effectiveCurrentMessage),
        ))
    ) {
      analysis.newCommercialProject = true;
    }
    if (normalizeText(analysis.projectScope)) {
      analysis.projectScope = normalizeProjectScope(
        analysis.projectScope,
        analysis.propertyType ?? state.propertyType,
      );
    }

    analysis = applyExpectedFieldAnswer(
      state,
      analysis,
      effectiveCurrentMessage,
    );

    const explicitOnlyService = extractExplicitOnlyService(effectiveCurrentMessage);
    const explicitIncludedService = extractExplicitIncludedService(
      effectiveCurrentMessage,
      analysis.language,
    );
    if (explicitOnlyService) {
      analysis.projectScope = explicitOnlyService;
    } else if (explicitIncludedService) {
      analysis.projectScope = mergeProjectScopes(
        state.projectScope,
        explicitIncludedService,
        analysis.language,
      );
    }

    const bookingContextActive = state.active || state.stage !== "idle";
    const reviewableCommercialSupportService =
      isReviewableCommercialSupportService(effectiveCurrentMessage) ||
      isReviewableCommercialSupportService(analysis.projectScope);
    const explicitlyOutOfScopeService =
      isClearlyOutOfScopeService(effectiveCurrentMessage) ||
      isClearlyOutOfScopeService(analysis.projectScope);

    const detectedLanguage = analysis.language === "es" ? "es" : "en";
    const residentialRequest =
      analysis.propertyUse === "residential" ||
      isResidentialPropertyMessage(effectiveCurrentMessage) ||
      (analysis.customerCorrectingAssistant === true &&
        isResidentialPropertyMessage(JSON.stringify(history.slice(-6))));

    const siteAccessQuestion =
      isSiteAccessQuestion(effectiveCurrentMessage) ||
      (isSiteVisitEvaluationClarification(effectiveCurrentMessage) &&
        recentHistoryHasSiteAccessContext(history));

    if (siteAccessQuestion && !residentialRequest) {
      return response.status(200).json({
        ok: true,
        handled: true,
        bookingDraftPreserved: bookingContextActive,
        language: detectedLanguage,
        reply: siteAccessReply(detectedLanguage),
        stage: state.stage,
      });
    }

    if (residentialRequest) {
      const correctionPrefix = analysis.customerCorrectingAssistant
        ? detectedLanguage === "es"
          ? "Tienes razón; entendí incorrectamente tu solicitud. Disculpa la confusión. "
          : "You're right; I misunderstood your request. I apologize for the confusion. "
        : "";
      const draftContinuation = bookingContextActive
        ? detectedLanguage === "es"
          ? " Tu solicitud comercial anterior sigue guardada. Cuando quieras, continuamos desde donde quedamos."
          : " Your previous commercial request is still saved. Whenever you're ready, we can continue where we left off."
        : "";
      return response.status(200).json({
        ok: true,
        handled: true,
        outOfScope: true,
        outOfScopeReason: "residential",
        bookingDraftPreserved: bookingContextActive,
        language: detectedLanguage,
        reply:
          detectedLanguage === "es"
            ? `${correctionPrefix}Actualmente NEXT SOLUTIONS PARTNERS atiende proyectos y servicios de HVAC en propiedades comerciales, por lo que no podemos programar este servicio residencial.${draftContinuation}`
            : `${correctionPrefix}NEXT SOLUTIONS PARTNERS currently provides projects and HVAC services for commercial properties, so we cannot schedule this residential service.${draftContinuation}`,
        stage: state.stage,
      });
    }

    if (isWebsiteReferralMessage(effectiveCurrentMessage)) {
      return response.status(200).json({
        ok: true,
        handled: true,
        bookingDraftPreserved: bookingContextActive,
        language: detectedLanguage,
        reply: getWebsiteReferralReply(detectedLanguage, getFirstName(state)),
        stage: state.stage,
      });
    }

    if (isWebsiteDevelopmentRequest(effectiveCurrentMessage)) {
      state.awaitingWebsiteProjectFollowUp = true;
      state.websiteProjectFollowUpAt = new Date().toISOString();
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        outOfScope: true,
        outOfScopeReason: "website_development",
        bookingDraftPreserved: bookingContextActive,
        language: detectedLanguage,
        reply:
          detectedLanguage === "es"
            ? `${getWebsiteDevelopmentReply(detectedLanguage)} ¿Hay algún trabajo comercial de construcción o remodelación en el que podamos ayudarte?`
            : `${getWebsiteDevelopmentReply(detectedLanguage)} Is there a commercial construction or remodeling project we can help you with?`,
        stage: state.stage,
      });
    }

    if (
      continuesWebsiteProjectRedirect &&
      analysis.newCommercialProject === true &&
      !analysis.changeOrCancelExisting
    ) {
      const nextState = applyUpdates(
        {
          ...defaultState(),
          active: true,
          stage: "collecting_details",
          language: detectedLanguage,
          customerName: state.customerName,
          companyName: state.companyName,
        },
        analysis,
      );
      await saveState(contactId, nextState);
      const firstName = getFirstName(nextState);
      const propertyType = normalizeText(nextState.propertyType, 120);
      return response.status(200).json({
        ok: true,
        handled: true,
        language: detectedLanguage,
        reply:
          detectedLanguage === "es"
            ? `Perfecto${firstName ? `, ${firstName}` : ""}. ¿Qué trabajo necesitas realizar${propertyType.toLowerCase() === "oficina" ? " en la oficina" : ` en la propiedad (${propertyType})`}?`
            : `Perfect${firstName ? `, ${firstName}` : ""}. What work do you need at the ${propertyType}?`,
        stage: nextState.stage,
      });
    }

    if (
      state.stage === "idle" &&
      (explicitlyOutOfScopeService ||
        (analysis.serviceInScope === false &&
          !reviewableCommercialSupportService))
    ) {
      return response.status(200).json({
        ok: true,
        handled: true,
        outOfScope: true,
        language: analysis.language === "es" ? "es" : "en",
        reply: getOutOfScopeReply(analysis.language),
        stage: "idle",
      });
    }

    if (
      bookingContextActive &&
      state.stage !== "pending_approval" &&
      state.stage !== "confirmed" &&
      isAddressCorrectionIntent(effectiveCurrentMessage)
    ) {
      state.customerName = formatPersonName(state.customerName);
      state.projectAddress = null;
      state.stage = "collecting_details";
      state.active = true;
      await saveState(contactId, state);
      const correctionLanguage =
        analysis.language === "es" ? "es" : state.language === "es" ? "es" : "en";
      const correctionName = getFirstName(state);
      return response.status(200).json({
        ok: true,
        handled: true,
        bookingDraftPreserved: true,
        addressCorrectionRequested: true,
        language: correctionLanguage,
        reply:
          correctionLanguage === "es"
            ? `Entendido${correctionName ? `, ${correctionName}` : ""}. No enviaré la solicitud todavía. Para actualizar la ubicación sin asumir ningún dato, escribe por favor la dirección física completa corregida, incluyendo número, calle, ciudad, estado y código postal si lo tienes.`
            : `Understood${correctionName ? `, ${correctionName}` : ""}. I will not submit the request yet. To update the location without assuming any details, please enter the complete corrected physical address, including the street number, street name, city, state, and ZIP code if available.`,
        stage: state.stage,
      });
    }

    const confirmedService = detectConfirmedCommercialService(
      effectiveCurrentMessage,
    );

    if (
      bookingContextActive &&
      confirmedService &&
      isServiceCapabilityQuestion(effectiveCurrentMessage) &&
      !isServiceExplanationQuestion(effectiveCurrentMessage) &&
      !explicitOnlyService &&
      !explicitIncludedService
    ) {
      return response.status(200).json({
        ok: true,
        handled: true,
        bookingDraftPreserved: true,
        language: detectedLanguage,
        reply: confirmedServiceReply(confirmedService, detectedLanguage),
        stage: state.stage,
      });
    }

    if (
      bookingContextActive &&
      !explicitOnlyService &&
      !explicitIncludedService &&
      (analysis.separateProjectQuestion === true ||
        isServiceCapabilityQuestion(effectiveCurrentMessage) ||
        isServiceExplanationQuestion(effectiveCurrentMessage)) &&
      analysis.newCommercialProject !== true
    ) {
      return response.status(200).json({
        ok: true,
        handled: false,
        bookingDraftPreserved: true,
        stage: state.stage,
      });
    }

    if (bookingContextActive && isResumeBookingIntent(effectiveCurrentMessage)) {
      const resumeLanguage =
        analysis.language === "es" ? "es" : state.language === "es" ? "es" : "en";
      return response.status(200).json({
        ok: true,
        handled: true,
        bookingDraftPreserved: true,
        language: resumeLanguage,
        reply: resumeBookingReply(state, resumeLanguage),
        stage: state.stage,
      });
    }

    if (
      isGreetingOnlyMessage(effectiveCurrentMessage) &&
      getFirstName(state)
    ) {
      const greetingLanguage =
        analysis.language === "es" ? "es" : state.language === "es" ? "es" : "en";
      return response.status(200).json({
        ok: true,
        handled: true,
        language: greetingLanguage,
        reply: returningCustomerGreeting(
          state,
          greetingLanguage,
          effectiveCurrentMessage,
        ),
        stage: state.stage,
      });
    }

    if (!analysis.bookingRelated && !bookingContextActive) {
      return response.status(200).json({ ok: true, handled: false, stage: "idle" });
    }

    if (state.stage === "confirmed") {
      const confirmedLanguage =
        analysis.language === "es" ? "es" : state.language === "es" ? "es" : "en";

      if (isCourtesyOnlyMessage(effectiveCurrentMessage)) {
        return response.status(200).json({
          ok: true,
          handled: true,
          language: confirmedLanguage,
          reply: confirmedLanguage === "es" ? "Con gusto." : "You're welcome.",
          stage: state.stage,
        });
      }

      if (
        analysis.newCommercialProject === true &&
        analysis.newBookingRequest !== true &&
        !analysis.changeOrCancelExisting
      ) {
        const nextState = applyUpdates(
          {
            ...defaultState(),
            active: true,
            stage: "collecting_details",
            language: confirmedLanguage,
            customerName: state.customerName,
            companyName: state.companyName,
          },
          analysis,
        );
        nextState.projectAddress = null;
        nextState.preferredDate = null;
        nextState.preferredPeriod = null;
        nextState.selectedStart = null;
        nextState.selectedEnd = null;
        nextState.selectedDisplay = null;
        await saveState(contactId, nextState);

        const firstName = getFirstName(nextState);
        const propertyType = normalizeText(nextState.propertyType, 120);
        return response.status(200).json({
          ok: true,
          handled: true,
          language: confirmedLanguage,
          reply:
            confirmedLanguage === "es"
              ? `Perfecto${firstName ? `, ${firstName}` : ""}. ¿Qué trabajo necesitas realizar${propertyType ? ` en ${propertyType.toLowerCase() === "oficina" ? "la oficina" : `la propiedad (${propertyType})`}` : " en esta propiedad comercial"}?`
              : `Perfect${firstName ? `, ${firstName}` : ""}. What work do you need${propertyType ? ` at the ${propertyType}` : " at this commercial property"}?`,
          stage: nextState.stage,
        });
      }

      if (!analysis.bookingRelated && !analysis.changeOrCancelExisting) {
        return response.status(200).json({
          ok: true,
          handled: false,
          stage: state.stage,
        });
      }

      if (analysis.newBookingRequest === true && !analysis.changeOrCancelExisting) {
        const nextState = await initializeAdditionalRequest({
          request,
          contactId,
          existingState: state,
          analysis,
          language: confirmedLanguage,
          currentMessage: effectiveCurrentMessage,
        });
        await saveState(contactId, nextState);
        return response.status(200).json({
          ok: true,
          handled: true,
          language: confirmedLanguage,
          reply: additionalPropertyQuestion(nextState, confirmedLanguage),
          stage: nextState.stage,
        });
      }

      const confirmedFirstName = getFirstName(state);

      return response.status(200).json({
        ok: true,
        handled: true,
        handoffRequired: true,
        language: confirmedLanguage,
        reply:
          confirmedLanguage === "es"
            ? `Entiendo${confirmedFirstName ? `, ${confirmedFirstName}` : ""}. Tu visita ya está confirmada. Un miembro del equipo te ayudará personalmente a corregirla, cambiarla o cancelarla.`
            : `I understand${confirmedFirstName ? `, ${confirmedFirstName}` : ""}. Your site visit is already confirmed. A team member will personally help you correct, change, or cancel it.`,
        stage: state.stage,
      });
    }

    if (
      state.stage === "pending_approval" &&
      analysis.newBookingRequest === true &&
      !analysis.changeOrCancelExisting
    ) {
      const pendingLanguage =
        analysis.language === "es" ? "es" : state.language === "es" ? "es" : "en";
      const nextState = await initializeAdditionalRequest({
        request,
        contactId,
        existingState: state,
        analysis,
        language: pendingLanguage,
        currentMessage: effectiveCurrentMessage,
      });
      await saveState(contactId, nextState);
      return response.status(200).json({
        ok: true,
        handled: true,
        language: pendingLanguage,
        reply: additionalPropertyQuestion(nextState, pendingLanguage),
        stage: nextState.stage,
      });
    }

    if (!analysis.bookingRelated && state.stage === "pending_approval") {
      return response.status(200).json({ ok: true, handled: false, stage: state.stage });
    }

    const language = analysis.language === "es" ? "es" : state.language === "es" ? "es" : "en";

    if (state.stage === "confirming_property_for_new_request") {
      const knownPropertyIndex = selectedKnownPropertyIndex(
        effectiveCurrentMessage,
        state.knownProperties.length,
      );
      const selectedAnotherOption =
        normalizeForIntent(effectiveCurrentMessage) ===
        String(state.knownProperties.length + 1);
      if (knownPropertyIndex !== null) {
        const selectedProperty = state.knownProperties[knownPropertyIndex];
        state.projectAddress = selectedProperty.address;
        state.propertyType = selectedProperty.propertyType || null;
        state.stage = "collecting_details";
      } else if (isCompleteProjectAddress(effectiveCurrentMessage)) {
        state.projectAddress = normalizeText(effectiveCurrentMessage, 500);
        state.propertyType = null;
        state.stage = "collecting_details";
      } else if (selectsPreviousProperty(effectiveCurrentMessage)) {
        state.projectAddress = state.previousPropertyAddress;
        state.propertyType = state.previousPropertyType;
        state.stage = "collecting_details";
      } else if (selectedAnotherOption || selectsAnotherProperty(effectiveCurrentMessage)) {
        state.projectAddress = null;
        state.propertyType = null;
        state.stage = "collecting_details";
      } else {
        await saveState(contactId, state);
        return response.status(200).json({
          ok: true,
          handled: true,
          language,
          reply:
            language === "es"
              ? `Para asegurarme de usar la ubicación correcta, ¿es para ${state.previousPropertyAddress} o para otra dirección?`
              : `To make sure I use the correct location, is it for ${state.previousPropertyAddress} or for a different address?`,
          stage: state.stage,
        });
      }
    }

    if (state.stage === "collecting_email") {
      const suppliedEmail = extractEmail(effectiveCurrentMessage);
      if (suppliedEmail) {
        state.email = suppliedEmail;
        state.emailAsked = true;
      } else if (declinesEmail(effectiveCurrentMessage)) {
        state.email = null;
        state.emailAsked = true;
      } else {
        await saveState(contactId, state);
        return response.status(200).json({
          ok: true,
          handled: true,
          language,
          reply:
            language === "es"
              ? "No pude identificar un correo válido. Puedes escribirlo nuevamente o decirme que prefieres continuar solo por WhatsApp."
              : "I could not identify a valid email address. You can enter it again or tell me you prefer to continue through WhatsApp only.",
          stage: state.stage,
        });
      }
    }

    if (
      state.stage === "awaiting_confirmation" &&
      !explicitOnlyService &&
      !explicitIncludedService &&
      (analysis.separateProjectQuestion === true ||
        asksToAddressAnotherQuestion(effectiveCurrentMessage))
    ) {
      const shouldCancelDraft =
        analysis.cancelBooking === true ||
        isExplicitBookingCancellation(effectiveCurrentMessage);

      if (shouldCancelDraft) {
        state = defaultState();
        await saveState(contactId, state);
      }

      return response.status(200).json({
        ok: true,
        handled: false,
        bookingDraftPreserved: !shouldCancelDraft,
        stage: shouldCancelDraft ? "idle" : "awaiting_confirmation",
      });
    }

    if (state.stage === "pending_approval" && isCourtesyOnlyMessage(effectiveCurrentMessage)) {
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply: language === "es" ? "Con gusto." : "You're welcome.",
        stage: state.stage,
      });
    }

    if (analysis.changeOrCancelExisting && state.stage === "pending_approval") {
      return response.status(200).json({
        ok: true,
        handled: true,
        handoffRequired: true,
        language,
        reply:
          language === "es"
            ? "Para cambiar o cancelar una solicitud existente, un miembro del equipo debe ayudarte personalmente."
            : "A team member must assist you personally to change or cancel an existing request.",
        stage: state.stage,
      });
    }

    if (analysis.bookingRelated && state.stage === "pending_approval") {
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply:
          language === "es"
            ? `Tu solicitud para ${state.selectedDisplay} continúa pendiente de aprobación. Te avisaremos cuando el equipo la revise.`
            : `Your request for ${state.selectedDisplay} is still pending approval. We will notify you after the team reviews it.`,
        stage: state.stage,
      });
    }

    if (analysis.cancelBooking) {
      state = defaultState();
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply:
          language === "es"
            ? "De acuerdo, cancelé el proceso de solicitud de visita. ¿Hay algo más sobre tu proyecto comercial en lo que pueda ayudarte?"
            : "Okay, I stopped the site-visit request process. Is there anything else about your commercial project I can help with?",
        stage: "idle",
      });
    }

    const previousPreferredDate = state.preferredDate;
    const previousPreferredPeriod = state.preferredPeriod;
    state = applyUpdates({ ...state, active: true, language }, analysis);
    const scopeAcknowledgement = scopeChangeAcknowledgement({
      onlyService: explicitOnlyService,
      includedService: explicitIncludedService,
      state,
      language,
    });

    if (
      state.stage === "awaiting_confirmation" &&
      isDirectRejection(effectiveCurrentMessage) &&
      !explicitOnlyService
    ) {
      state.preferredDate = null;
      state.preferredPeriod = null;
      state.offeredSlots = [];
      state.selectedStart = null;
      state.selectedDisplay = null;
      state.stage = "collecting_preference";
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply:
          language === "es"
            ? "De acuerdo, no enviaré esa solicitud. ¿Qué nueva fecha prefieres para la visita?"
            : "Okay, I will not submit that request. What new date would you prefer for the visit?",
        stage: state.stage,
      });
    }

    const changedConfirmationPreference =
      state.stage === "awaiting_confirmation" &&
      ((analysis.preferredDate && state.preferredDate !== previousPreferredDate) ||
        (analysis.preferredPeriod && state.preferredPeriod !== previousPreferredPeriod));

    if (changedConfirmationPreference) {
      state.offeredSlots = [];
      state.selectedStart = null;
      state.selectedDisplay = null;
      state.stage = "collecting_preference";
    }

    if (
      state.stage === "awaiting_slot_selection" &&
      analysis.selectedOption &&
      state.offeredSlots.length
    ) {
      const selected = state.offeredSlots[analysis.selectedOption - 1];
      if (selected) {
        state.selectedStart = selected.start;
        state.selectedDisplay = selected.display;
        state.stage = "collecting_details";
      }
    }

    const confirmationReceived =
      analysis.explicitConfirmation === true ||
      isDirectConfirmation(effectiveCurrentMessage);

    if (state.stage === "awaiting_confirmation" && confirmationReceived) {
      const bookingResult = await internalPost(request, "/api/calendar-booking", {
        customerName: state.customerName,
        companyName: state.companyName,
        propertyType: state.propertyType,
        projectAddress: state.projectAddress,
        projectScope: state.projectScope,
        selectedStart: state.selectedStart,
        contactIdentifier: contactId,
        conversationId,
        whatsappNumber: getContactPhone(contact, contactCandidates),
        email: state.email,
        language,
      });

      if (bookingResult.ok) {
        state.stage = "pending_approval";
        state.active = false;
        state.eventId = bookingResult.data?.eventId ?? null;
        await saveState(contactId, state);
        return response.status(200).json({
          ok: true,
          handled: true,
          bookingCreated: true,
          language,
          reply: pendingReply(state, language),
          stage: state.stage,
          eventId: state.eventId,
        });
      }

      if (bookingResult.status === 409) {
        state.selectedStart = null;
        state.selectedDisplay = null;
        state.offeredSlots = [];
        state.stage = "collecting_preference";
        await saveState(contactId, state);
        return response.status(200).json({
          ok: true,
          handled: true,
          language,
          reply:
            language === "es"
              ? "Ese horario acaba de dejar de estar disponible. ¿Qué otra fecha prefieres para que revise nuevas opciones?"
              : "That time is no longer available. What other date would you prefer so I can check new options?",
          stage: state.stage,
        });
      }

      throw new Error(`Booking creation failed: ${bookingResult.status}`);
    }

    if (state.selectedStart) {
      const missing = missingRequiredFields(state);
      if (missing.length) {
        state.stage = "collecting_details";
        await saveState(contactId, state);
        return response.status(200).json({
          ok: true,
          handled: true,
          language,
          reply: prependAcknowledgement(
            scopeAcknowledgement,
            askForField(missing[0], language, state),
          ),
          stage: state.stage,
          missingFields: missing,
        });
      }

      if (!state.emailAsked) {
        state.stage = "collecting_email";
        await saveState(contactId, state);
        return response.status(200).json({
          ok: true,
          handled: true,
          language,
          reply: prependAcknowledgement(
            scopeAcknowledgement,
            language === "es"
              ? "¿A qué correo electrónico te gustaría recibir la confirmación de la visita? Si prefieres continuar únicamente por WhatsApp, también está bien."
              : "What email address would you like us to use for the visit confirmation? If you prefer to continue through WhatsApp only, that is also fine.",
          ),
          stage: state.stage,
        });
      }

      state.stage = "awaiting_confirmation";
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply: prependAcknowledgement(
          scopeAcknowledgement,
          confirmationReply(state, language),
        ),
        stage: state.stage,
      });
    }

    const missingDetails = missingRequiredFields(state);
    if (missingDetails.length) {
      state.stage = "collecting_details";
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply: prependAcknowledgement(
          scopeAcknowledgement,
          askForField(missingDetails[0], language, state),
        ),
        stage: state.stage,
        missingFields: missingDetails,
      });
    }

    if (!state.preferredDate) {
      state.stage = "collecting_preference";
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply: prependAcknowledgement(
          scopeAcknowledgement,
          language === "es"
            ? `${getFirstName(state) ? `${getFirstName(state)}, ` : ""}¿qué fecha prefieres para la visita comercial?`
            : `${getFirstName(state) ? `${getFirstName(state)}, ` : ""}what date would you prefer for the commercial site visit?`,
        ),
        stage: state.stage,
      });
    }

    if (
      isPastPreferredDate(state.preferredDate) ||
      hasConflictingExplicitDate(effectiveCurrentMessage, state.preferredDate)
    ) {
      state.preferredDate = null;
      state.preferredPeriod = null;
      state.stage = "collecting_preference";
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply:
          language === "es"
            ? "Quiero confirmar la fecha porque el día de la semana y la fecha indicada no parecen coincidir, o esa fecha ya pasó. ¿Cuál es la fecha correcta para la visita? Por ejemplo: miércoles 2 de septiembre."
            : "I want to confirm the date because the weekday and date provided do not appear to match, or that date has already passed. What is the correct date for the visit? For example: Wednesday, September 2.",
        stage: state.stage,
      });
    }

    if (!state.preferredPeriod) {
      state.stage = "collecting_preference";
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply: prependAcknowledgement(
          scopeAcknowledgement,
          language === "es"
            ? `${getFirstName(state) ? `${getFirstName(state)}, ` : ""}¿prefieres la visita en la mañana o en la tarde?`
            : `${getFirstName(state) ? `${getFirstName(state)}, ` : ""}would you prefer the visit in the morning or afternoon?`,
        ),
        stage: state.stage,
      });
    }

    const availabilityResult = await internalPost(request, "/api/calendar-availability", {
      preferredDate: state.preferredDate,
      preferredPeriod: state.preferredPeriod,
    });

    if (!availabilityResult.ok) {
      throw new Error(`Availability lookup failed: ${availabilityResult.status}`);
    }

    const options = Array.isArray(availabilityResult.data?.options)
      ? keepSlotsOnOrAfterPreferredDate(availabilityResult.data.options, state.preferredDate)
      : [];

    if (!options.length) {
      state.preferredDate = null;
      state.preferredPeriod = null;
      state.stage = "collecting_preference";
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply:
          language === "es"
            ? "No encontré horarios disponibles a partir de esa fecha. ¿Qué otra fecha prefieres?"
            : "I could not find availability starting on that date. What other date would you prefer?",
        stage: state.stage,
      });
    }

    state.offeredSlots = options.map((option) => ({
      start: option.start,
      end: option.end,
      display: formatSlotDisplay(option.start, language),
    }));
    state.stage = "awaiting_slot_selection";
    await saveState(contactId, state);

    return response.status(200).json({
      ok: true,
      handled: true,
      language,
      reply: prependAcknowledgement(
        scopeAcknowledgement,
        availabilityReply(state.offeredSlots, language),
      ),
      stage: state.stage,
      options: state.offeredSlots,
    });
  } catch (error) {
    console.error("Unexpected appointment coordinator error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return response.status(502).json({
      ok: false,
      error: "Appointment coordination failed",
    });
  }
}
