import {
  createSign,
  timingSafeEqual,
} from "node:crypto";

const GOOGLE_TOKEN_URL =
  "https://oauth2.googleapis.com/token";

const GOOGLE_CALENDAR_API =
  "https://www.googleapis.com/calendar/v3";

const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar";

const TIME_ZONE = "America/Chicago";
const APPOINTMENT_MINUTES = 60;
const BUFFER_MINUTES = 60;
const MINIMUM_NOTICE_HOURS = 24;
const MAXIMUM_DAYS_AHEAD = 30;
const MAXIMUM_OPTIONS = 3;

const START_HOURS = [9, 11, 13, 15];

export const config = {
  maxDuration: 30,
};

function secretsMatch(receivedSecret, expectedSecret) {
  if (!receivedSecret || !expectedSecret) {
    return false;
  }

  const received = Buffer.from(receivedSecret);
  const expected = Buffer.from(expectedSecret);

  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function loadServiceAccount() {
  const encodedCredentials =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;

  if (!encodedCredentials) {
    throw new Error(
      "Google service account credentials are missing",
    );
  }

  const decodedCredentials = Buffer.from(
    encodedCredentials,
    "base64",
  ).toString("utf8");

  const credentials =
    JSON.parse(decodedCredentials);

  if (
    !credentials?.client_email ||
    !credentials?.private_key
  ) {
    throw new Error(
      "Google service account credentials are invalid",
    );
  }

  return credentials;
}

async function getGoogleAccessToken() {
  const credentials = loadServiceAccount();
  const issuedAt = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: credentials.client_email,
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };

  const unsignedToken =
    `${encodeBase64Url(JSON.stringify(header))}.` +
    `${encodeBase64Url(JSON.stringify(payload))}`;

  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer.sign(
    credentials.private_key,
  );

  const assertion =
    `${unsignedToken}.` +
    `${encodeBase64Url(signature)}`;

  const tokenResponse = await fetch(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
  );

  const tokenData = await tokenResponse.json();

  if (
    !tokenResponse.ok ||
    !tokenData?.access_token
  ) {
    throw new Error(
      tokenData?.error_description ??
        "Google authentication failed",
    );
  }

  return tokenData.access_token;
}

function getTimeZoneOffsetMilliseconds(
  date,
  timeZone,
) {
  const formatter = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    },
  );

  const parts = formatter.formatToParts(date);
  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  const representedAsUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second,
  );

  return representedAsUtc - date.getTime();
}

function localDateTimeToUtc(
  dateString,
  hour,
  minute = 0,
) {
  const [year, month, day] =
    dateString.split("-").map(Number);

  const localAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    0,
  );

  let guess = new Date(localAsUtc);

  let offset =
    getTimeZoneOffsetMilliseconds(
      guess,
      TIME_ZONE,
    );

  guess = new Date(localAsUtc - offset);

  const correctedOffset =
    getTimeZoneOffsetMilliseconds(
      guess,
      TIME_ZONE,
    );

  if (correctedOffset !== offset) {
    guess = new Date(
      localAsUtc - correctedOffset,
    );
  }

  return guess;
}

function dateToString(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const [year, month, day] =
    dateString.split("-").map(Number);

  const date = new Date(
    Date.UTC(year, month - 1, day + days),
  );

  return dateToString(date);
}

function getDayOfWeek(dateString) {
  const [year, month, day] =
    dateString.split("-").map(Number);

  return new Date(
    Date.UTC(year, month - 1, day),
  ).getUTCDay();
}

function isWeekday(dateString) {
  const dayOfWeek =
    getDayOfWeek(dateString);

  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

function isValidDateString(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function normalizePeriod(value) {
  const period =
    String(value ?? "").toLowerCase();

  if (
    ["morning", "mañana", "am"].includes(period)
  ) {
    return "morning";
  }

  if (
    [
      "afternoon",
      "tarde",
      "pm",
    ].includes(period)
  ) {
    return "afternoon";
  }

  return "any";
}

function hourMatchesPeriod(hour, period) {
  if (period === "morning") {
    return hour < 12;
  }

  if (period === "afternoon") {
    return hour >= 12;
  }

  return true;
}

function intervalsOverlap(
  firstStart,
  firstEnd,
  secondStart,
  secondEnd,
) {
  return (
    firstStart < secondEnd &&
    firstEnd > secondStart
  );
}

function formatSlot(startDate) {
  const dateLabel =
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(startDate);

  const timeLabel =
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      hour: "numeric",
      minute: "2-digit",
    }).format(startDate);

  return {
    dateLabel,
    timeLabel,
    display:
      `${dateLabel} at ${timeLabel} Central Time`,
  };
}

export default async function handler(
  request,
  response,
) {
  response.setHeader("Cache-Control", "no-store");

  if (
    request.method !== "POST" &&
    request.method !== "GET"
  ) {
    response.setHeader("Allow", "GET, POST");

    return response.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const receivedSecret =
    request.headers["x-webhook-secret"] ??
    request.body?.webhookSecret ??
    request.query?.secret;

  if (
    !secretsMatch(
      receivedSecret,
      process.env.INTERNAL_WEBHOOK_SECRET,
    )
  ) {
    return response.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  if (
    !process.env.GOOGLE_CALENDAR_ID ||
    !process.env
      .GOOGLE_SERVICE_ACCOUNT_JSON_BASE64
  ) {
    return response.status(500).json({
      ok: false,
      error: "Calendar configuration is missing",
    });
  }

  const requestedDate =
    request.body?.preferredDate ??
    request.body?.booking?.preferredDate ??
    request.body?.variables
      ?.booking_preferred_date ??
    request.query?.date ??
    null;

  const requestedPeriod =
    request.body?.preferredPeriod ??
    request.body?.booking?.preferredPeriod ??
    request.body?.variables
      ?.booking_preferred_period ??
    request.query?.period ??
    "any";

  const period =
    normalizePeriod(requestedPeriod);

  const minimumStart = new Date(
    Date.now() +
      MINIMUM_NOTICE_HOURS * 60 * 60 * 1000,
  );

  const tomorrow = addDays(
    dateToString(new Date()),
    1,
  );

  let searchStartDate =
    isValidDateString(requestedDate)
      ? requestedDate
      : tomorrow;

  const requestedStartUtc =
    localDateTimeToUtc(
      searchStartDate,
      0,
      0,
    );

  if (requestedStartUtc < minimumStart) {
    searchStartDate = tomorrow;
  }

  const searchEndDate = addDays(
    searchStartDate,
    MAXIMUM_DAYS_AHEAD,
  );

  try {
    const accessToken =
      await getGoogleAccessToken();

    const freeBusyResponse = await fetch(
      `${GOOGLE_CALENDAR_API}/freeBusy`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          timeMin:
            minimumStart.toISOString(),
          timeMax:
            localDateTimeToUtc(
              searchEndDate,
              17,
              0,
            ).toISOString(),
          timeZone: TIME_ZONE,
          items: [
            {
              id:
                process.env.GOOGLE_CALENDAR_ID,
            },
          ],
        }),
      },
    );

    const freeBusyData =
      await freeBusyResponse.json();

    if (!freeBusyResponse.ok) {
      return response.status(502).json({
        ok: false,
        error:
          freeBusyData?.error?.message ??
          "Calendar availability lookup failed",
      });
    }

    const busyIntervals =
      freeBusyData?.calendars?.[
        process.env.GOOGLE_CALENDAR_ID
      ]?.busy ?? [];

    const options = [];

    for (
      let dayOffset = 0;
      dayOffset <= MAXIMUM_DAYS_AHEAD;
      dayOffset += 1
    ) {
      if (
        options.length >= MAXIMUM_OPTIONS
      ) {
        break;
      }

      const dateString = addDays(
        searchStartDate,
        dayOffset,
      );

      if (!isWeekday(dateString)) {
        continue;
      }

      for (const hour of START_HOURS) {
        if (
          options.length >= MAXIMUM_OPTIONS
        ) {
          break;
        }

        if (
          !hourMatchesPeriod(hour, period)
        ) {
          continue;
        }

        const start =
          localDateTimeToUtc(
            dateString,
            hour,
            0,
          );

        const end = new Date(
          start.getTime() +
            APPOINTMENT_MINUTES *
              60 *
              1000,
        );

        if (start < minimumStart) {
          continue;
        }

        const protectedStart = new Date(
          start.getTime() -
            BUFFER_MINUTES * 60 * 1000,
        );

        const protectedEnd = new Date(
          end.getTime() +
            BUFFER_MINUTES * 60 * 1000,
        );

        const conflicts =
          busyIntervals.some((busy) =>
            intervalsOverlap(
              protectedStart,
              protectedEnd,
              new Date(busy.start),
              new Date(busy.end),
            ),
          );

        if (conflicts) {
          continue;
        }

        const formatted =
          formatSlot(start);

        options.push({
          start: start.toISOString(),
          end: end.toISOString(),
          localDate: dateString,
          localHour: hour,
          dateLabel:
            formatted.dateLabel,
          timeLabel:
            formatted.timeLabel,
          display: formatted.display,
        });
      }
    }

    return response.status(200).json({
      ok: true,
      timeZone: TIME_ZONE,
      appointmentMinutes:
        APPOINTMENT_MINUTES,
      bufferMinutes: BUFFER_MINUTES,
      options,
    });
  } catch (error) {
    console.error(
      "Calendar availability error",
      {
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
    );

    return response.status(500).json({
      ok: false,
      error:
        "Calendar availability lookup failed",
    });
  }
}
