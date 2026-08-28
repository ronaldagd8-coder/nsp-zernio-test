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

function isEmojiOnlyMessage(value) {
  const text = normalizeText(value, 500);
  if (!text) return false;

  const remainder = text.replace(
    /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\s]/gu,
    "",
  );

  return remainder.length === 0;
}

function isCourtesyOnlyMessage(value) {
  const text = normalizeForIntent(value).replace(/[.!?,]+$/g, "").trim();
  if (!text || text.length > 80) return false;
  return /^(gracias|muchas gracias|mil gracias|gracias por todo|perfecto gracias|ok gracias|thank you|thanks|thanks a lot|perfect thank you)$/.test(
    text,
  );
}

export function isWebsiteReferralMessage(value) {
  const text = normalizeForIntent(value);
  if (!text) return false;

  const requestsWebsiteDevelopment =
    /\b(quiero|necesito|busco|pueden|puedes|hacen|hacer|crear|desarrollar|disenar|construir)\b.{0,50}\b(pagina web|sitio web|website|web site|web page)\b/.test(
      text,
    ) ||
    /\b(build|create|develop|design|make|need|want|looking for)\b.{0,50}\b(a |an |my |our )?(website|web site|web page)\b/.test(
      text,
    ) ||
    /\b(desarrollo web|website development|web development)\b/.test(text);

  if (requestsWebsiteDevelopment) return false;

  return (
    /\b(contact(ing|ed)?|writing|messaging|reaching out|found you|came|coming)\b.{0,60}\b(from|through|via|on)\b.{0,20}\b(your |the )?(website|web site|web page)\b/.test(
      text,
    ) ||
    /\b(click(ed|ing)?|used|using)\b.{0,50}\b(whatsapp|link|button)\b.{0,50}\b(website|web site|web page)\b/.test(
      text,
    ) ||
    /\b(contactando|escribiendo|escribo|contacte|encontre|vengo|llegue)\b.{0,70}\b(desde|por|mediante|en|a traves de)\b.{0,30}\b(su |la |el )?(pagina web|sitio web|web)\b/.test(
      text,
    ) ||
    /\b(link|enlace|boton)\b.{0,30}\b(whatsapp)\b.{0,50}\b(pagina web|sitio web|web)\b/.test(
      text,
    )
  );
}

function isClearlyOutOfScopeService(value) {
  const text = normalizeForIntent(value);
  if (!text) return false;
  return /\b(tapizar|tapizado|tapiceria|retapizar|upholster|upholstery|reupholster|reupholstery|reparar (una |varias )?sillas?|reparacion de (una |varias )?sillas?|repair (a |the )?chairs?|chair repair|reparar muebles?|reparacion de muebles?|furniture repair)\b/.test(
    text,
  );
}

export function getOutOfScopeReply(language) {
  return language === "es"
    ? "Gracias por consultarnos. Esa solicitud no corresponde a los servicios de construcción, remodelación o reparación de instalaciones comerciales que ofrece NEXT SOLUTIONS PARTNERS, por lo que no puedo programar una visita para ese servicio."
    : "Thank you for checking with us. That request is outside the commercial construction, remodeling, and building-repair services offered by NEXT SOLUTIONS PARTNERS, so I cannot schedule a visit for that service.";
}

function getFirstName(state) {
  return normalizeText(state?.customerName, 120).split(/\s+/)[0] || "";
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
    preferredDate: null,
    preferredPeriod: null,
    offeredSlots: [],
    selectedStart: null,
    selectedDisplay: null,
    eventId: null,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeState(value) {
  const parsed = safeJsonParse(value, {});
  return {
    ...defaultState(),
    ...(parsed && typeof parsed === "object" ? parsed : {}),
    offeredSlots: Array.isArray(parsed?.offeredSlots) ? parsed.offeredSlots.slice(0, 3) : [],
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

  const directResponse = await zernioFetch(
    `/contacts/${encodeURIComponent(identifier)}`,
  );

  if (directResponse.ok) {
    const directData = await directResponse.json();
    return directData?.contact?.id ?? directData?.id ?? identifier;
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
  return selected?.id ?? selected?._id ?? selected?.accountId ?? null;
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

function getContactPhone(contact) {
  const candidates = [
    contact?.phone,
    contact?.phoneNumber,
    contact?.platformIdentifier,
    contact?.displayIdentifier,
    contact?.metadata?.phone,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeText(
      candidate === null || candidate === undefined ? "" : String(candidate),
      100,
    );
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

async function analyzeMessage({ currentMessage, history, state }) {
  const systemPrompt = `You extract scheduling information for NEXT SOLUTIONS PARTNERS, a commercial general contractor in Dallas-Fort Worth.
Return one JSON object only. Do not write customer-facing prose.

Determine whether the customer's CURRENT message is related to requesting, selecting, confirming, changing, cancelling, or checking a commercial site-visit appointment.
If booking state is already active, interpret short answers in that scheduling context.
Extract only information actually stated or clearly established in the conversation. Never invent an address, name, date, time, property type, scope, company, or confirmation.
NEXT SOLUTIONS PARTNERS handles commercial construction and building-related work, including new construction, renovations, remodeling, tenant improvements, build-outs, additions, demolition, repairs, and maintenance. Relevant trades and components may include electrical, plumbing, HVAC, framing, drywall, insulation, painting, flooring, ceramic and tile, suspended and acoustic ceilings, concrete, masonry, carpentry, millwork, cabinets, doors, windows, storefronts, roofing, shingles, waterproofing, gutters, siding, stucco, and related interior or exterior commercial work. These examples are not exhaustive. Do not promise that a specific project will be accepted; collect the details and state that the team will review the request.
Standalone furniture repair, chair repair, and upholstery are outside the company's scope. Do not treat an appointment request for an out-of-scope service as eligible for scheduling.
References to the company website may describe only how the customer reached NEXT SOLUTIONS PARTNERS. Messages such as "I'm contacting you from your website," "I found you through your website," or "Vengo de su pagina web" are contact-source statements, not requests for website development. For a contact-source statement alone, set bookingRelated to false and serviceInScope to null. Only treat website development as the requested service when the customer clearly asks the company to build, create, design, or develop a website.
Dates must be YYYY-MM-DD. Resolve relative dates using today's Central Time date: ${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())}.
preferredPeriod must be morning, afternoon, or any.
selectedOption must be 1, 2, or 3 only when the customer clearly chooses one of the offered options.
explicitConfirmation is true only when the assistant previously presented a booking summary and the customer clearly approves it.
cancelBooking is true only when the customer clearly cancels or stops the scheduling process.
changeOrCancelExisting is true if the customer wants to change or cancel a request already submitted for team approval.
newCommercialProject is true when the CURRENT message starts or continues discussing commercial work that is separate from an already confirmed appointment. This includes a direct answer to the assistant asking whether the customer has another commercial construction or remodeling need. Do not mark a message as a change to the confirmed appointment unless the customer explicitly refers to changing, correcting, rescheduling, or cancelling that appointment. A short reply such as "Yes, in an office" after the assistant asks whether there is commercial work it can help with is a new-project conversation, not an appointment modification. If the customer only acknowledges that another project exists but has not requested a site visit, bookingRelated must remain false.
separateProjectQuestion is true when the CURRENT message asks a company, service, construction, property, or project question that is separate from answering the pending scheduling question. A booking state being active does not by itself make a separate project question booking-related.

Required JSON keys:
{
  "bookingRelated": boolean,
  "serviceInScope": boolean | null,
  "language": "es" | "en",
  "cancelBooking": boolean,
  "changeOrCancelExisting": boolean,
  "newCommercialProject": boolean,
  "separateProjectQuestion": boolean,
  "explicitConfirmation": boolean,
  "selectedOption": number | null,
  "customerName": string | null,
  "companyName": string | null,
  "propertyType": string | null,
  "projectAddress": string | null,
  "projectScope": string | null,
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
    if (value) next[field] = value;
  }
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
    isSpecificPropertyType(answer)
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
    return `Antes de enviar la solicitud, confirma por favor estos datos:\n\nNombre: ${state.customerName}\nPropiedad: ${state.propertyType}\nDirección: ${state.projectAddress}\nTrabajo: ${state.projectScope}\nHorario solicitado: ${selectedDisplay}\n\nEste horario quedará pendiente de aprobación del equipo. ¿Confirmas que deseas enviar la solicitud?`;
  }
  return `Before I submit the request, please confirm these details:\n\nName: ${state.customerName}\nProperty: ${state.propertyType}\nAddress: ${state.projectAddress}\nWork requested: ${state.projectScope}\nRequested time: ${selectedDisplay}\n\nThis time will remain pending team approval. Would you like me to submit the request?`;
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

    analysis = applyExpectedFieldAnswer(
      state,
      analysis,
      effectiveCurrentMessage,
    );

    const bookingContextActive = state.active || state.stage !== "idle";
    const websiteReferralMessage = isWebsiteReferralMessage(
      effectiveCurrentMessage,
    );

    if (
      state.stage === "idle" &&
      ((analysis.serviceInScope === false && !websiteReferralMessage) ||
        isClearlyOutOfScopeService(effectiveCurrentMessage) ||
        isClearlyOutOfScopeService(analysis.projectScope))
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

    if (websiteReferralMessage && !analysis.bookingRelated) {
      return response.status(200).json({
        ok: true,
        handled: false,
        websiteReferral: true,
        bookingDraftPreserved: bookingContextActive,
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

      if (analysis.newCommercialProject === true) {
        const previousCustomerName = state.customerName;
        const previousCompanyName = state.companyName;
        state = applyUpdates(
          {
            ...defaultState(),
            customerName: previousCustomerName,
            companyName: previousCompanyName,
            language: confirmedLanguage,
          },
          analysis,
        );
        state.active = analysis.bookingRelated === true;
        await saveState(contactId, state);

        if (!analysis.bookingRelated) {
          return response.status(200).json({
            ok: true,
            handled: false,
            newCommercialProject: true,
            previousConfirmedAppointmentPreserved: true,
            stage: state.stage,
          });
        }
      } else {
        if (!analysis.bookingRelated && !analysis.changeOrCancelExisting) {
          return response.status(200).json({
            ok: true,
            handled: false,
            stage: state.stage,
          });
        }

        return response.status(200).json({
          ok: true,
          handled: true,
          handoffRequired: true,
          language: confirmedLanguage,
          reply:
            confirmedLanguage === "es"
              ? `Entiendo${getFirstName(state) ? `, ${getFirstName(state)}` : ""}. Tu visita ya está confirmada. Un miembro del equipo te ayudará personalmente a corregirla, cambiarla o cancelarla.`
              : `I understand${getFirstName(state) ? `, ${getFirstName(state)}` : ""}. Your site visit is already confirmed. A team member will personally help you correct, change, or cancel it.`,
          stage: state.stage,
        });
      }
    }

    if (!analysis.bookingRelated && state.stage === "pending_approval") {
      return response.status(200).json({ ok: true, handled: false, stage: state.stage });
    }

    const language = analysis.language === "es" ? "es" : state.language === "es" ? "es" : "en";

    if (
      state.stage === "awaiting_confirmation" &&
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

    if (
      state.stage === "awaiting_confirmation" &&
      isDirectRejection(effectiveCurrentMessage)
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
        whatsappNumber: getContactPhone(contact),
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
          reply: askForField(missing[0], language, state),
          stage: state.stage,
          missingFields: missing,
        });
      }

      state.stage = "awaiting_confirmation";
      await saveState(contactId, state);
      return response.status(200).json({
        ok: true,
        handled: true,
        language,
        reply: confirmationReply(state, language),
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
        reply: askForField(missingDetails[0], language, state),
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
        reply:
          language === "es"
            ? `${getFirstName(state) ? `${getFirstName(state)}, ` : ""}¿qué fecha prefieres para la visita comercial?`
            : `${getFirstName(state) ? `${getFirstName(state)}, ` : ""}what date would you prefer for the commercial site visit?`,
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
        reply:
          language === "es"
            ? `${getFirstName(state) ? `${getFirstName(state)}, ` : ""}¿prefieres la visita en la mañana o en la tarde?`
            : `${getFirstName(state) ? `${getFirstName(state)}, ` : ""}would you prefer the visit in the morning or afternoon?`,
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
      reply: availabilityReply(state.offeredSlots, language),
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
