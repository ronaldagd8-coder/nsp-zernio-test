import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";
const REVIEW_FIELD_NAME = "internal_service_review_queue";
const CUSTOMER_REVIEW_FIELD_NAME = "service_review_state";

export const config = { maxDuration: 60 };

function normalizeText(value, maxLength = 1000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function secretsMatch(received, expected) {
  if (!received || !expected) return false;
  const left = Buffer.from(String(received));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function receivedSecret(request) {
  return request.headers["x-webhook-secret"] ??
    request.headers["x-internal-secret"] ??
    request.body?.webhookSecret ??
    request.query?.secret;
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

function safeJsonParse(value, fallback) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function extractAccounts(payload) {
  return [payload?.accounts, payload?.data?.accounts, payload?.data, payload?.items]
    .find(Array.isArray) ?? [];
}

function extractContacts(payload) {
  return [payload?.contacts, payload?.data?.contacts, payload?.data, payload?.items]
    .find(Array.isArray) ?? [];
}

function externalId(value) {
  if (typeof value === "string" || typeof value === "number") {
    return normalizeText(String(value), 300);
  }
  if (!value || typeof value !== "object") return "";
  return externalId(value.id ?? value._id ?? value.profileId ?? value.accountId);
}

function contactId(contact) {
  return externalId(contact?.id ?? contact?._id ?? contact?.contactId);
}

function collectPhoneCandidates(value, depth = 0, output = []) {
  if (!value || typeof value !== "object" || depth > 6 || output.length >= 40) {
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) collectPhoneCandidates(item, depth + 1, output);
    return output;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      /^(phone|phoneNumber|mobile|mobileNumber|waId|wa_id|platformIdentifier|displayIdentifier|number)$/i.test(key) &&
      (typeof nested === "string" || typeof nested === "number")
    ) {
      const candidate = normalizePhone(nested);
      if (candidate.length >= 7 && !output.includes(candidate)) output.push(candidate);
    }
    if (nested && typeof nested === "object") {
      collectPhoneCandidates(nested, depth + 1, output);
    }
  }
  return output;
}

async function resolveContact(identifier) {
  const direct = normalizeText(String(identifier ?? ""), 300);
  if (direct && !/^\+?[\d\s().-]{7,30}$/.test(direct)) {
    const response = await zernioFetch(`/contacts/${encodeURIComponent(direct)}`);
    if (response.ok) {
      const payload = await response.json();
      return payload?.contact ?? payload;
    }
  }

  const targetPhone = normalizePhone(identifier);
  if (!targetPhone) return null;
  const response = await zernioFetch("/contacts?platform=whatsapp&limit=200");
  if (!response.ok) return null;
  const contacts = extractContacts(await response.json());
  return contacts.find((contact) =>
    collectPhoneCandidates(contact).some((phone) =>
      phone === targetPhone || phone.endsWith(targetPhone) || targetPhone.endsWith(phone),
    ),
  ) ?? null;
}

async function getContact(identifier) {
  const resolved = await resolveContact(identifier);
  const id = contactId(resolved);
  if (!id) throw new Error("Zernio contact could not be resolved");
  if (resolved?.customFields || resolved?.metadata?.customFields) return resolved;
  const response = await zernioFetch(`/contacts/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Contact lookup failed: ${response.status}`);
  const payload = await response.json();
  return payload?.contact ?? payload;
}

function customFields(contact) {
  return contact?.customFields ?? contact?.metadata?.customFields ?? {};
}

async function saveContactField(id, fieldName, value) {
  const response = await zernioFetch(
    `/contacts/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldName)}`,
    { method: "PUT", body: JSON.stringify({ value: JSON.stringify(value) }) },
  );
  if (!response.ok) throw new Error(`Contact field update failed: ${response.status}`);
}

async function resolveWhatsAppConnection() {
  const response = await zernioFetch("/accounts?platform=whatsapp&page=1&limit=100");
  if (!response.ok) throw new Error(`WhatsApp account lookup failed: ${response.status}`);
  const accounts = extractAccounts(await response.json()).filter(
    (account) => String(account?.platform ?? "").toLowerCase() === "whatsapp",
  );
  const selected = accounts.find((account) =>
    ["active", "live", "connected"].includes(String(account?.status ?? "").toLowerCase()),
  ) ?? accounts[0];
  const accountId = externalId(
    selected?.id ?? selected?._id ?? process.env.ZERNIO_WHATSAPP_ACCOUNT_ID ?? selected?.accountId,
  );
  const profileId = externalId(
    process.env.ZERNIO_PROFILE_ID ?? selected?.profile?.id ?? selected?.profileId,
  );
  if (!accountId) throw new Error("No WhatsApp account is available");
  if (!profileId) throw new Error("No WhatsApp profile is available");
  return { accountId, profileId };
}

export function createReviewReference(now = new Date(), uuid = randomUUID()) {
  const date = now.toISOString().slice(2, 10).replaceAll("-", "");
  return `NSP-SR-${date}-${uuid.replaceAll("-", "").slice(0, 4).toUpperCase()}`;
}

export function reviewTemplateVariables(review) {
  return [
    review.reference,
    review.customerName,
    review.property,
    review.service,
    review.details,
  ];
}

export function normalizeReviewDecision(value) {
  const text = normalizeText(String(value ?? ""), 100).toLowerCase();
  if (/^(1(?:[\s.):-]+(?:sí|si)(?:,?\s*evaluar)?)?|sí,? evaluar|si,? evaluar|sí evaluar|si evaluar)$/.test(text)) return "evaluate";
  if (/^(2(?:[\s.):-]+no ofrecemos)?|no ofrecemos)$/.test(text)) return "not_offered";
  if (/^(3(?:[\s.):-]+pedir informaci[oó]n)?|pedir información|pedir informacion)$/.test(text)) return "request_information";
  return null;
}

export function pendingReviewIndex(queue, reference = "", quotedMessageId = "") {
  if (!Array.isArray(queue)) return -1;
  const normalizedReference = normalizeText(reference, 100).toUpperCase();
  if (normalizedReference) {
    return queue.findIndex((item) => item?.reference === normalizedReference);
  }
  const normalizedMessageId = normalizeText(quotedMessageId, 500);
  if (normalizedMessageId) {
    return queue.findIndex((item) =>
      item?.status === "pending_internal_review" &&
      normalizeText(item?.deliveryMessageId, 500) === normalizedMessageId
    );
  }
  const pendingIndexes = queue
    .map((item, index) => item?.status === "pending_internal_review" ? index : -1)
    .filter((index) => index >= 0);
  return pendingIndexes.length === 1 ? pendingIndexes[0] : -1;
}

export function customerDecisionReply({ decision, language, service }) {
  if (decision === "evaluate") {
    return language === "es"
      ? `Nuestro equipo puede evaluar el alcance de ${service} durante una visita comercial. La solicitud seguirá sujeta a revisión y aprobación del equipo. ¿Deseas continuar con la solicitud de visita?`
      : `Our team can evaluate the ${service} scope during a commercial site visit. The request will remain subject to team review and approval. Would you like to continue with the site-visit request?`;
  }
  if (decision === "not_offered") {
    return language === "es"
      ? `Gracias por consultarnos. El equipo confirmó que actualmente no ofrecemos ${service}. Si necesitas ayuda con otro trabajo de construcción o remodelación comercial, con gusto puedo orientarte.`
      : `Thank you for checking with us. The team confirmed that we do not currently offer ${service}. If you need help with another commercial construction or remodeling project, I can assist you.`;
  }
  return language === "es"
    ? `Para que el equipo pueda evaluar correctamente la solicitud relacionada con ${service}, ¿puedes contarme un poco más sobre el trabajo, el equipo involucrado y el resultado que necesitas?`
    : `To help the team properly evaluate the request involving ${service}, can you provide more information about the work, the equipment involved, and the result you need?`;
}

export function internalReviewTemplatePayload({ accountId, reviewerPhone, templateName, review }) {
  const phone = normalizePhone(reviewerPhone);
  if (!phone) throw new Error("Internal reviewer phone is required");
  return {
    accountId,
    participantId: `+${phone}`,
    templateName,
    templateLanguage: "es",
    templateParams: reviewTemplateVariables(review),
  };
}

async function sendInternalReviewTemplate({ review }) {
  const { accountId } = await resolveWhatsAppConnection();
  const body = internalReviewTemplatePayload({
    accountId,
    reviewerPhone: process.env.INTERNAL_SERVICE_REVIEW_PHONE,
    templateName: process.env.INTERNAL_SERVICE_REVIEW_TEMPLATE || "internal_service_review_es",
    review,
  });
  const response = await zernioFetch("/inbox/conversations", {
    method: "POST",
    headers: {
      "Idempotency-Key": createHash("sha256")
        .update(`internal-review-template|${review.reference}`)
        .digest("hex"),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Internal review template failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
  const payload = await response.json();
  return {
    deliveryMessageId:
      payload?.data?.messageId ?? payload?.message?.platformMessageId ?? null,
    deliveryConversationId:
      payload?.data?.conversationId ??
      payload?.conversation?.id ??
      payload?.data?.conversation?.id ??
      null,
    sentAt: new Date().toISOString(),
  };
}

async function sendConversationMessage({ conversationId, message, idempotencySource }) {
  const { accountId } = await resolveWhatsAppConnection();
  const response = await zernioFetch(
    `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": createHash("sha256").update(idempotencySource).digest("hex"),
      },
      body: JSON.stringify({ accountId, message }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Customer review response failed: ${response.status} ${body.slice(0, 400)}`);
  }
}

async function createReview(body) {
  const customerContact = await getContact(body.customerContactIdentifier);
  const customerContactId = contactId(customerContact);
  const reviewerContact = await getContact(process.env.INTERNAL_SERVICE_REVIEW_PHONE);
  const reviewerContactId = contactId(reviewerContact);
  const queue = safeJsonParse(customFields(reviewerContact)?.[REVIEW_FIELD_NAME], []);
  const pendingEquivalent = Array.isArray(queue)
    ? [...queue].reverse().find((item) =>
      item?.status === "pending_internal_review" &&
      item?.customerContactId === customerContactId &&
      normalizeText(item?.service, 500).toLowerCase() ===
        normalizeText(body.service, 500).toLowerCase()
    )
    : null;
  if (pendingEquivalent) {
    return {
      review: pendingEquivalent,
      alreadyPending: true,
      customerReply: pendingEquivalent.language === "es"
        ? `Este servicio ya está pendiente de revisión con el equipo bajo la solicitud ${pendingEquivalent.reference}. Te responderemos en cuanto tengamos una decisión.`
        : `This service is already pending team review under request ${pendingEquivalent.reference}. We will respond as soon as a decision is available.`,
    };
  }
  const review = {
    reference: createReviewReference(),
    customerContactId,
    customerConversationId: normalizeText(body.customerConversationId, 300),
    customerName: normalizeText(body.customerName, 200) || "Cliente",
    property: normalizeText(body.property, 500) || "No especificada",
    service: normalizeText(body.service, 500),
    details: normalizeText(body.details, 1500) || "Sin detalles adicionales.",
    language: body.customerLanguage === "en" ? "en" : "es",
    status: "pending_internal_review",
    createdAt: new Date().toISOString(),
  };
  if (!review.customerConversationId || !review.service) {
    throw new Error("Customer conversation and service are required");
  }
  const nextQueue = [...(Array.isArray(queue) ? queue : []), review].slice(-20);
  await saveContactField(reviewerContactId, REVIEW_FIELD_NAME, nextQueue);
  await saveContactField(customerContactId, CUSTOMER_REVIEW_FIELD_NAME, review);
  const delivery = await sendInternalReviewTemplate({ review });
  const deliveredReview = { ...review, ...delivery };
  const deliveredQueue = nextQueue.slice();
  deliveredQueue[deliveredQueue.length - 1] = deliveredReview;
  await saveContactField(reviewerContactId, REVIEW_FIELD_NAME, deliveredQueue);
  await saveContactField(customerContactId, CUSTOMER_REVIEW_FIELD_NAME, deliveredReview);
  return {
    review: deliveredReview,
    customerReply: review.language === "es"
      ? `Un momento, por favor. Estoy verificando este servicio con nuestro equipo y te responderé por este mismo medio tan pronto tenga la confirmación. Referencia: ${review.reference}.`
      : `One moment, please. I'm verifying this service with our team and will reply here as soon as I receive confirmation. Reference: ${review.reference}.`,
  };
}

async function resolveReview(body) {
  const reviewerContact = await getContact(body.reviewerContactIdentifier);
  const expectedReviewer = await getContact(process.env.INTERNAL_SERVICE_REVIEW_PHONE);
  const reviewerContactId = contactId(reviewerContact);
  if (!reviewerContactId || reviewerContactId !== contactId(expectedReviewer)) {
    throw new Error("Only the configured internal reviewer can resolve service reviews");
  }
  const queue = safeJsonParse(customFields(reviewerContact)?.[REVIEW_FIELD_NAME], []);
  const reference = normalizeText(body.reference, 100).toUpperCase();
  const quotedMessageId = normalizeText(body.quotedMessageId, 500);
  const decision = normalizeReviewDecision(body.decision);
  if (!decision) throw new Error("A valid review decision is required");
  const index = pendingReviewIndex(queue, reference, quotedMessageId);
  if (index < 0) throw new Error("The service review reference was not found");
  const review = queue[index];
  if (review.status !== "pending_internal_review") {
    return { review, alreadyResolved: true };
  }
  const message = customerDecisionReply({
    decision,
    language: review.language,
    service: review.service,
  });
  await sendConversationMessage({
    conversationId: review.customerConversationId,
    message,
    idempotencySource: `${reference}|${decision}|${message}`,
  });
  const resolved = {
    ...review,
    status: decision === "request_information" ? "awaiting_customer_details" : "resolved",
    decision,
    resolvedAt: new Date().toISOString(),
  };
  const nextQueue = queue.slice();
  nextQueue[index] = resolved;
  await saveContactField(reviewerContactId, REVIEW_FIELD_NAME, nextQueue);
  await saveContactField(review.customerContactId, CUSTOMER_REVIEW_FIELD_NAME, resolved);
  return { review: resolved, customerMessage: message };
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "GET") {
    return response.status(200).json({
      ok: true,
      service: "nsp-zernio-test",
      status: "ready",
    });
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!secretsMatch(receivedSecret(request), process.env.INTERNAL_WEBHOOK_SECRET)) {
    return response.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (
    !process.env.ZERNIO_API_KEY ||
    !process.env.INTERNAL_SERVICE_REVIEW_PHONE ||
    !process.env.INTERNAL_SERVICE_REVIEW_TEMPLATE
  ) {
    return response.status(500).json({ ok: false, error: "Server configuration error" });
  }

  try {
    const action = normalizeText(request.body?.action, 100);
    if (action === "create_service_review") {
      const result = await createReview(request.body ?? {});
      return response.status(200).json({ ok: true, handled: true, action, ...result });
    }
    if (action === "resolve_service_review") {
      const result = await resolveReview(request.body ?? {});
      return response.status(200).json({ ok: true, handled: true, action, ...result });
    }
    return response.status(400).json({ ok: false, error: "Unsupported action" });
  } catch (error) {
    console.error("Internal service review failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return response.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : "Internal service review failed",
    });
  }
}
