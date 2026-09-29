import { ReminderMedia } from '../interfaces/reminder.interface';

// Resolve wall-clock times using the runtime's IANA timezone database.
export function localTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function resolveLocal(local: string, timezone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local))
    throw new Error('local_datetime must be YYYY-MM-DDTHH:mm:ss');
  const wall = Date.parse(local + 'Z');
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 19) !== local)
    throw new Error('Invalid calendar date/time');
  const offsets = new Set<number>();
  // Sample both sides of timezone transitions; choose the earlier instant for repeated times.
  for (const hours of [-48, -24, 0, 24, 48]) {
    const sample = new Date(wall + hours * 3600000);
    offsets.add(Date.parse(localTime(sample, timezone) + 'Z') - sample.getTime());
  }
  const matches = [...offsets]
    .map((offset) => new Date(wall - offset))
    .filter((date) => localTime(date, timezone) === local)
    .sort((a, b) => +a - +b);
  if (!matches.length) throw new Error('This local time does not exist due to a timezone transition');
  return matches[0];
}

export function nextSend(local: string, timezone: string, frequency: string, after = new Date()): Date {
  if (!['once', 'yearly'].includes(frequency)) throw new Error('frequency must be once or yearly');
  const first = resolveLocal(local, timezone);
  if (first > after) return first;
  if (frequency === 'once') throw new Error('One-time reminders must be in the future');
  const startYear = Number(localTime(after, timezone).slice(0, 4));
  for (let year = startYear; year <= startYear + 8; year++) {
    try {
      const candidate = resolveLocal(`${year}${local.slice(4)}`, timezone);
      if (candidate > after) return candidate;
    } catch {
      /* Feb 29 and nonexistent DST times skip that year. */
    }
  }
  throw new Error('No yearly occurrence found');
}

export function templatePreview(template: any, variables: any = {}, mediaUploads: ReminderMedia[] = []) {
  if (!Array.isArray(mediaUploads)) throw new Error('media_uploads must be an array');
  let usedMedia = false;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables))
    throw new Error('variables must be an object');
  const components: any[] = [];
  const preview: any[] = [];
  const required: string[] = [];
  for (const part of template.components || []) {

    const type = String(part.type).toLowerCase();

    if (type === 'buttons') {
      if (
        part.buttons?.some((b: any) => b.type === 'QUICK_REPLY' || /{{/.test(b.url || '') || b.type === 'COPY_CODE')
      ) {
        throw new Error('Templates with parameterized or quick-reply buttons are not supported for reminders');
      }
      preview.push(part);
      continue;
    }

    if (type === 'header' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(part.format)) {
      const mediaType = part.format.toLowerCase();
      const media = mediaUploads.find(item => item && item.type === mediaType);
      
      if (!media) throw new Error(`Provide media_uploads for the ${mediaType} header; reminders support text headers and media headers with explicit media`);
      
      const value: Record<string, string> = {};
      
      if (media.media_id) {
        if (typeof media.media_id !== 'string' || !media.media_id.trim()) throw new Error('Invalid media_id');
        value.id = media.media_id;
      } else {
        const link = media.link || media.url;
        if (typeof link !== 'string') throw new Error('Header media requires media_id or an HTTPS url');
        let url: URL;
        try { url = new URL(link); } catch { throw new Error('Header media requires a plain HTTPS URL'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Header media requires a plain HTTPS URL');
        value.link = link;
      }

      if (media.filename !== undefined) {
        if (mediaType !== 'document' || typeof media.filename !== 'string' || !media.filename.trim()) throw new Error('filename is only supported for document headers');
        value.filename = media.filename;
      }

      usedMedia = true;
      components.push({ type: 'header', parameters: [{ type: mediaType, [mediaType]: value }] });
      preview.push({ ...part, media: { type: mediaType, ...value } });
      continue;
    }
    if (!['header', 'body', 'footer'].includes(type) || (type === 'header' && part.format && part.format !== 'TEXT')) {
      throw new Error('Reminders currently support text headers, bodies, footers and static buttons');
    }

    const keys = [...new Set<string>(Array.from(String(part.text || '').matchAll(/{{\s*([\w]+)\s*}}/g), (m) => m[1]))];
    
    const parameters = keys.map((key) => {
      const path = `${type}.${key}`;
      required.push(path);
      const value = variables[path];
      if (typeof value !== 'string' || !value.trim() || value.length > 32768)
        throw new Error(`Provide a non-empty string for variables["${path}"]`);
      return { type: 'text', text: value, ...(/^\d+$/.test(key) ? {} : { parameter_name: key }) };
    });

    if (parameters.length) components.push({ type, parameters });
    preview.push({
      ...part,
      text: String(part.text || '').replace(
        /{{\s*([\w]+)\s*}}/g,
        (_: string, key: string) => variables[`${type}.${key}`],
      ),
    });
  }
  if (mediaUploads.length > (usedMedia ? 1 : 0)) throw new Error('Provide exactly one matching media upload for a media header');
  if (Object.keys(variables).some((key) => !required.includes(key))) throw new Error('Unknown template variable');
  return {
    template: { name: template.name, language: template.language, components },
    preview,
    required_variables: required,
  };
}

/** Campaign mapping semantics: built-in contact fields, custom attributes, then literal text. */
export function resolveReminderMapping(template: any, contact: any, mapping: Record<string, string>): Record<string, string> {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('parameter_mapping must be an object');
  const resolved: Record<string, string> = {};
  const usedKeys = new Set<string>();
  for (const component of template.components || []) {
    const type = String(component.type).toLowerCase();
    const placeholders = String(component.text || '').matchAll(/{{\s*([\w]+)\s*}}/g);
    for (const match of placeholders) {
      const scopedKey = `${type}.${match[1]}`;
      const mappingKey = Object.prototype.hasOwnProperty.call(mapping, scopedKey) ? scopedKey : match[1];
      const source = Object.prototype.hasOwnProperty.call(mapping, mappingKey) ? mapping[mappingKey] : undefined;
      if (typeof source !== 'string' || !source.trim()) throw new Error(`Provide parameter_mapping["${mappingKey}"]`);
      usedKeys.add(mappingKey);
      let value: unknown = source;
      if (source === 'fullName') value = contact.name || '';
      else if (source === 'phone_number') value = contact.phone_number || '';
      else if (source === 'email') value = contact.email || '';
      else if (contact.attributes && Object.prototype.hasOwnProperty.call(contact.attributes, source)) value = contact.attributes[source];
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new Error(`Contact value for "${source}" must be text, a number or a boolean`);
      resolved[scopedKey] = String(value);
    }
  }
  if (Object.keys(mapping).some(key => !usedKeys.has(key))) throw new Error('Unknown parameter_mapping key');
  return resolved;
}
