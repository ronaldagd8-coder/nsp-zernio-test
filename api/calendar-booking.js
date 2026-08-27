import {
  createHash,
  createPrivateKey,
  createSign,
  timingSafeEqual,
} from "node:crypto";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar";

const TIME_ZONE = "America/Chicago";
const APPOINTMENT_MINUTES = 60;
const BUFFER_MINUTES = 60;
const MINIMUM_NOTICE_HOURS = 24;
const MAXIMUM_ADVANCE_DAYS = 30;
const ALLOWED_START_HOURS = [9, 11, 13, 15];

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) return false;
  const received = Buffer.from(String(receivedSecret));
  const expected = Buffer.from(String(expectedSecret));
  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
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

  const serviceAccount = JSON.parse(
    Buffer.from(encoded, "base64").toString("utf8"),
  );

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

  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    throw new Error("Google did not return an access token");
  }
  return tokenData.access_token;
}

function normalizeText(value, maximumLength = 1000) {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
}

function normalizeEmail(value) {
  const email = normalizeText(value, 254);
  if (!email) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function getLocalDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return {
    weekday: values.weekday,
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function validateSelectedSlot(selectedStart) {
  const start = new Date(selectedStart);
  if (Number.isNaN(start.getTime())) {
    return { valid: false, error: "The selected appointment time is invalid" };
  }

  const now = Date.now();
  const earliestAllowed = now + MINIMUM_NOTICE_HOURS * 60 * 60 * 1000;
  const latestAllowed = now + MAXIMUM_ADVANCE_DAYS * 24 * 60 * 60 * 1000;
  if (start.getTime() < earliestAllowed) {
    return { valid: false, error: "Appointments require at least 24 hours of notice" };
  }
  if (start.getTime() > latestAllowed) {
    return { valid: false, error: "Appointments can only be booked up to 30 days in advance" };
  }

  const local = getLocalDateParts(start);
  if (!["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].includes(local.weekday)) {
    return { valid: false, error: "Appointments are only available Monday through Friday" };
  }
  if (!ALLOWED_START_HOURS.includes(local.hour) || local.minute !== 0) {
    return { valid: false, error: "The selected time is not an available appointment slot" };
  }
  return { valid: true, start };
}

function createBookingKey({ contactIdentifier, selectedStart, customerName }) {
  return createHash("sha256")
    .update(`${contactIdentifier}|${selectedStart}|${customerName.toLowerCase()}`)
    .digest("hex")
    .slice(0, 40);
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

async function findExistingBooking({ accessToken, calendarId, bookingKey, selectedStart }) {
  const start = new Date(selectedStart);
  const query = new URLSearchParams({
    timeMin: new Date(start.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: "true",
    privateExtendedProperty: `bookingKey=${bookingKey}`,
    maxResults: "1",
  });
  const existingResponse = await googleCalendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
    accessToken,
  );
  if (!existingResponse.ok) {
    throw new Error(`Existing booking lookup failed: ${existingResponse.status}`);
  }
  return (await existingResponse.json()).items?.[0] ?? null;
}

async function checkSlotAvailability({ accessToken, calendarId, start, end }) {
  const bufferedStart = new Date(start.getTime() - BUFFER_MINUTES * 60 * 1000);
  const bufferedEnd = new Date(end.getTime() + BUFFER_MINUTES * 60 * 1000);
  const freeBusyResponse = await googleCalendarFetch("/freeBusy", accessToken, {
    method: "POST",
    body: JSON.stringify({
      timeMin: bufferedStart.toISOString(),
      timeMax: bufferedEnd.toISOString(),
      timeZone: TIME_ZONE,
      items: [{ id: calendarId }],
    }),
  });
  if (!freeBusyResponse.ok) {
    throw new Error(`Google availability check failed: ${freeBusyResponse.status}`);
  }
  const busyPeriods = (await freeBusyResponse.json()).calendars?.[calendarId]?.busy ?? [];
  return !busyPeriods.some((period) => {
    const busyStart = new Date(period.start);
    const busyEnd = new Date(period.end);
    return busyStart < bufferedEnd && busyEnd > bufferedStart;
  });
}

function formatAppointment(start) {
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(start);
  const timeLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(start);
  return { dateLabel, timeLabel, display: `${dateLabel} at ${timeLabel} Central Time` };
}

async function listKnownProperties({ accessToken, calendarId, contactIdentifier }) {
  const query = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    privateExtendedProperty: `contactIdentifier=${contactIdentifier}`,
    maxResults: "250",
  });
  const calendarResponse = await googleCalendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
    accessToken,
  );
  if (!calendarResponse.ok) {
    throw new Error(`Property history lookup failed: ${calendarResponse.status}`);
  }
  const data = await calendarResponse.json();
  const unique = new Map();
  for (const event of data.items ?? []) {
    const address = normalizeText(event.location, 500);
    if (!address) continue;
    const key = address.toLowerCase().replace(/\s+/g, " ");
    const privateData = event.extendedProperties?.private ?? {};
    unique.set(key, {
      address,
      propertyType: normalizeText(privateData.propertyType, 200) || null,
      lastVisit: event.start?.dateTime ?? event.start?.date ?? null,
    });
  }
  return [...unique.values()].reverse().slice(0, 20);
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
  if (!process.env.GOOGLE_CALENDAR_ID) {
    return response.status(500).json({ ok: false, error: "Google Calendar is not configured" });
  }

  const booking = request.body?.booking ?? {};
  const customerName = normalizeText(request.body?.customerName ?? booking.customerName, 150);
  const companyName = normalizeText(request.body?.companyName ?? booking.companyName, 150);
  const propertyType = normalizeText(request.body?.propertyType ?? booking.propertyType, 200);
  const projectAddress = normalizeText(request.body?.projectAddress ?? booking.projectAddress, 500);
  const projectScope = normalizeText(request.body?.projectScope ?? booking.projectScope, 2000);
  const selectedStart = normalizeText(request.body?.selectedStart ?? booking.selectedStart, 100);
  const contactIdentifier = normalizeText(
    request.body?.contactId ??
      request.body?.contactIdentifier ??
      request.body?.contact?.id ??
      booking.contactIdentifier,
    200,
  );
  const conversationId = normalizeText(
    request.body?.conversationId ?? booking.conversationId,
    200,
  );
  const whatsappNumber = normalizeText(
    request.body?.whatsappNumber ?? request.body?.contact?.phone ?? booking.whatsappNumber,
    100,
  );
  const language = normalizeText(request.body?.language ?? booking.language, 10) === "es" ? "es" : "en";
  const email = normalizeEmail(request.body?.email ?? booking.email);

  if (request.body?.action === "list_properties") {
    if (!contactIdentifier) {
      return response.status(400).json({ ok: false, error: "A contactIdentifier is required" });
    }
    try {
      const accessToken = await getGoogleAccessToken();
      const properties = await listKnownProperties({
        accessToken,
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        contactIdentifier,
      });
      return response.status(200).json({ ok: true, properties });
    } catch (error) {
      console.error("Property history lookup failed", error);
      return response.status(502).json({ ok: false, error: "Property history could not be loaded" });
    }
  }

  const required = { customerName, propertyType, projectAddress, projectScope, selectedStart, contactIdentifier, conversationId };
  const missingFields = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missingFields.length) {
    return response.status(400).json({
      ok: false,
      error: "Required booking information is missing",
      missingFields,
    });
  }
  if (email === null) {
    return response.status(400).json({ ok: false, error: "The email address is invalid" });
  }

  const slotValidation = validateSelectedSlot(selectedStart);
  if (!slotValidation.valid) {
    return response.status(400).json({ ok: false, error: slotValidation.error });
  }

  const start = slotValidation.start;
  const end = new Date(start.getTime() + APPOINTMENT_MINUTES * 60 * 1000);
  const bookingKey = createBookingKey({
    contactIdentifier,
    selectedStart: start.toISOString(),
    customerName,
  });

  try {
    const accessToken = await getGoogleAccessToken();
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    const existingBooking = await findExistingBooking({
      accessToken,
      calendarId,
      bookingKey,
      selectedStart: start.toISOString(),
    });

    if (existingBooking) {
      return response.status(200).json({
        ok: true,
        alreadyBooked: true,
        bookingStatus: existingBooking.extendedProperties?.private?.bookingStatus ?? "pending_approval",
        requiresTeamApproval: true,
        eventId: existingBooking.id,
        eventLink: existingBooking.htmlLink ?? null,
        start: start.toISOString(),
        end: end.toISOString(),
        timeZone: TIME_ZONE,
        ...formatAppointment(start),
      });
    }

    if (!(await checkSlotAvailability({ accessToken, calendarId, start, end }))) {
      return response.status(409).json({
        ok: false,
        error: "The selected appointment time is no longer available",
        slotUnavailable: true,
      });
    }

    const visibleContact = whatsappNumber || `Zernio contact ID: ${contactIdentifier}`;
    const description = [
      "STATUS: PENDING TEAM APPROVAL",
      "",
      `Customer: ${customerName}`,
      companyName ? `Company: ${companyName}` : null,
      `Property type: ${propertyType}`,
      `Project address: ${projectAddress}`,
      `Project scope: ${projectScope}`,
      `WhatsApp/Contact: ${visibleContact}`,
      email ? `Customer email: ${email}` : null,
      "",
      "This time is being held provisionally.",
      "The appointment is not final until approved by the NEXT SOLUTIONS PARTNERS team.",
      "",
      "Created through the NEXT SOLUTIONS PARTNERS scheduling assistant.",
    ].filter(Boolean).join("\n");

    const event = {
      status: "tentative",
      summary: `PENDING APPROVAL — Commercial Site Visit — ${customerName}`,
      location: projectAddress,
      description,
      start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
      end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
      extendedProperties: {
        private: {
          bookingId: bookingKey,
          bookingKey,
          source: "nsp_zernio_assistant",
          bookingStatus: "pending_approval",
          contactIdentifier,
          conversationId,
          whatsappNumber,
          language,
          customerName,
          customerEmail: email || "",
          propertyType,
        },
      },
    };

    const createResponse = await googleCalendarFetch(
      `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
      accessToken,
      { method: "POST", body: JSON.stringify(event) },
    );
    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error("Google Calendar event creation failed", {
        status: createResponse.status,
        response: errorText.slice(0, 500),
      });
      return response.status(502).json({ ok: false, error: "The appointment request could not be created" });
    }

    const createdEvent = await createResponse.json();
    return response.status(201).json({
      ok: true,
      alreadyBooked: false,
      bookingStatus: "pending_approval",
      requiresTeamApproval: true,
      eventId: createdEvent.id,
      eventLink: createdEvent.htmlLink ?? null,
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: TIME_ZONE,
      customerName,
      projectAddress,
      ...formatAppointment(start),
    });
  } catch (error) {
    console.error("Unexpected calendar booking error", {
      message: error instanceof Error ? error.message : "Unknown calendar booking error",
    });
    return response.status(502).json({ ok: false, error: "The appointment request could not be created" });
  }
}
