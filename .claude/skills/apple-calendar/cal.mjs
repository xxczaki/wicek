#!/usr/bin/env node
// Apple Calendar (iCloud CalDAV) skill for wicek.
// Reads APPLE_ID + APPLE_APP_PASSWORD from the environment.
// Usage: node cal.mjs <command> [--flags]   — all output is JSON on stdout.
import { randomUUID } from 'node:crypto';
import { createDAVClient } from 'tsdav';
import * as ICALns from 'ical.js';

const ICAL = ICALns.default ?? ICALns;

const USERNAME = process.env.APPLE_ID;
const PASSWORD = process.env.APPLE_APP_PASSWORD;

function fail(msg) {
  console.error(JSON.stringify({ error: String(msg) }));
  process.exit(1);
}
function out(data) {
  console.log(JSON.stringify(data, null, 2));
}
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function displayName(cal) {
  const dn = cal.displayName;
  if (typeof dn === 'string' && dn.trim()) return dn;
  if (dn && typeof dn === 'object') return dn._cdata ?? dn._text ?? cal.url;
  return cal.url;
}

function supportsEvents(cal) {
  const c = cal.components ?? [];
  return Array.isArray(c) ? c.includes('VEVENT') : true;
}

function pickCalendar(calendars, name) {
  if (!name || name === true) {
    return calendars.find(supportsEvents) ?? calendars[0];
  }
  const match = calendars.find(
    (c) => displayName(c).toLowerCase() === String(name).toLowerCase(),
  );
  if (!match) {
    fail(`calendar not found: ${name}. Available: ${calendars.map(displayName).join(', ')}`);
  }
  return match;
}

// Format an ISO string for iCalendar. Date-only (YYYY-MM-DD) -> all-day.
function icalDate(iso) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { prop: ';VALUE=DATE', val: iso.replace(/-/g, '') };
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) fail(`invalid date: ${iso}`);
  return { prop: '', val: `${d.toISOString().replace(/[-:]/g, '').split('.')[0]}Z` };
}

function escapeText(s = '') {
  return String(s).replace(/([\\,;])/g, '\\$1').replace(/\n/g, '\\n');
}

function buildVEvent({ uid, summary, start, end, location, description }) {
  const s = icalDate(start);
  const e = icalDate(end);
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//wicek//apple-calendar//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART${s.prop}:${s.val}`,
    `DTEND${e.prop}:${e.val}`,
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// Expand a calendar object's VEVENTs into plain JSON, expanding recurrence
// within [from,to] when present.
function eventsFromICS(data, calName, url, etag, from, to) {
  const results = [];
  let comp;
  try {
    comp = new ICAL.Component(ICAL.parse(data));
  } catch {
    return results;
  }
  const rangeStart = from ? ICAL.Time.fromJSDate(new Date(from), false) : null;
  const rangeEnd = to ? ICAL.Time.fromJSDate(new Date(to), false) : null;
  for (const ve of comp.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(ve);
    const base = {
      uid: event.uid,
      summary: event.summary,
      location: event.location || undefined,
      description: event.description || undefined,
      calendar: calName,
      url,
      etag,
    };
    if (event.isRecurring() && rangeStart && rangeEnd) {
      const it = event.iterator();
      let next;
      let guard = 0;
      while ((next = it.next()) && guard++ < 1000) {
        if (next.compare(rangeEnd) > 0) break;
        const occ = event.getOccurrenceDetails(next);
        if (occ.endDate.compare(rangeStart) < 0) continue;
        results.push({
          ...base,
          start: occ.startDate.toString(),
          end: occ.endDate.toString(),
          recurring: true,
        });
      }
    } else {
      results.push({
        ...base,
        start: event.startDate?.toString(),
        end: event.endDate?.toString(),
      });
    }
  }
  return results;
}

function applyUpdates(data, a) {
  const comp = new ICAL.Component(ICAL.parse(data));
  const ve = comp.getFirstSubcomponent('vevent');
  if (!ve) fail('no VEVENT found in object to update');
  if (a.summary && a.summary !== true) ve.updatePropertyWithValue('summary', a.summary);
  if (a.location && a.location !== true) ve.updatePropertyWithValue('location', a.location);
  if (a.description && a.description !== true) ve.updatePropertyWithValue('description', a.description);
  if (a.start && a.start !== true) ve.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(a.start), true));
  if (a.end && a.end !== true) ve.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(a.end), true));
  return comp.toString();
}

async function main() {
  if (!USERNAME || !PASSWORD) fail('APPLE_ID and APPLE_APP_PASSWORD must be set');
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);

  const client = await createDAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: USERNAME, password: PASSWORD },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  const calendars = await client.fetchCalendars();

  switch (cmd) {
    case 'list-calendars':
      return out(calendars.map((c) => ({ name: displayName(c), url: c.url, components: c.components })));

    case 'list-events': {
      if (!a.from || !a.to) fail('list-events requires --from and --to (ISO 8601)');
      const cals = a.calendar ? [pickCalendar(calendars, a.calendar)] : calendars.filter(supportsEvents);
      const all = [];
      for (const cal of cals) {
        const objs = await client.fetchCalendarObjects({
          calendar: cal,
          timeRange: { start: a.from, end: a.to },
        });
        for (const o of objs) all.push(...eventsFromICS(o.data, displayName(cal), o.url, o.etag, a.from, a.to));
      }
      all.sort((x, y) => String(x.start).localeCompare(String(y.start)));
      return out(all);
    }

    case 'create-event': {
      if (!a.summary || !a.start || !a.end) {
        fail('create-event requires --summary --start --end (optional: --calendar --location --description)');
      }
      const cal = pickCalendar(calendars, a.calendar);
      const uid = randomUUID();
      const iCalString = buildVEvent({
        uid,
        summary: a.summary,
        start: a.start,
        end: a.end,
        location: a.location !== true ? a.location : undefined,
        description: a.description !== true ? a.description : undefined,
      });
      const res = await client.createCalendarObject({ calendar: cal, filename: `${uid}.ics`, iCalString });
      if (!res.ok) fail(`create failed: ${res.status} ${await safeText(res)}`);
      return out({ created: true, uid, calendar: displayName(cal), url: new URL(`${uid}.ics`, cal.url).toString() });
    }

    case 'update-event': {
      if (!a.url || a.url === true) fail('update-event requires --url (from list-events) and fields to change');
      const cal = calendars.find((c) => String(a.url).startsWith(c.url)) ?? pickCalendar(calendars, a.calendar);
      const [obj] = await client.fetchCalendarObjects({ calendar: cal, calendarObjectUrls: [a.url] });
      if (!obj) fail(`event not found: ${a.url}`);
      const data = applyUpdates(obj.data, a);
      const res = await client.updateCalendarObject({
        calendarObject: { url: obj.url, etag: a.etag !== true ? a.etag : obj.etag, data },
      });
      if (!res.ok) fail(`update failed: ${res.status} ${await safeText(res)}`);
      return out({ updated: true, url: obj.url });
    }

    case 'delete-event': {
      if (!a.url || a.url === true) fail('delete-event requires --url (from list-events)');
      const res = await client.deleteCalendarObject({
        calendarObject: { url: a.url, etag: a.etag !== true ? a.etag : undefined },
      });
      if (!res.ok) fail(`delete failed: ${res.status} ${await safeText(res)}`);
      return out({ deleted: true, url: a.url });
    }

    default:
      fail(`unknown command: ${cmd ?? '(none)'}. Commands: list-calendars, list-events, create-event, update-event, delete-event`);
  }
}

main().catch((err) => fail(err?.message ?? err));
