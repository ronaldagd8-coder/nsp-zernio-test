import {
  createHash,
  createPrivateKey,
  createSign,
  timingSafeEqual,
} from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar";
const ZERNIO_API_BASE_URL = "https://zernio.com/api/v1";
const TIME_ZONE = "America/Chicago";

export const config = { maxDuration: 60 };

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;
  const received = Buffer.from(String(receivedSecret));
  const expected = Buffer.from(String(expectedSecret));
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function normalizeText(value, maxLength = 1000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function getReceivedSecret(request) {
  return (
    request.headers["x-webhook-secret"] ??
    request.headers["x-internal-secret"] ??
    request.body?.webhookSecret ??
    request.query?.secret
  );
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getServiceAccount() {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!encoded) throw new Error("Google service account is not configured");
  const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("Invalid Google service account configuration");
  }
  return serviceAccount;
}

function createGoogleJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: GOOGLE_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsignedToken = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const signature = signer
    .sign(createPrivateKey(serviceAccount.private_key))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${unsignedToken}.${signature}`;
}

async function getGoogleAccessToken() {
  const assertion = createGoogleJwt(getServiceAccount());
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Google authentication failed: ${tokenResponse.status}`);
  }
  const data = await tokenResponse.json();
  if (!data.access_token) throw new Error("Google did not return an access token");
  return data.access_token;
}

async function googleCalendarFetch(path, accessToken, options = {}) {
  return fetch(`${GOOGLE_CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
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

function extractAccounts(data) {
  const candidates = [data?.accounts, data?.data?.accounts, data?.data, data?.items];
  return candidates.find(Array.isArray) ?? [];
}

async function resolveWhatsAppAccountId() {
  const accountResponse = await zernioFetch(
    "/accounts?platform=whatsapp&page=1&limit=100",
  );
  if (!accountResponse.ok) {
    throw new Error(`WhatsApp account lookup failed: ${accountResponse.status}`);
  }
  const accounts = extractAccounts(await accountResponse.json()).filter(
    (account) => String(account?.platform ?? "").toLowerCase() === "whatsapp",
  );
  const selected =
    accounts.find((account) =>
      ["active", "live", "connected"].includes(String(account?.status ?? "").toLowerCase()),
    ) ?? accounts[0];
  const accountId = selected?.id ?? selected?._id ?? selected?.accountId;
  if (!accountId) throw new Error("No WhatsApp account is available");
  return accountId;
}

function formatDateTime(value, language) {
  const date = new Date(value);
  const locale = language === "es" ? "es-US" : "en-US";
  const dateLabel = new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const timeLabel = new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return language === "es"
    ? `${dateLabel} a las ${timeLabel}, hora central`
    : `${dateLabel} at ${timeLabel} Central Time`;
}

function notificationMessage({ action, language, customerName, start }) {
  const when = formatDateTime(start, language);
  if (action === "approve") {
    return language === "es"
      ? `Hola ${customerName}. Tu visita comercial con NEXT SOLUTIONS PARTNERS para ${when} ha sido confirmada. Si necesitas informarnos algún cambio, responde a este mensaje.`
      : `Hello ${customerName}. Your commercial site visit with NEXT SOLUTIONS PARTNERS for ${when} has been confirmed. If you need to let us know about any changes, reply to this message.`;
  }
  return language === "es"
    ? `Hola ${customerName}. No pudimos confirmar el horario solicitado para ${when}. Responde a este mensaje y te ayudaremos a revisar otra opción disponible.`
    : `Hello ${customerName}. We could not confirm the requested time for ${when}. Reply to this message and we will help you review another available option.`;
}

async function sendWhatsAppNotification({ conversationId, message, eventId, action }) {
  if (!conversationId) {
    return { sent: false, reason: "missing_conversation_id" };
  }
  if (!process.env.ZERNIO_API_KEY) {
    return { sent: false, reason: "zernio_not_configured" };
  }

  const accountId = await resolveWhatsAppAccountId();
  const idempotencyKey = createHash("sha256")
    .update(`${eventId}|${action}|${message}`)
    .digest("hex");
  const sendResponse = await zernioFetch(
    `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ accountId, message }),
    },
  );

  if (!sendResponse.ok) {
    const errorBody = await sendResponse.text();
    console.error("WhatsApp approval notification failed", {
      status: sendResponse.status,
      response: errorBody.slice(0, 300),
    });
    return {
      sent: false,
      reason: sendResponse.status === 422 ? "whatsapp_window_or_template_required" : "send_failed",
      status: sendResponse.status,
    };
  }
  return { sent: true };
}

function eventToPublicBooking(event) {
  const privateData = event?.extendedProperties?.private ?? {};
  return {
    eventId: event.id,
    status: privateData.bookingStatus ?? "pending_approval",
    customerName: privateData.customerName || event.summary?.split("—").at(-1)?.trim() || "Customer",
    whatsappNumber: privateData.whatsappNumber || "",
    language: privateData.language === "es" ? "es" : "en",
    location: event.location ?? "",
    description: event.description ?? "",
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    eventLink: event.htmlLink ?? null,
  };
}

async function listPendingApprovals(accessToken, calendarId) {
  const query = new URLSearchParams({
    timeMin: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    privateExtendedProperty: "bookingStatus=pending_approval",
    maxResults: "100",
  });
  const calendarResponse = await googleCalendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
    accessToken,
  );
  if (!calendarResponse.ok) {
    throw new Error(`Pending event lookup failed: ${calendarResponse.status}`);
  }
  const data = await calendarResponse.json();
  return (data.items ?? []).map(eventToPublicBooking);
}

function replaceStatusLine(description, statusLine) {
  const text = normalizeText(description, 8000);
  if (!text) return statusLine;
  if (/^STATUS:.*$/m.test(text)) return text.replace(/^STATUS:.*$/m, statusLine);
  return `${statusLine}\n\n${text}`;
}

async function updateApproval({ accessToken, calendarId, eventId, action }) {
  const eventResponse = await googleCalendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    accessToken,
  );
  if (eventResponse.status === 404) return { notFound: true };
  if (!eventResponse.ok) {
    throw new Error(`Calendar event lookup failed: ${eventResponse.status}`);
  }

  const event = await eventResponse.json();
  const privateData = event.extendedProperties?.private ?? {};
  const existingStatus = privateData.bookingStatus ?? "";
  const targetStatus = action === "approve" ? "confirmed" : "declined";
  if (existingStatus === targetStatus) {
    return { event, alreadyProcessed: true, targetStatus };
  }
  if (existingStatus && existingStatus !== "pending_approval") {
    return { conflict: true, existingStatus };
  }

  const customerName = privateData.customerName || event.summary?.split("—").at(-1)?.trim() || "Customer";
  const summaryPrefix = action === "approve" ? "CONFIRMED" : "DECLINED";
  const statusLine = action === "approve" ? "STATUS: CONFIRMED" : "STATUS: DECLINED";
  const patchBody = {
    status: "confirmed",
    transparency: action === "approve" ? "opaque" : "transparent",
    summary: `${summaryPrefix} — Commercial Site Visit — ${customerName}`,
    description: replaceStatusLine(event.description, statusLine),
    extendedProperties: {
      ...event.extendedProperties,
      private: {
        ...privateData,
        bookingStatus: targetStatus,
        reviewedAt: new Date().toISOString(),
      },
    },
  };

  const patchResponse = await googleCalendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    accessToken,
    { method: "PATCH", body: JSON.stringify(patchBody) },
  );
  if (!patchResponse.ok) {
    const body = await patchResponse.text();
    throw new Error(`Calendar approval update failed: ${patchResponse.status} ${body.slice(0, 200)}`);
  }
  return { event: await patchResponse.json(), alreadyProcessed: false, targetStatus };
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");

  if (!secretsMatch(getReceivedSecret(request), process.env.INTERNAL_WEBHOOK_SECRET)) {
    return response.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (!process.env.GOOGLE_CALENDAR_ID) {
    return response.status(500).json({ ok: false, error: "Google Calendar is not configured" });
  }

  try {
    const accessToken = await getGoogleAccessToken();
    const calendarId = process.env.GOOGLE_CALENDAR_ID;

    if (request.method === "GET") {
      const approvals = await listPendingApprovals(accessToken, calendarId);
      return response.status(200).json({ ok: true, count: approvals.length, approvals });
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", "GET, POST");
      return response.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const eventId = normalizeText(request.body?.eventId, 300);
    const action = normalizeText(request.body?.action, 20);
    if (!eventId || !["approve", "decline"].includes(action)) {
      return response.status(400).json({ ok: false, error: "A valid eventId and action are required" });
    }

    const result = await updateApproval({ accessToken, calendarId, eventId, action });
    if (result.notFound) return response.status(404).json({ ok: false, error: "Event not found" });
    if (result.conflict) {
      return response.status(409).json({
        ok: false,
        error: "This request has already been processed",
        status: result.existingStatus,
      });
    }

    const event = result.event;
    const privateData = event.extendedProperties?.private ?? {};
    const language = privateData.language === "es" ? "es" : "en";
    const customerName = privateData.customerName || event.summary?.split("—").at(-1)?.trim() || "Customer";
    let notification = { sent: false, reason: "already_processed" };

    if (!result.alreadyProcessed) {
      notification = await sendWhatsAppNotification({
        conversationId: privateData.conversationId,
        message: notificationMessage({
          action,
          language,
          customerName,
          start: event.start?.dateTime ?? event.start?.date,
        }),
        eventId,
        action,
      });
    }

    return response.status(200).json({
      ok: true,
      action,
      bookingStatus: result.targetStatus,
      alreadyProcessed: result.alreadyProcessed,
      notification,
      event: eventToPublicBooking(event),
    });
  } catch (error) {
    console.error("Unexpected appointment approval error", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return response.status(502).json({ ok: false, error: "Appointment approval failed" });
  }
}
